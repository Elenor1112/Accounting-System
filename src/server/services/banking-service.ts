import 'server-only';

import { and, asc, desc, eq, inArray, isNull, lte, sql } from 'drizzle-orm';

import { db } from '@/db';
import {
  accounts,
  bankAccounts,
  bankTransactions,
  journalEntries,
  journalLines,
  payments,
  reconciliations,
} from '@/db/schema';
import { requirePermission, type TenantContext } from '@/server/auth/context';
import { PERMISSIONS } from '@/server/auth/permissions';
import { AccountingError, ConflictError, NotFoundError, ValidationError } from '@/server/errors';
import { abs, add, gt, isZero, money, round, subtract, type Money } from '@/lib/money';

import { recordAudit } from './audit-service';
import { createJournalEntry, postedEntryFilter } from './journal-service';

export type BankAccountRow = typeof bankAccounts.$inferSelect;

export async function createBankAccount(
  ctx: TenantContext,
  input: {
    name: string;
    ledgerAccountId: string;
    currencyCode?: string;
    accountKind?: 'bank' | 'cash' | 'card';
    bankName?: string | null;
    accountNumber?: string | null;
    iban?: string | null;
    branchId?: string | null;
    openingBalance?: Money;
    openingDate?: string | null;
  },
): Promise<BankAccountRow> {
  requirePermission(ctx, PERMISSIONS.banking.manage);

  const [ledgerAccount] = await db
    .select()
    .from(accounts)
    .where(and(eq(accounts.id, input.ledgerAccountId), eq(accounts.companyId, ctx.companyId)))
    .limit(1);

  if (!ledgerAccount) throw new NotFoundError('Ledger account');
  if (ledgerAccount.type !== 'asset' && ledgerAccount.subtype !== 'credit_card') {
    throw new AccountingError(
      `A bank account must map to an asset account (or a credit card liability); ` +
        `${ledgerAccount.code} is a ${ledgerAccount.type} account.`,
    );
  }

  return db.transaction(async (tx) => {
    const [created] = await tx
      .insert(bankAccounts)
      .values({
        companyId: ctx.companyId,
        branchId: input.branchId ?? null,
        name: input.name,
        accountKind: input.accountKind ?? 'bank',
        bankName: input.bankName ?? null,
        accountNumber: input.accountNumber ?? null,
        iban: input.iban ?? null,
        currencyCode: input.currencyCode ?? ctx.baseCurrencyCode,
        ledgerAccountId: input.ledgerAccountId,
        openingBalance: input.openingBalance ?? '0',
        openingDate: input.openingDate ?? null,
      })
      .returning();

    if (!created) throw new ConflictError('Failed to create bank account');

    await recordAudit(tx, ctx, {
      action: 'bank_account.created',
      entityType: 'bank_account',
      entityId: created.id,
      newValues: { name: created.name, ledgerAccountId: created.ledgerAccountId },
    });

    return created;
  });
}

/**
 * Current balance of a bank account, summed from the ledger.
 *
 * Never stored and incremented: a stored balance can drift from the entries
 * that justify it, and reconciling that drift is exactly the problem this
 * system exists to prevent (spec §15, "no fake balance manipulation").
 */
export async function getBankAccountBalance(
  ctx: TenantContext,
  bankAccountId: string,
  asOf?: string,
): Promise<{ balance: Money; asOf: string }> {
  const [account] = await db
    .select()
    .from(bankAccounts)
    .where(and(eq(bankAccounts.id, bankAccountId), eq(bankAccounts.companyId, ctx.companyId)))
    .limit(1);

  if (!account) throw new NotFoundError('Bank account');

  const conditions = [
    eq(journalLines.companyId, ctx.companyId),
    eq(journalLines.accountId, account.ledgerAccountId),
    postedEntryFilter(),
  ];
  if (asOf) conditions.push(lte(journalEntries.entryDate, asOf));

  const [row] = await db
    .select({
      debit: sql<string>`coalesce(sum(${journalLines.baseDebit}), 0)`,
      credit: sql<string>`coalesce(sum(${journalLines.baseCredit}), 0)`,
    })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalEntries.id, journalLines.entryId))
    .where(and(...conditions));

  // Cash is debit-normal: money in less money out, plus whatever the account
  // was opened with.
  const movement = subtract(row?.debit ?? '0', row?.credit ?? '0');
  return {
    balance: round(add(account.openingBalance, movement), ctx.currencyPrecision),
    asOf: asOf ?? new Date().toISOString().slice(0, 10),
  };
}

export async function listBankAccounts(ctx: TenantContext) {
  requirePermission(ctx, PERMISSIONS.banking.view);

  const rows = await db
    .select({
      id: bankAccounts.id,
      name: bankAccounts.name,
      accountKind: bankAccounts.accountKind,
      bankName: bankAccounts.bankName,
      accountNumber: bankAccounts.accountNumber,
      currencyCode: bankAccounts.currencyCode,
      ledgerAccountId: bankAccounts.ledgerAccountId,
      ledgerAccountCode: accounts.code,
      openingBalance: bankAccounts.openingBalance,
      isActive: bankAccounts.isActive,
    })
    .from(bankAccounts)
    .innerJoin(accounts, eq(accounts.id, bankAccounts.ledgerAccountId))
    .where(and(eq(bankAccounts.companyId, ctx.companyId), eq(bankAccounts.isActive, true)))
    .orderBy(asc(bankAccounts.name));

  // Balances come from the ledger, so each row needs its own aggregate.
  return Promise.all(
    rows.map(async (row) => ({
      ...row,
      balance: (await getBankAccountBalance(ctx, row.id)).balance,
    })),
  );
}

/**
 * Moves money between two of the company's own accounts (spec §15).
 *
 *   Dr destination
 *     Cr source
 *
 * A transfer is not income or expense — both sides are assets — so it must
 * never touch a revenue or expense account.
 */
export async function createTransfer(
  ctx: TenantContext,
  input: {
    fromBankAccountId: string;
    toBankAccountId: string;
    date: string;
    amount: Money;
    reference?: string | null;
    description?: string | null;
    branchId?: string | null;
  },
): Promise<{ journalEntryId: string }> {
  requirePermission(ctx, PERMISSIONS.banking.manage);

  const amount = money(input.amount);
  if (!gt(amount, '0')) {
    throw new ValidationError('Transfer amount must be greater than zero');
  }
  if (input.fromBankAccountId === input.toBankAccountId) {
    throw new ValidationError('Cannot transfer to the same account');
  }

  return db.transaction(async (tx) => {
    const both = await tx
      .select()
      .from(bankAccounts)
      .where(
        and(
          eq(bankAccounts.companyId, ctx.companyId),
          inArray(bankAccounts.id, [input.fromBankAccountId, input.toBankAccountId]),
        ),
      );

    const from = both.find((a) => a.id === input.fromBankAccountId);
    const to = both.find((a) => a.id === input.toBankAccountId);
    if (!from || !to) throw new NotFoundError('Bank account');

    if (from.currencyCode !== to.currencyCode) {
      throw new AccountingError(
        `Cannot transfer directly between ${from.currencyCode} and ${to.currencyCode} accounts. ` +
          'Record two entries with the conversion, so the exchange difference is visible.',
      );
    }

    const entry = await createJournalEntry(
      ctx,
      {
        entryDate: input.date,
        description: input.description ?? `Transfer from ${from.name} to ${to.name}`,
        reference: input.reference,
        currencyCode: from.currencyCode,
        branchId: input.branchId ?? null,
        sourceType: 'transfer',
        lines: [
          {
            accountId: to.ledgerAccountId,
            debit: amount,
            description: `Transfer in from ${from.name}`,
            branchId: input.branchId ?? null,
          },
          {
            accountId: from.ledgerAccountId,
            credit: amount,
            description: `Transfer out to ${to.name}`,
            branchId: input.branchId ?? null,
          },
        ] as never,
        post: true,
      },
      { tx },
    );

    await recordAudit(tx, ctx, {
      action: 'bank.transfer',
      entityType: 'journal_entry',
      entityId: entry.id,
      newValues: { from: from.name, to: to.name, amount },
    });

    return { journalEntryId: entry.id };
  });
}

/** Imports statement lines for later matching. */
export async function importBankTransactions(
  ctx: TenantContext,
  bankAccountId: string,
  rows: Array<{
    transactionDate: string;
    description: string;
    amount: Money;
    reference?: string | null;
  }>,
): Promise<{ imported: number }> {
  requirePermission(ctx, PERMISSIONS.banking.reconcile);

  const [account] = await db
    .select()
    .from(bankAccounts)
    .where(and(eq(bankAccounts.id, bankAccountId), eq(bankAccounts.companyId, ctx.companyId)))
    .limit(1);

  if (!account) throw new NotFoundError('Bank account');

  await db.insert(bankTransactions).values(
    rows.map((row) => ({
      companyId: ctx.companyId,
      bankAccountId,
      transactionDate: row.transactionDate,
      description: row.description,
      reference: row.reference ?? null,
      amount: money(row.amount),
    })),
  );

  return { imported: rows.length };
}

/**
 * Ledger entries against a bank account that have not been matched to a
 * statement line — the right-hand side of the reconciliation screen.
 */
export async function listUnreconciledLedgerEntries(
  ctx: TenantContext,
  bankAccountId: string,
  asOf?: string,
) {
  requirePermission(ctx, PERMISSIONS.banking.reconcile);

  const [account] = await db
    .select()
    .from(bankAccounts)
    .where(and(eq(bankAccounts.id, bankAccountId), eq(bankAccounts.companyId, ctx.companyId)))
    .limit(1);

  if (!account) throw new NotFoundError('Bank account');

  const conditions = [
    eq(journalLines.companyId, ctx.companyId),
    eq(journalLines.accountId, account.ledgerAccountId),
    postedEntryFilter(),
    // Exclude entries already claimed by a reconciled statement line. NOT
    // EXISTS rather than NOT IN: a NULL in the subquery would make NOT IN
    // return no rows at all, silently hiding every unreconciled entry.
    sql`not exists (
      select 1 from ${bankTransactions} bt
      where bt.company_id = ${ctx.companyId}
        and bt.is_reconciled = true
        and bt.matched_entry_id = ${journalEntries.id}
    )`,
  ];
  if (asOf) conditions.push(lte(journalEntries.entryDate, asOf));

  return db
    .select({
      entryId: journalEntries.id,
      entryNumber: journalEntries.entryNumber,
      entryDate: journalEntries.entryDate,
      description: journalEntries.description,
      debit: journalLines.baseDebit,
      credit: journalLines.baseCredit,
    })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalEntries.id, journalLines.entryId))
    .where(and(...conditions))
    .orderBy(asc(journalEntries.entryDate));
}

export async function listUnreconciledStatementLines(
  ctx: TenantContext,
  bankAccountId: string,
) {
  requirePermission(ctx, PERMISSIONS.banking.reconcile);

  return db
    .select()
    .from(bankTransactions)
    .where(
      and(
        eq(bankTransactions.companyId, ctx.companyId),
        eq(bankTransactions.bankAccountId, bankAccountId),
        eq(bankTransactions.isReconciled, false),
      ),
    )
    .orderBy(asc(bankTransactions.transactionDate));
}

/**
 * Matches a statement line to a ledger entry.
 *
 * Only the statement line is updated. The journal entry and any payment behind
 * it are left exactly as posted, per spec §16 — reconciliation is a statement
 * about agreement between two records, not a change to either.
 */
export async function matchBankTransaction(
  ctx: TenantContext,
  params: { bankTransactionId: string; journalEntryId?: string; paymentId?: string },
): Promise<void> {
  requirePermission(ctx, PERMISSIONS.banking.reconcile);

  if (!params.journalEntryId && !params.paymentId) {
    throw new ValidationError('Provide a journal entry or a payment to match against');
  }

  await db.transaction(async (tx) => {
    const [line] = await tx
      .select()
      .from(bankTransactions)
      .where(
        and(
          eq(bankTransactions.id, params.bankTransactionId),
          eq(bankTransactions.companyId, ctx.companyId),
        ),
      )
      .limit(1);

    if (!line) throw new NotFoundError('Bank transaction');
    if (line.isReconciled) throw new ConflictError('This line is already reconciled');

    let entryId = params.journalEntryId ?? null;

    if (params.paymentId) {
      const [payment] = await tx
        .select()
        .from(payments)
        .where(and(eq(payments.id, params.paymentId), eq(payments.companyId, ctx.companyId)))
        .limit(1);

      if (!payment) throw new NotFoundError('Payment');
      entryId = payment.journalEntryId;
    }

    await tx
      .update(bankTransactions)
      .set({
        isReconciled: true,
        matchedEntryId: entryId,
        matchedPaymentId: params.paymentId ?? null,
        updatedAt: sql`now()`,
      })
      .where(eq(bankTransactions.id, params.bankTransactionId));

    await recordAudit(tx, ctx, {
      action: 'bank.matched',
      entityType: 'bank_transaction',
      entityId: params.bankTransactionId,
      newValues: { matchedEntryId: entryId, matchedPaymentId: params.paymentId ?? null },
    });
  });
}

export async function unmatchBankTransaction(
  ctx: TenantContext,
  bankTransactionId: string,
): Promise<void> {
  requirePermission(ctx, PERMISSIONS.banking.reconcile);

  await db
    .update(bankTransactions)
    .set({
      isReconciled: false,
      matchedEntryId: null,
      matchedPaymentId: null,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(bankTransactions.id, bankTransactionId),
        eq(bankTransactions.companyId, ctx.companyId),
      ),
    );
}

/**
 * Closes a reconciliation, recording the statement balance against the ledger
 * balance. A non-zero difference is stored rather than hidden, so an unexplained
 * gap stays visible instead of being silently absorbed.
 */
export async function completeReconciliation(
  ctx: TenantContext,
  params: { bankAccountId: string; statementDate: string; statementBalance: Money },
): Promise<{ id: string; difference: Money }> {
  requirePermission(ctx, PERMISSIONS.banking.reconcile);

  const ledger = await getBankAccountBalance(
    ctx,
    params.bankAccountId,
    params.statementDate,
  );
  const difference = subtract(params.statementBalance, ledger.balance);

  return db.transaction(async (tx) => {
    const [created] = await tx
      .insert(reconciliations)
      .values({
        companyId: ctx.companyId,
        bankAccountId: params.bankAccountId,
        statementDate: params.statementDate,
        statementBalance: money(params.statementBalance),
        ledgerBalance: ledger.balance,
        difference,
        status: 'completed',
        completedAt: sql`now()`,
        completedById: ctx.userId,
      })
      .returning();

    if (!created) throw new ConflictError('Failed to record reconciliation');

    await recordAudit(tx, ctx, {
      action: 'bank.reconciled',
      entityType: 'reconciliation',
      entityId: created.id,
      newValues: {
        statementBalance: params.statementBalance,
        ledgerBalance: ledger.balance,
        difference,
      },
    });

    return { id: created.id, difference };
  });
}

export async function listReconciliations(ctx: TenantContext, bankAccountId: string) {
  requirePermission(ctx, PERMISSIONS.banking.view);

  return db
    .select()
    .from(reconciliations)
    .where(
      and(
        eq(reconciliations.companyId, ctx.companyId),
        eq(reconciliations.bankAccountId, bankAccountId),
      ),
    )
    .orderBy(desc(reconciliations.statementDate));
}
