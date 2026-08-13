import 'server-only';

import { and, asc, eq, sql } from 'drizzle-orm';

import { db, type Tx } from '@/db';
import {
  accounts,
  companies,
  fiscalPeriods,
  journalEntries,
  journalLines,
} from '@/db/schema';
import { requirePermission, type TenantContext } from '@/server/auth/context';
import { PERMISSIONS } from '@/server/auth/permissions';
import { AccountingError, ConflictError, NotFoundError } from '@/server/errors';
import { add, isZero, money, round, subtract, sum, type Money } from '@/lib/money';

import { recordAudit } from './audit-service';
import { resolveAccountByRole } from './account-service';
import { createJournalEntry } from './journal-service';

/**
 * Fiscal year-end close (spec §33, audit finding: no year-end close).
 *
 * Closing a year zeroes every revenue and expense account and transfers the
 * net result to retained earnings, so the P&L starts the next year at nil and
 * equity carries the accumulated result as a real ledger balance rather than a
 * figure the balance sheet recomputes.
 *
 * The entry is:
 *
 *   Dr each revenue account      its credit balance
 *     Cr each expense account      its debit balance
 *     Cr Retained Earnings         net profit      (or Dr, for a net loss)
 *
 * Two design points worth stating:
 *
 * 1. The close is posted through `createJournalEntry` like everything else, so
 *    it lands in the ledger under the same validation, period checks and
 *    balance assertion as any other entry. There is no privileged write path.
 *
 * 2. `company.lastClosedDate` is advanced in the same transaction. The balance
 *    sheet reads it and accumulates profit only from the day after, which is
 *    what stops the closing entry being counted twice — once in the retained
 *    earnings account and again in the sheet's own recomputation.
 */

/** The last day of the fiscal year identified by the year it starts in. */
export function fiscalYearEnd(fiscalYear: number, startMonth: number): string {
  // A January start ends 31 December of the same year; a July start ends
  // 30 June of the next. Day 0 of the following month is the last day of this
  // one, which avoids a leap-year table.
  const endMonthIndex = startMonth - 1 + 12;
  const year = fiscalYear + Math.floor(endMonthIndex / 12);
  const month = endMonthIndex % 12;
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
}

export function fiscalYearStart(fiscalYear: number, startMonth: number): string {
  return new Date(Date.UTC(fiscalYear, startMonth - 1, 1)).toISOString().slice(0, 10);
}

export interface YearEndPreview {
  fiscalYear: number;
  startDate: string;
  endDate: string;
  revenue: Money;
  expenses: Money;
  netIncome: Money;
  /** True when the result is a loss, i.e. retained earnings is debited. */
  isLoss: boolean;
  accountsToClose: number;
  alreadyClosed: boolean;
  unpostedCount: number;
}

/**
 * What closing this year would do, without doing it.
 *
 * Shown before the irreversible action so the accountant can tie the net
 * income to the P&L they have already reviewed.
 */
export async function previewYearEndClose(
  ctx: TenantContext,
  fiscalYear: number,
): Promise<YearEndPreview> {
  requirePermission(ctx, PERMISSIONS.reports.view);

  const [company] = await db
    .select({
      fiscalYearStartMonth: companies.fiscalYearStartMonth,
      lastClosedDate: companies.lastClosedDate,
    })
    .from(companies)
    .where(eq(companies.id, ctx.companyId))
    .limit(1);

  if (!company) throw new NotFoundError('Company');

  const startDate = fiscalYearStart(fiscalYear, company.fiscalYearStartMonth);
  const endDate = fiscalYearEnd(fiscalYear, company.fiscalYearStartMonth);

  const balances = await getClosableBalances(db as unknown as Tx, ctx, startDate, endDate);

  const revenue = sum(balances.filter((b) => b.type === 'revenue').map((b) => b.balance));
  const expenses = sum(balances.filter((b) => b.type === 'expense').map((b) => b.balance));
  const netIncome = subtract(revenue, expenses);

  const [drafts] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(journalEntries)
    .where(
      and(
        eq(journalEntries.companyId, ctx.companyId),
        sql`${journalEntries.entryDate} between ${startDate} and ${endDate}`,
        sql`${journalEntries.status} in ('draft', 'pending_approval', 'approved')`,
      ),
    );

  return {
    fiscalYear,
    startDate,
    endDate,
    revenue: round(revenue, ctx.currencyPrecision),
    expenses: round(expenses, ctx.currencyPrecision),
    netIncome: round(netIncome, ctx.currencyPrecision),
    isLoss: netIncome.startsWith('-'),
    accountsToClose: balances.length,
    alreadyClosed: Boolean(
      company.lastClosedDate && company.lastClosedDate >= endDate,
    ),
    unpostedCount: drafts?.count ?? 0,
  };
}

/**
 * Revenue and expense balances for the year, from posted ledger lines only.
 *
 * Scoped to the year itself rather than to inception: a prior year that has
 * already been closed contributed its result to retained earnings then, and
 * including it again would restate equity.
 */
async function getClosableBalances(
  tx: Tx,
  ctx: TenantContext,
  startDate: string,
  endDate: string,
): Promise<Array<{ accountId: string; code: string; type: string; balance: Money }>> {
  const rows = await tx
    .select({
      accountId: accounts.id,
      code: accounts.code,
      type: accounts.type,
      isPostable: accounts.isPostable,
      debit: sql<string>`coalesce(sum(${journalLines.baseDebit}), 0)`,
      credit: sql<string>`coalesce(sum(${journalLines.baseCredit}), 0)`,
    })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalEntries.id, journalLines.entryId))
    .innerJoin(accounts, eq(accounts.id, journalLines.accountId))
    .where(
      and(
        eq(journalLines.companyId, ctx.companyId),
        sql`${journalEntries.status} in ('posted', 'reversed')`,
        sql`${journalEntries.entryDate} between ${startDate} and ${endDate}`,
        sql`${accounts.type} in ('revenue', 'expense')`,
      ),
    )
    .groupBy(accounts.id, accounts.code, accounts.type, accounts.isPostable)
    .orderBy(asc(accounts.code));

  return rows
    .map((row) => ({
      accountId: row.accountId,
      code: row.code,
      type: row.type,
      // Revenue is credit-normal, expense debit-normal; `balance` is the
      // amount that must be moved to bring the account to nil.
      balance:
        row.type === 'expense'
          ? subtract(row.debit, row.credit)
          : subtract(row.credit, row.debit),
    }))
    .filter((row) => !isZero(row.balance));
}

/**
 * Closes a fiscal year.
 *
 * Refuses to run twice for the same year: the guard is `company.lastClosedDate`
 * plus a check for an existing `year_end_close` entry, both inside one
 * transaction with the company row locked, so two concurrent closes cannot
 * both pass the check.
 */
export async function closeFiscalYear(
  ctx: TenantContext,
  fiscalYear: number,
  options: { lockPeriods?: boolean } = {},
): Promise<{ journalEntryId: string; netIncome: Money }> {
  // Closing a year is a controller-level action, not a bookkeeping one.
  requirePermission(ctx, PERMISSIONS.periods.manage);
  requirePermission(ctx, PERMISSIONS.transactions.post);

  return db.transaction(async (tx) => {
    const [company] = await tx
      .select({
        id: companies.id,
        fiscalYearStartMonth: companies.fiscalYearStartMonth,
        lastClosedDate: companies.lastClosedDate,
      })
      .from(companies)
      .where(eq(companies.id, ctx.companyId))
      // Serialises concurrent closes: the second waits, then sees the first's
      // `lastClosedDate` and is refused.
      .for('update')
      .limit(1);

    if (!company) throw new NotFoundError('Company');

    const startDate = fiscalYearStart(fiscalYear, company.fiscalYearStartMonth);
    const endDate = fiscalYearEnd(fiscalYear, company.fiscalYearStartMonth);

    if (company.lastClosedDate && company.lastClosedDate >= endDate) {
      throw new ConflictError(
        `The year ending ${endDate} is already closed (last close: ${company.lastClosedDate}). ` +
          'Post an adjusting entry in an open period instead of closing again.',
      );
    }

    // Belt and braces: an existing close entry for this year is refused even
    // if `lastClosedDate` were somehow cleared by hand.
    const [existing] = await tx
      .select({ id: journalEntries.id, entryNumber: journalEntries.entryNumber })
      .from(journalEntries)
      .where(
        and(
          eq(journalEntries.companyId, ctx.companyId),
          eq(journalEntries.sourceType, 'year_end_close'),
          eq(journalEntries.entryDate, endDate),
          sql`${journalEntries.status} in ('posted', 'reversed')`,
        ),
      )
      .limit(1);

    if (existing) {
      throw new ConflictError(
        `A year-end closing entry (${existing.entryNumber}) already exists for ${endDate}.`,
      );
    }

    // Closing a year with unposted work in it would omit that work from the
    // result and leave it stranded in a period about to be locked.
    const [drafts] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(journalEntries)
      .where(
        and(
          eq(journalEntries.companyId, ctx.companyId),
          sql`${journalEntries.entryDate} between ${startDate} and ${endDate}`,
          sql`${journalEntries.status} in ('draft', 'pending_approval', 'approved')`,
        ),
      );

    if ((drafts?.count ?? 0) > 0) {
      throw new AccountingError(
        `${drafts!.count} entry/entries dated in ${fiscalYear} are still unposted. ` +
          'Post or delete them before closing the year, or their results will be ' +
          'excluded from retained earnings.',
      );
    }

    const balances = await getClosableBalances(tx, ctx, startDate, endDate);

    if (balances.length === 0) {
      throw new AccountingError(
        `There is no revenue or expense activity in ${fiscalYear} to close.`,
      );
    }

    const revenue = sum(balances.filter((b) => b.type === 'revenue').map((b) => b.balance));
    const expenses = sum(balances.filter((b) => b.type === 'expense').map((b) => b.balance));
    const netIncome = subtract(revenue, expenses);

    const retainedEarnings = await resolveAccountByRole(
      tx,
      ctx.companyId,
      'retained_earnings',
    );

    /**
     * One line per account, each moving that account's balance to the opposite
     * side so it ends the year at nil, and the net to retained earnings.
     *
     * A revenue account carrying a credit balance is debited; an expense
     * account carrying a debit balance is credited. An account with a contra
     * balance (a revenue account net debit, say, from heavy credit notes)
     * flips accordingly, which is why each line is decided by the sign rather
     * than by the account type alone.
     */
    const lines: Array<Record<string, unknown>> = [];

    for (const account of balances) {
      const isNegative = account.balance.startsWith('-');
      const magnitude = isNegative ? account.balance.slice(1) : account.balance;

      // Revenue (credit-normal, positive) → debit it to clear.
      // Expense (debit-normal, positive) → credit it to clear.
      const clearOnDebit = account.type === 'revenue' ? !isNegative : isNegative;

      lines.push({
        accountId: account.accountId,
        [clearOnDebit ? 'debit' : 'credit']: magnitude,
        description: `Year-end close ${fiscalYear}`,
      });
    }

    const netIsProfit = !netIncome.startsWith('-');
    const netMagnitude = netIsProfit ? netIncome : netIncome.slice(1);

    lines.push({
      accountId: retainedEarnings.id,
      // Profit credits equity; a loss debits it.
      [netIsProfit ? 'credit' : 'debit']: netMagnitude,
      description: `Net ${netIsProfit ? 'profit' : 'loss'} for ${fiscalYear}`,
    });

    const entry = await createJournalEntry(
      ctx,
      {
        entryDate: endDate,
        description: `Year-end close ${fiscalYear}`,
        reference: `YEC-${fiscalYear}`,
        sourceType: 'year_end_close',
        lines: lines as never,
        post: true,
      },
      // Retained earnings is role-resolved equity, not an AR/AP control
      // account, so the subledger protection is untouched by this.
      { tx },
    );

    await tx
      .update(companies)
      .set({ lastClosedDate: endDate, updatedAt: sql`now()` })
      .where(eq(companies.id, ctx.companyId));

    // Locking the year's periods is the usual next step but is optional: some
    // companies keep the year `closed` (reopenable) until the audit signs off.
    if (options.lockPeriods) {
      await tx
        .update(fiscalPeriods)
        .set({ status: 'locked', closedAt: sql`now()`, closedById: ctx.userId })
        .where(
          and(
            eq(fiscalPeriods.companyId, ctx.companyId),
            sql`${fiscalPeriods.startDate} >= ${startDate}`,
            sql`${fiscalPeriods.endDate} <= ${endDate}`,
          ),
        );
    }

    await recordAudit(tx, ctx, {
      action: 'year_end.closed',
      entityType: 'fiscal_year',
      entityId: entry.id,
      newValues: {
        fiscalYear,
        startDate,
        endDate,
        revenue,
        expenses,
        netIncome,
        accountsClosed: balances.length,
        journalEntryId: entry.id,
        periodsLocked: Boolean(options.lockPeriods),
      },
    });

    return { journalEntryId: entry.id, netIncome };
  });
}

/** The company's last closed year-end, or null. Read by the balance sheet. */
export async function getLastClosedDate(
  ctx: TenantContext,
  tx?: Tx,
): Promise<string | null> {
  const executor = tx ?? db;
  const [company] = await executor
    .select({ lastClosedDate: companies.lastClosedDate })
    .from(companies)
    .where(eq(companies.id, ctx.companyId))
    .limit(1);

  return company?.lastClosedDate ?? null;
}
