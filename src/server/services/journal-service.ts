import 'server-only';

import { and, eq, inArray, lte, gte, sql } from 'drizzle-orm';

import { db, type Executor, type Tx } from '@/db';
import { accounts, fiscalPeriods, journalEntries, journalLines } from '@/db/schema';
import {
  requireBranchAccess,
  requirePermission,
  type TenantContext,
} from '@/server/auth/context';
import { PERMISSIONS } from '@/server/auth/permissions';
import { AccountingError, ConflictError, NotFoundError } from '@/server/errors';
import {
  add,
  convertToBase,
  equals,
  isZero,
  money,
  round,
  subtract as subtractMoney,
  sum,
  ZERO,
  type Money,
} from '@/lib/money';

import { recordAudit } from './audit-service';
import { allocateDocumentNumber } from './numbering-service';

/**
 * Statuses whose lines have really hit the ledger.
 *
 * `reversed` belongs here alongside `posted`: reversing an entry does not undo
 * it, it adds an equal and opposite entry. Both remain in the ledger, and both
 * must be counted — dropping the original would leave only the reversal's side
 * and misstate every balance by the full amount. Excluding it is only correct
 * for `draft`, `pending_approval`, `approved` and `void`, which never moved
 * value.
 */
export const LEDGER_STATUSES = ['posted', 'reversed'] as const;

/** Restricts a query to entries that have actually affected the ledger. */
export const postedEntryFilter = () => inArray(journalEntries.status, [...LEDGER_STATUSES]);

export interface JournalLineInput {
  accountId: string;
  debit?: Money;
  credit?: Money;
  description?: string | null;
  branchId?: string | null;
  customerId?: string | null;
  vendorId?: string | null;
  projectId?: string | null;
}

export interface CreateJournalEntryInput {
  entryDate: string;
  description?: string | null;
  reference?: string | null;
  currencyCode?: string;
  exchangeRate?: string;
  branchId?: string | null;
  sourceType?: string;
  sourceId?: string | null;
  lines: JournalLineInput[];
  /** Post immediately rather than leaving a draft. Requires the post permission. */
  post?: boolean;
  entryNumber?: string;
}

/**
 * Validates a set of lines against the double-entry rules (spec §8).
 *
 * Runs before any database work so a bad entry fails with a precise message
 * rather than a constraint violation. The database checks the same invariants
 * independently — this layer exists for the error message, not for safety.
 */
export function validateLines(
  lines: JournalLineInput[],
  exchangeRate: string,
): {
  normalized: Array<Required<Pick<JournalLineInput, 'accountId'>> & {
    debit: Money;
    credit: Money;
    baseDebit: Money;
    baseCredit: Money;
    description: string | null;
    branchId: string | null;
    customerId: string | null;
    vendorId: string | null;
    projectId: string | null;
  }>;
  totalDebit: Money;
  totalCredit: Money;
} {
  if (lines.length < 2) {
    throw new AccountingError('A journal entry must have at least two lines');
  }

  const normalized = lines.map((line, index) => {
    const debit = money(line.debit ?? ZERO);
    const credit = money(line.credit ?? ZERO);

    if (debit.startsWith('-') || credit.startsWith('-')) {
      throw new AccountingError(
        `Line ${index + 1}: debit and credit must not be negative. ` +
          'To record the opposite effect, put the amount on the other side.',
      );
    }
    const debitZero = isZero(debit);
    const creditZero = isZero(credit);
    if (!debitZero && !creditZero) {
      throw new AccountingError(
        `Line ${index + 1}: a line cannot carry both a debit and a credit`,
      );
    }
    if (debitZero && creditZero) {
      throw new AccountingError(`Line ${index + 1}: a line must carry a debit or a credit`);
    }

    return {
      accountId: line.accountId,
      debit,
      credit,
      // Base-currency figures are what the ledger sums; the originals are kept
      // alongside so the transaction currency is never lost (spec §18).
      baseDebit: debitZero ? ZERO : convertToBase(debit, exchangeRate),
      baseCredit: creditZero ? ZERO : convertToBase(credit, exchangeRate),
      description: line.description ?? null,
      branchId: line.branchId ?? null,
      customerId: line.customerId ?? null,
      vendorId: line.vendorId ?? null,
      projectId: line.projectId ?? null,
    };
  });

  const totalDebit = sum(normalized.map((l) => l.baseDebit));
  const totalCredit = sum(normalized.map((l) => l.baseCredit));

  if (!equals(totalDebit, totalCredit)) {
    throw new AccountingError(
      `Entry does not balance: debits ${totalDebit} vs credits ${totalCredit} ` +
        `(difference ${add(totalDebit, `-${totalCredit}`)})`,
      { totalDebit, totalCredit },
    );
  }

  return { normalized, totalDebit, totalCredit };
}

/**
 * Finds the fiscal period containing `date` and refuses closed or locked ones.
 * This is what stops a user backdating an entry into a reported month.
 */
async function resolvePostingPeriod(
  tx: Executor,
  companyId: string,
  date: string,
): Promise<string | null> {
  const [period] = await tx
    .select()
    .from(fiscalPeriods)
    .where(
      and(
        eq(fiscalPeriods.companyId, companyId),
        lte(fiscalPeriods.startDate, date),
        gte(fiscalPeriods.endDate, date),
      ),
    )
    .limit(1);

  // No period defined for the date is allowed: a company that has not set up a
  // fiscal calendar can still post. Once periods exist, their status rules.
  if (!period) return null;

  if (period.status !== 'open') {
    throw new AccountingError(
      `Cannot post to ${date}: period "${period.name}" is ${period.status}. ` +
        'Reopen the period or post to an open one.',
    );
  }
  return period.id;
}

/** Rejects accounts that must not receive postings, with the reason. */
async function assertAccountsPostable(
  tx: Executor,
  companyId: string,
  accountIds: string[],
  options: { allowControlAccounts: boolean },
): Promise<void> {
  const unique = [...new Set(accountIds)];
  const rows = await tx
    .select({
      id: accounts.id,
      code: accounts.code,
      name: accounts.name,
      isArchived: accounts.isArchived,
      isPostable: accounts.isPostable,
      isControlAccount: accounts.isControlAccount,
    })
    .from(accounts)
    .where(and(eq(accounts.companyId, companyId), inArray(accounts.id, unique)));

  const found = new Map(rows.map((r) => [r.id, r]));

  for (const id of unique) {
    const account = found.get(id);
    // Also catches an account belonging to another company: the companyId
    // filter above means it simply is not found here.
    if (!account) throw new NotFoundError(`Account ${id}`);

    if (account.isArchived) {
      throw new AccountingError(
        `Account ${account.code} ${account.name} is archived and cannot receive new transactions`,
      );
    }
    if (!account.isPostable) {
      throw new AccountingError(
        `Account ${account.code} ${account.name} is a summary account; post to one of its children`,
      );
    }
    if (account.isControlAccount && !options.allowControlAccounts) {
      throw new AccountingError(
        `Account ${account.code} ${account.name} is a control account maintained by the ` +
          'invoices/bills subledger and cannot be posted to by hand',
      );
    }
  }
}

/**
 * Creates a journal entry, optionally posting it in the same transaction.
 *
 * `sourceType`/`sourceId` tie the entry back to the document that caused it;
 * `allowControlAccounts` is set by the subledger services (invoices, payments)
 * which legitimately move AR/AP, and never by a user's manual entry.
 */
export async function createJournalEntry(
  ctx: TenantContext,
  input: CreateJournalEntryInput,
  options: { tx?: Tx; allowControlAccounts?: boolean } = {},
): Promise<{ id: string; entryNumber: string; status: string }> {
  requirePermission(ctx, PERMISSIONS.transactions.create);
  if (input.post) requirePermission(ctx, PERMISSIONS.transactions.post);
  requireBranchAccess(ctx, input.branchId ?? null);

  const currencyCode = input.currencyCode ?? ctx.baseCurrencyCode;
  const exchangeRate = input.exchangeRate ?? '1';

  if (currencyCode === ctx.baseCurrencyCode && exchangeRate !== '1') {
    throw new AccountingError(
      'Exchange rate must be 1 when the entry is already in the base currency',
    );
  }

  const { normalized, totalDebit, totalCredit } = validateLines(input.lines, exchangeRate);

  const run = async (tx: Tx) => {
    await assertAccountsPostable(
      tx,
      ctx.companyId,
      normalized.map((l) => l.accountId),
      { allowControlAccounts: options.allowControlAccounts ?? false },
    );

    for (const line of normalized) {
      requireBranchAccess(ctx, line.branchId);
    }

    const periodId = input.post
      ? await resolvePostingPeriod(tx, ctx.companyId, input.entryDate)
      : null;

    const entryNumber =
      input.entryNumber ??
      (await allocateDocumentNumber(tx, {
        companyId: ctx.companyId,
        documentType: 'journal',
        date: new Date(input.entryDate),
      }));

    const [entry] = await tx
      .insert(journalEntries)
      .values({
        companyId: ctx.companyId,
        branchId: input.branchId ?? null,
        entryNumber,
        entryDate: input.entryDate,
        periodId,
        description: input.description ?? null,
        reference: input.reference ?? null,
        sourceType: input.sourceType ?? 'manual',
        sourceId: input.sourceId ?? null,
        currencyCode,
        exchangeRate,
        status: input.post ? 'posted' : 'draft',
        totalDebit,
        totalCredit,
        createdById: ctx.userId,
        postedById: input.post ? ctx.userId : null,
        postedAt: input.post ? sql`now()` : null,
      })
      .returning({ id: journalEntries.id, entryNumber: journalEntries.entryNumber });

    if (!entry) throw new ConflictError('Failed to create journal entry');

    await tx.insert(journalLines).values(
      normalized.map((line, index) => ({
        companyId: ctx.companyId,
        entryId: entry.id,
        accountId: line.accountId,
        lineNumber: index + 1,
        debit: line.debit,
        credit: line.credit,
        currencyCode,
        exchangeRate,
        baseDebit: line.baseDebit,
        baseCredit: line.baseCredit,
        description: line.description,
        branchId: line.branchId ?? input.branchId ?? null,
        customerId: line.customerId,
        vendorId: line.vendorId,
        projectId: line.projectId,
      })),
    );

    await recordAudit(tx, ctx, {
      action: input.post ? 'journal_entry.posted' : 'journal_entry.created',
      entityType: 'journal_entry',
      entityId: entry.id,
      newValues: {
        entryNumber: entry.entryNumber,
        entryDate: input.entryDate,
        totalDebit,
        totalCredit,
        currencyCode,
        lineCount: normalized.length,
      },
    });

    return {
      id: entry.id,
      entryNumber: entry.entryNumber,
      status: input.post ? 'posted' : 'draft',
    };
  };

  // Reuse the caller's transaction when composing (an invoice posting its own
  // entry) so the document and its ledger effect commit atomically.
  return options.tx ? run(options.tx) : db.transaction(run);
}

/**
 * Posts an existing draft/approved entry.
 *
 * Re-validates the lines from the database rather than trusting the stored
 * totals: a draft may have been edited since it was created, and posting is
 * the point of no return.
 */
export async function postJournalEntry(
  ctx: TenantContext,
  entryId: string,
  options: { tx?: Tx } = {},
): Promise<void> {
  requirePermission(ctx, PERMISSIONS.transactions.post);

  const run = async (tx: Tx) => {
    const [entry] = await tx
      .select()
      .from(journalEntries)
      .where(and(eq(journalEntries.id, entryId), eq(journalEntries.companyId, ctx.companyId)))
      .for('update')
      .limit(1);

    if (!entry) throw new NotFoundError('Journal entry');
    if (entry.status === 'posted') {
      throw new ConflictError('This entry is already posted');
    }
    if (entry.status === 'reversed' || entry.status === 'void') {
      throw new ConflictError(`A ${entry.status} entry cannot be posted`);
    }

    const lines = await tx
      .select()
      .from(journalLines)
      .where(eq(journalLines.entryId, entryId));

    const totalDebit = sum(lines.map((l) => l.baseDebit));
    const totalCredit = sum(lines.map((l) => l.baseCredit));

    if (lines.length < 2) {
      throw new AccountingError('A journal entry must have at least two lines');
    }
    if (!equals(totalDebit, totalCredit)) {
      throw new AccountingError(
        `Entry does not balance: debits ${totalDebit} vs credits ${totalCredit}`,
      );
    }

    await assertAccountsPostable(
      tx,
      ctx.companyId,
      lines.map((l) => l.accountId),
      { allowControlAccounts: entry.sourceType !== 'manual' },
    );

    const periodId = await resolvePostingPeriod(tx, ctx.companyId, entry.entryDate);

    await tx
      .update(journalEntries)
      .set({
        status: 'posted',
        periodId,
        totalDebit,
        totalCredit,
        postedById: ctx.userId,
        postedAt: sql`now()`,
        updatedAt: sql`now()`,
      })
      .where(eq(journalEntries.id, entryId));

    await recordAudit(tx, ctx, {
      action: 'journal_entry.posted',
      entityType: 'journal_entry',
      entityId: entryId,
      previousValues: { status: entry.status },
      newValues: { status: 'posted', totalDebit, totalCredit },
    });
  };

  return options.tx ? run(options.tx) : db.transaction(run);
}

/**
 * Reverses a posted entry by creating a mirror-image entry (spec §34).
 *
 * Financial history is never deleted or edited. The reversal is a new posting
 * with debits and credits swapped, linked to the original in both directions so
 * the audit trail shows the correction rather than hiding the mistake.
 */
export async function reverseJournalEntry(
  ctx: TenantContext,
  entryId: string,
  params: { reversalDate?: string; reason: string },
  options: { tx?: Tx } = {},
): Promise<{ id: string; entryNumber: string }> {
  requirePermission(ctx, PERMISSIONS.transactions.reverse);

  if (!params.reason?.trim()) {
    throw new AccountingError('A reason is required when reversing a posted entry');
  }

  const run = async (tx: Tx) => {
    const [original] = await tx
      .select()
      .from(journalEntries)
      .where(and(eq(journalEntries.id, entryId), eq(journalEntries.companyId, ctx.companyId)))
      .for('update')
      .limit(1);

    if (!original) throw new NotFoundError('Journal entry');
    // Checked before the status guard: a reversed entry also fails that guard,
    // but "already reversed" tells the user what actually happened, whereas
    // "only posted entries can be reversed" would leave them guessing.
    if (original.reversedByEntryId) {
      throw new ConflictError(
        `This entry has already been reversed. See the linked reversal for the correction.`,
      );
    }
    if (original.status !== 'posted') {
      throw new ConflictError(`Only posted entries can be reversed (this one is ${original.status})`);
    }

    const lines = await tx
      .select()
      .from(journalLines)
      .where(eq(journalLines.entryId, entryId));

    const reversalDate = params.reversalDate ?? original.entryDate;
    const periodId = await resolvePostingPeriod(tx, ctx.companyId, reversalDate);

    const entryNumber = await allocateDocumentNumber(tx, {
      companyId: ctx.companyId,
      documentType: 'journal',
      date: new Date(reversalDate),
    });

    const [reversal] = await tx
      .insert(journalEntries)
      .values({
        companyId: ctx.companyId,
        branchId: original.branchId,
        entryNumber,
        entryDate: reversalDate,
        periodId,
        description: `Reversal of ${original.entryNumber}: ${params.reason}`,
        reference: original.reference,
        sourceType: original.sourceType,
        sourceId: original.sourceId,
        currencyCode: original.currencyCode,
        exchangeRate: original.exchangeRate,
        status: 'posted',
        // Swapped: the reversal's debits are the original's credits.
        totalDebit: original.totalCredit,
        totalCredit: original.totalDebit,
        reversesEntryId: original.id,
        createdById: ctx.userId,
        postedById: ctx.userId,
        postedAt: sql`now()`,
      })
      .returning({ id: journalEntries.id, entryNumber: journalEntries.entryNumber });

    if (!reversal) throw new ConflictError('Failed to create reversal entry');

    await tx.insert(journalLines).values(
      lines.map((line, index) => ({
        companyId: ctx.companyId,
        entryId: reversal.id,
        accountId: line.accountId,
        lineNumber: index + 1,
        // The mirror image: each amount moves to the opposite side.
        debit: line.credit,
        credit: line.debit,
        currencyCode: line.currencyCode,
        exchangeRate: line.exchangeRate,
        baseDebit: line.baseCredit,
        baseCredit: line.baseDebit,
        description: `Reversal: ${line.description ?? ''}`.trim(),
        branchId: line.branchId,
        customerId: line.customerId,
        vendorId: line.vendorId,
        projectId: line.projectId,
      })),
    );

    await tx
      .update(journalEntries)
      .set({
        status: 'reversed',
        reversedByEntryId: reversal.id,
        updatedAt: sql`now()`,
      })
      .where(eq(journalEntries.id, entryId));

    await recordAudit(tx, ctx, {
      action: 'journal_entry.reversed',
      entityType: 'journal_entry',
      entityId: entryId,
      previousValues: { status: 'posted' },
      newValues: { status: 'reversed', reversalEntryId: reversal.id },
      reason: params.reason,
    });

    return { id: reversal.id, entryNumber: reversal.entryNumber };
  };

  return options.tx ? run(options.tx) : db.transaction(run);
}

/**
 * Deletes a draft entry. Posted entries are never deletable — the database
 * would allow the DELETE, so this check is the only thing standing between a
 * user and destroyed financial history.
 */
export async function deleteDraftEntry(ctx: TenantContext, entryId: string): Promise<void> {
  requirePermission(ctx, PERMISSIONS.transactions.create);

  await db.transaction(async (tx) => {
    const [entry] = await tx
      .select()
      .from(journalEntries)
      .where(and(eq(journalEntries.id, entryId), eq(journalEntries.companyId, ctx.companyId)))
      .limit(1);

    if (!entry) throw new NotFoundError('Journal entry');
    if (entry.status === 'posted' || entry.status === 'reversed') {
      throw new ConflictError(
        'Posted entries cannot be deleted. Create a reversal instead so the history is preserved.',
      );
    }

    await recordAudit(tx, ctx, {
      action: 'journal_entry.deleted',
      entityType: 'journal_entry',
      entityId: entryId,
      previousValues: { entryNumber: entry.entryNumber, status: entry.status },
    });

    await tx.delete(journalEntries).where(eq(journalEntries.id, entryId));
  });
}

/**
 * Balance of one account over an optional date range, from ledger lines only.
 *
 * `balance` is signed by the account's *normal balance*, so an ordinary
 * position reads positive whichever side of the equation the account sits on:
 * a bank account with 5,000 debit returns 5,000, and revenue with 5,000 credit
 * also returns 5,000. Returning raw `debit - credit` would make every revenue,
 * liability and equity figure negative and force each caller to remember the
 * sign convention. `debit` and `credit` are returned unsigned for callers such
 * as the trial balance, which need the two columns as posted.
 */
export async function getAccountBalance(
  ctx: TenantContext,
  accountId: string,
  range: { from?: string; to?: string } = {},
): Promise<{ debit: Money; credit: Money; balance: Money }> {
  const conditions = [
    eq(journalLines.companyId, ctx.companyId),
    eq(journalLines.accountId, accountId),
    postedEntryFilter(),
  ];
  if (range.from) conditions.push(gte(journalEntries.entryDate, range.from));
  if (range.to) conditions.push(lte(journalEntries.entryDate, range.to));

  const [row] = await db
    .select({
      debit: sql<string>`coalesce(sum(${journalLines.baseDebit}), 0)`,
      credit: sql<string>`coalesce(sum(${journalLines.baseCredit}), 0)`,
      accountType: accounts.type,
    })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalEntries.id, journalLines.entryId))
    .innerJoin(accounts, eq(accounts.id, journalLines.accountId))
    .where(and(...conditions))
    .groupBy(accounts.type);

  const debit = money(row?.debit ?? '0');
  const credit = money(row?.credit ?? '0');
  const isDebitNormal = row?.accountType === 'asset' || row?.accountType === 'expense';
  const balance = isDebitNormal ? subtractMoney(debit, credit) : subtractMoney(credit, debit);

  return {
    debit: round(debit, ctx.currencyPrecision),
    credit: round(credit, ctx.currencyPrecision),
    balance: round(balance, ctx.currencyPrecision),
  };
}
