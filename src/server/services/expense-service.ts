import 'server-only';

import { and, desc, eq, sql } from 'drizzle-orm';

import { db } from '@/db';
import { accounts, contacts, expenseCategories, expenses, taxes, users } from '@/db/schema';
import {
  requireBranchAccess,
  requirePermission,
  type TenantContext,
} from '@/server/auth/context';
import { PERMISSIONS } from '@/server/auth/permissions';
import { AccountingError, ConflictError, NotFoundError, ValidationError } from '@/server/errors';
import { add, gt, money, subtract, type Money } from '@/lib/money';

import { recordAudit } from './audit-service';
import { resolveAccountByRole } from './account-service';
import { resolveExchangeRate } from './currency-service';
import { createJournalEntry, reverseJournalEntry } from './journal-service';
import { allocateDocumentNumber } from './numbering-service';

export type ExpenseRow = typeof expenses.$inferSelect;

export interface CreateExpenseInput {
  categoryId: string;
  expenseDate: string;
  description: string;
  amount: Money;
  /** Bank/cash account it was paid from. Omit for an unpaid, reimbursable claim. */
  paymentAccountId?: string | null;
  contactId?: string | null;
  taxId?: string | null;
  currencyCode?: string;
  exchangeRate?: string;
  branchId?: string | null;
  receiptUrl?: string | null;
  isReimbursable?: boolean;
  /** Submit for approval immediately instead of saving a draft. */
  submit?: boolean;
}

/**
 * Creates an expense claim (spec §14).
 *
 * Nothing posts here. An expense reaches the ledger only through `approve`,
 * which is what "do not automatically post an expense before approval if
 * approval is required" means in practice.
 */
export async function createExpense(
  ctx: TenantContext,
  input: CreateExpenseInput,
): Promise<ExpenseRow> {
  requirePermission(ctx, PERMISSIONS.expenses.create);
  requireBranchAccess(ctx, input.branchId ?? null);

  const amount = money(input.amount);
  if (!gt(amount, '0')) {
    throw new ValidationError('Expense amount must be greater than zero');
  }

  return db.transaction(async (tx) => {
    const [category] = await tx
      .select()
      .from(expenseCategories)
      .where(
        and(
          eq(expenseCategories.id, input.categoryId),
          eq(expenseCategories.companyId, ctx.companyId),
        ),
      )
      .limit(1);

    if (!category) throw new NotFoundError('Expense category');

    const currencyCode = input.currencyCode ?? ctx.baseCurrencyCode;
    const exchangeRate =
      input.exchangeRate ??
      (await resolveExchangeRate(tx, {
        companyId: ctx.companyId,
        from: currencyCode,
        to: ctx.baseCurrencyCode,
        date: input.expenseDate,
      }));

    // Tax on an expense is recoverable, so it is separated from the cost and
    // parked in the purchase-tax asset rather than inflating the expense.
    let taxAmount = '0';
    if (input.taxId) {
      const [tax] = await tx
        .select()
        .from(taxes)
        .where(and(eq(taxes.id, input.taxId), eq(taxes.companyId, ctx.companyId)))
        .limit(1);

      if (!tax) throw new NotFoundError('Tax');

      taxAmount = tax.isInclusive
        ? subtract(amount, divideByRate(amount, tax.ratePercent))
        : money(String((Number(amount) * Number(tax.ratePercent)) / 100));
    }

    const expenseNumber = await allocateDocumentNumber(tx, {
      companyId: ctx.companyId,
      documentType: 'expense',
      date: new Date(input.expenseDate),
    });

    const [created] = await tx
      .insert(expenses)
      .values({
        companyId: ctx.companyId,
        branchId: input.branchId ?? null,
        expenseNumber,
        categoryId: input.categoryId,
        userId: ctx.userId,
        contactId: input.contactId ?? null,
        expenseDate: input.expenseDate,
        description: input.description,
        currencyCode,
        exchangeRate,
        amount,
        taxId: input.taxId ?? null,
        taxAmount,
        paymentAccountId: input.paymentAccountId ?? null,
        isReimbursable: input.isReimbursable ?? false,
        status: input.submit ? 'pending_approval' : 'draft',
        submittedAt: input.submit ? sql`now()` : null,
        receiptUrl: input.receiptUrl ?? null,
        createdById: ctx.userId,
      })
      .returning();

    if (!created) throw new ConflictError('Failed to create expense');

    await recordAudit(tx, ctx, {
      action: input.submit ? 'expense.submitted' : 'expense.created',
      entityType: 'expense',
      entityId: created.id,
      newValues: { expenseNumber, amount, categoryId: input.categoryId },
    });

    return created;
  });
}

/** Extracts the tax-exclusive base from an inclusive amount. */
function divideByRate(amountValue: Money, ratePercent: string): Money {
  const base = (Number(amountValue) * 100) / (100 + Number(ratePercent));
  return money(base.toFixed(6));
}

export async function submitExpense(ctx: TenantContext, expenseId: string): Promise<void> {
  requirePermission(ctx, PERMISSIONS.expenses.create);

  await db.transaction(async (tx) => {
    const [expense] = await tx
      .select()
      .from(expenses)
      .where(and(eq(expenses.id, expenseId), eq(expenses.companyId, ctx.companyId)))
      .limit(1);

    if (!expense) throw new NotFoundError('Expense');
    if (expense.status !== 'draft' && expense.status !== 'rejected') {
      throw new ConflictError(`An expense that is ${expense.status} cannot be submitted again`);
    }

    await tx
      .update(expenses)
      .set({ status: 'pending_approval', submittedAt: sql`now()`, updatedAt: sql`now()` })
      .where(eq(expenses.id, expenseId));

    await recordAudit(tx, ctx, {
      action: 'expense.submitted',
      entityType: 'expense',
      entityId: expenseId,
      previousValues: { status: expense.status },
      newValues: { status: 'pending_approval' },
    });
  });
}

/**
 * Approves an expense and posts it:
 *   Dr Expense account        net of recoverable tax
 *   Dr Recoverable tax        tax
 *     Cr Bank / Payable         gross
 *
 * When no payment account is given the credit goes to accounts payable: the
 * company owes the employee, and that liability belongs in the ledger rather
 * than sitting only in the expense record.
 */
export async function approveExpense(
  ctx: TenantContext,
  expenseId: string,
): Promise<{ journalEntryId: string }> {
  requirePermission(ctx, PERMISSIONS.expenses.approve);

  return db.transaction(async (tx) => {
    const [expense] = await tx
      .select()
      .from(expenses)
      .where(and(eq(expenses.id, expenseId), eq(expenses.companyId, ctx.companyId)))
      .for('update')
      .limit(1);

    if (!expense) throw new NotFoundError('Expense');
    if (expense.journalEntryId) {
      throw new ConflictError('This expense has already been posted');
    }
    if (expense.status === 'rejected') {
      throw new ConflictError('A rejected expense cannot be approved; resubmit it first');
    }

    const [category] = await tx
      .select()
      .from(expenseCategories)
      .where(eq(expenseCategories.id, expense.categoryId!))
      .limit(1);

    if (!category) throw new NotFoundError('Expense category');

    const netAmount = subtract(expense.amount, expense.taxAmount);

    const lines: Array<Record<string, unknown>> = [
      {
        accountId: category.accountId,
        debit: netAmount,
        description: expense.description,
        branchId: expense.branchId,
        vendorId: expense.contactId,
      },
    ];

    if (gt(expense.taxAmount, '0')) {
      const taxAccount = await resolveAccountByRole(
        tx,
        ctx.companyId,
        'purchase_tax_receivable',
      );
      lines.push({
        accountId: taxAccount.id,
        debit: expense.taxAmount,
        description: `Recoverable tax on ${expense.expenseNumber}`,
        branchId: expense.branchId,
      });
    }

    // Paid directly, or owed to whoever fronted the money.
    let creditAccountId = expense.paymentAccountId;
    let allowControlAccounts = false;
    if (!creditAccountId) {
      const payable = await resolveAccountByRole(tx, ctx.companyId, 'accounts_payable');
      creditAccountId = payable.id;
      allowControlAccounts = true;
    }

    lines.push({
      accountId: creditAccountId,
      credit: expense.amount,
      description: `Expense ${expense.expenseNumber}`,
      branchId: expense.branchId,
      vendorId: expense.contactId,
    });

    const entry = await createJournalEntry(
      ctx,
      {
        entryDate: expense.expenseDate,
        description: `Expense ${expense.expenseNumber}: ${expense.description}`,
        currencyCode: expense.currencyCode,
        exchangeRate: expense.exchangeRate,
        branchId: expense.branchId,
        sourceType: 'expense',
        sourceId: expense.id,
        lines: lines as never,
        post: true,
      },
      { tx, allowControlAccounts },
    );

    await tx
      .update(expenses)
      .set({
        status: 'posted',
        journalEntryId: entry.id,
        approvedById: ctx.userId,
        approvedAt: sql`now()`,
        updatedAt: sql`now()`,
      })
      .where(eq(expenses.id, expenseId));

    await recordAudit(tx, ctx, {
      action: 'expense.approved',
      entityType: 'expense',
      entityId: expenseId,
      previousValues: { status: expense.status },
      newValues: { status: 'posted', journalEntryId: entry.id },
    });

    return { journalEntryId: entry.id };
  });
}

export async function rejectExpense(
  ctx: TenantContext,
  expenseId: string,
  reason: string,
): Promise<void> {
  requirePermission(ctx, PERMISSIONS.expenses.approve);

  if (!reason?.trim()) {
    throw new ValidationError('A reason is required when rejecting an expense');
  }

  await db.transaction(async (tx) => {
    const [expense] = await tx
      .select()
      .from(expenses)
      .where(and(eq(expenses.id, expenseId), eq(expenses.companyId, ctx.companyId)))
      .limit(1);

    if (!expense) throw new NotFoundError('Expense');
    if (expense.journalEntryId) {
      throw new ConflictError(
        'This expense is already posted. Reverse it instead of rejecting it.',
      );
    }

    await tx
      .update(expenses)
      .set({ status: 'rejected', updatedAt: sql`now()` })
      .where(eq(expenses.id, expenseId));

    await recordAudit(tx, ctx, {
      action: 'expense.rejected',
      entityType: 'expense',
      entityId: expenseId,
      previousValues: { status: expense.status },
      newValues: { status: 'rejected' },
      reason,
    });
  });
}

/** Reverses a posted expense, leaving both entries in the ledger. */
export async function reverseExpense(
  ctx: TenantContext,
  expenseId: string,
  reason: string,
): Promise<void> {
  requirePermission(ctx, PERMISSIONS.transactions.reverse);

  await db.transaction(async (tx) => {
    const [expense] = await tx
      .select()
      .from(expenses)
      .where(and(eq(expenses.id, expenseId), eq(expenses.companyId, ctx.companyId)))
      .limit(1);

    if (!expense) throw new NotFoundError('Expense');
    if (!expense.journalEntryId) {
      throw new ConflictError('This expense has not been posted');
    }

    await reverseJournalEntry(
      ctx,
      expense.journalEntryId,
      { reason: `Reverse expense ${expense.expenseNumber}: ${reason}` },
      { tx },
    );

    await tx
      .update(expenses)
      .set({ status: 'rejected', updatedAt: sql`now()` })
      .where(eq(expenses.id, expenseId));

    await recordAudit(tx, ctx, {
      action: 'expense.reversed',
      entityType: 'expense',
      entityId: expenseId,
      reason,
    });
  });
}

export async function listExpenses(
  ctx: TenantContext,
  filters: {
    status?: ExpenseRow['status'];
    categoryId?: string;
    from?: string;
    to?: string;
    limit?: number;
    offset?: number;
  } = {},
) {
  requirePermission(ctx, PERMISSIONS.expenses.view);

  const conditions = [eq(expenses.companyId, ctx.companyId)];
  if (filters.status) conditions.push(eq(expenses.status, filters.status));
  if (filters.categoryId) conditions.push(eq(expenses.categoryId, filters.categoryId));
  if (filters.from) conditions.push(sql`${expenses.expenseDate} >= ${filters.from}`);
  if (filters.to) conditions.push(sql`${expenses.expenseDate} <= ${filters.to}`);

  return db
    .select({
      id: expenses.id,
      expenseNumber: expenses.expenseNumber,
      expenseDate: expenses.expenseDate,
      description: expenses.description,
      amount: expenses.amount,
      currencyCode: expenses.currencyCode,
      status: expenses.status,
      categoryName: expenseCategories.name,
      submittedBy: users.name,
      vendorName: contacts.displayName,
    })
    .from(expenses)
    .leftJoin(expenseCategories, eq(expenseCategories.id, expenses.categoryId))
    .leftJoin(users, eq(users.id, expenses.userId))
    .leftJoin(contacts, eq(contacts.id, expenses.contactId))
    .where(and(...conditions))
    .orderBy(desc(expenses.expenseDate))
    .limit(filters.limit ?? 50)
    .offset(filters.offset ?? 0);
}

export async function createExpenseCategory(
  ctx: TenantContext,
  input: { name: string; accountId: string },
) {
  requirePermission(ctx, PERMISSIONS.settings.manage);

  const [account] = await db
    .select()
    .from(accounts)
    .where(and(eq(accounts.id, input.accountId), eq(accounts.companyId, ctx.companyId)))
    .limit(1);

  if (!account) throw new NotFoundError('Account');
  if (account.type !== 'expense' && account.type !== 'asset') {
    throw new AccountingError(
      `Expense categories must point at an expense or asset account; ${account.code} is a ${account.type} account.`,
    );
  }

  const [created] = await db
    .insert(expenseCategories)
    .values({ companyId: ctx.companyId, name: input.name, accountId: input.accountId })
    .returning();

  return created;
}

export async function listExpenseCategories(ctx: TenantContext) {
  return db
    .select()
    .from(expenseCategories)
    .where(
      and(eq(expenseCategories.companyId, ctx.companyId), eq(expenseCategories.isActive, true)),
    );
}
