import 'server-only';

import { and, asc, eq, gte, inArray, lte, sql, type SQL } from 'drizzle-orm';

import { db } from '@/db';
import {
  accounts,
  budgetLines,
  budgets,
  documents,
  journalEntries,
  journalLines,
} from '@/db/schema';
import { requirePermission, type TenantContext } from '@/server/auth/context';
import { PERMISSIONS } from '@/server/auth/permissions';
import { add, isZero, money, round, subtract, sum, type Money } from '@/lib/money';

import { postedEntryFilter } from './journal-service';

export interface ReportRange {
  from: string;
  to: string;
  branchIds?: string[];
}

/**
 * Every report is built from `journal_lines` (spec §24: "Build reports from
 * accounting data rather than duplicated balances"). No balance is cached
 * anywhere, so a report can never disagree with the ledger it describes.
 *
 * Aggregation happens in SQL. A company with 100,000 transactions must not
 * ship them to Node to be summed.
 */
function scopeConditions(ctx: TenantContext, range: Partial<ReportRange>): SQL[] {
  const conditions: SQL[] = [
    eq(journalLines.companyId, ctx.companyId),
    postedEntryFilter(),
  ];
  if (range.from) conditions.push(gte(journalEntries.entryDate, range.from));
  if (range.to) conditions.push(lte(journalEntries.entryDate, range.to));

  // A branch filter from the caller, intersected with what the user may see.
  const requested = range.branchIds ?? [];
  const allowed = ctx.branchIds;
  const effective =
    allowed.length === 0
      ? requested
      : requested.length === 0
        ? [...allowed]
        : requested.filter((b) => allowed.includes(b));

  if (effective.length > 0) {
    conditions.push(inArray(journalLines.branchId, effective));
  }
  return conditions;
}

export interface AccountBalanceRow {
  accountId: string;
  code: string;
  name: string;
  type: string;
  subtype: string;
  parentId: string | null;
  debit: Money;
  credit: Money;
  /** Signed by the account's normal balance. */
  balance: Money;
}

/** Per-account debit/credit totals over a range — the basis of most reports. */
export async function getAccountBalances(
  ctx: TenantContext,
  range: Partial<ReportRange> = {},
): Promise<AccountBalanceRow[]> {
  const rows = await db
    .select({
      accountId: accounts.id,
      code: accounts.code,
      name: accounts.name,
      type: accounts.type,
      subtype: accounts.subtype,
      parentId: accounts.parentId,
      debit: sql<string>`coalesce(sum(${journalLines.baseDebit}), 0)`,
      credit: sql<string>`coalesce(sum(${journalLines.baseCredit}), 0)`,
    })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalEntries.id, journalLines.entryId))
    .innerJoin(accounts, eq(accounts.id, journalLines.accountId))
    .where(and(...scopeConditions(ctx, range)))
    .groupBy(
      accounts.id,
      accounts.code,
      accounts.name,
      accounts.type,
      accounts.subtype,
      accounts.parentId,
    )
    .orderBy(asc(accounts.code));

  return rows.map((row) => {
    const debitNormal = row.type === 'asset' || row.type === 'expense';
    return {
      ...row,
      debit: money(row.debit),
      credit: money(row.credit),
      balance: debitNormal
        ? subtract(row.debit, row.credit)
        : subtract(row.credit, row.debit),
    };
  });
}

/**
 * Trial balance: every account with its debit and credit totals.
 * The two columns must be equal — if they are not, the ledger is broken.
 */
export async function getTrialBalance(ctx: TenantContext, range: ReportRange) {
  requirePermission(ctx, PERMISSIONS.reports.view);

  const rows = await getAccountBalances(ctx, range);
  const totalDebit = sum(rows.map((r) => r.debit));
  const totalCredit = sum(rows.map((r) => r.credit));

  return {
    range,
    rows: rows.filter((r) => !isZero(r.debit) || !isZero(r.credit)),
    totalDebit: round(totalDebit, ctx.currencyPrecision),
    totalCredit: round(totalCredit, ctx.currencyPrecision),
    /** A failing check means data was written outside the posting service. */
    isBalanced: totalDebit === totalCredit,
  };
}

export interface ReportSection {
  title: string;
  accounts: AccountBalanceRow[];
  total: Money;
}

/**
 * Profit & Loss for a period.
 *
 * Revenue and expenses only: balance-sheet accounts carry balances forward and
 * would be meaningless here.
 */
export async function getProfitAndLoss(ctx: TenantContext, range: ReportRange) {
  requirePermission(ctx, PERMISSIONS.reports.view);

  const rows = await getAccountBalances(ctx, range);

  const revenue = rows.filter((r) => r.type === 'revenue' && !isZero(r.balance));
  const costOfSales = rows.filter(
    (r) => r.type === 'expense' && r.subtype === 'cost_of_goods_sold' && !isZero(r.balance),
  );
  const operatingExpenses = rows.filter(
    (r) => r.type === 'expense' && r.subtype !== 'cost_of_goods_sold' && !isZero(r.balance),
  );

  const totalRevenue = sum(revenue.map((r) => r.balance));
  const totalCostOfSales = sum(costOfSales.map((r) => r.balance));
  const grossProfit = subtract(totalRevenue, totalCostOfSales);
  const totalOperatingExpenses = sum(operatingExpenses.map((r) => r.balance));
  const netProfit = subtract(grossProfit, totalOperatingExpenses);

  const p = ctx.currencyPrecision;
  return {
    range,
    sections: [
      { title: 'Revenue', accounts: revenue, total: round(totalRevenue, p) },
      { title: 'Cost of Sales', accounts: costOfSales, total: round(totalCostOfSales, p) },
      {
        title: 'Operating Expenses',
        accounts: operatingExpenses,
        total: round(totalOperatingExpenses, p),
      },
    ] satisfies ReportSection[],
    grossProfit: round(grossProfit, p),
    netProfit: round(netProfit, p),
    totalRevenue: round(totalRevenue, p),
    totalExpenses: round(add(totalCostOfSales, totalOperatingExpenses), p),
  };
}

/**
 * Balance Sheet as at a date.
 *
 * Balance-sheet accounts are cumulative from the beginning of time, so no
 * `from` is applied. Retained earnings is computed as accumulated profit
 * rather than read from its account: profit for the current year has not been
 * closed out yet, and omitting it would leave the sheet out of balance.
 */
export async function getBalanceSheet(
  ctx: TenantContext,
  params: { asOf: string; branchIds?: string[] },
) {
  requirePermission(ctx, PERMISSIONS.reports.view);

  const rows = await getAccountBalances(ctx, {
    to: params.asOf,
    branchIds: params.branchIds,
  });

  const assets = rows.filter((r) => r.type === 'asset' && !isZero(r.balance));
  const liabilities = rows.filter((r) => r.type === 'liability' && !isZero(r.balance));
  const equity = rows.filter((r) => r.type === 'equity' && !isZero(r.balance));

  const revenue = rows.filter((r) => r.type === 'revenue');
  const expenses = rows.filter((r) => r.type === 'expense');
  const accumulatedProfit = subtract(
    sum(revenue.map((r) => r.balance)),
    sum(expenses.map((r) => r.balance)),
  );

  const totalAssets = sum(assets.map((r) => r.balance));
  const totalLiabilities = sum(liabilities.map((r) => r.balance));
  const totalEquity = add(sum(equity.map((r) => r.balance)), accumulatedProfit);

  const p = ctx.currencyPrecision;
  const difference = subtract(totalAssets, add(totalLiabilities, totalEquity));

  return {
    asOf: params.asOf,
    sections: [
      { title: 'Assets', accounts: assets, total: round(totalAssets, p) },
      { title: 'Liabilities', accounts: liabilities, total: round(totalLiabilities, p) },
      { title: 'Equity', accounts: equity, total: round(sum(equity.map((r) => r.balance)), p) },
    ] satisfies ReportSection[],
    /** Current-period profit, not yet closed to retained earnings. */
    accumulatedProfit: round(accumulatedProfit, p),
    totalAssets: round(totalAssets, p),
    totalLiabilities: round(totalLiabilities, p),
    totalEquity: round(totalEquity, p),
    /** Assets − (Liabilities + Equity). Must be zero. */
    difference: round(difference, p),
    isBalanced: isZero(difference),
  };
}

/**
 * General Ledger: every posted line for an account, with a running balance.
 * The drill-down destination from any report figure.
 */
export async function getGeneralLedger(
  ctx: TenantContext,
  params: { accountId?: string; from: string; to: string; branchIds?: string[]; limit?: number },
) {
  requirePermission(ctx, PERMISSIONS.reports.view);

  const conditions = scopeConditions(ctx, params);
  if (params.accountId) conditions.push(eq(journalLines.accountId, params.accountId));

  const lines = await db
    .select({
      lineId: journalLines.id,
      entryId: journalEntries.id,
      entryNumber: journalEntries.entryNumber,
      entryDate: journalEntries.entryDate,
      description: journalLines.description,
      entryDescription: journalEntries.description,
      reference: journalEntries.reference,
      sourceType: journalEntries.sourceType,
      sourceId: journalEntries.sourceId,
      accountId: accounts.id,
      accountCode: accounts.code,
      accountName: accounts.name,
      accountType: accounts.type,
      debit: journalLines.baseDebit,
      credit: journalLines.baseCredit,
    })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalEntries.id, journalLines.entryId))
    .innerJoin(accounts, eq(accounts.id, journalLines.accountId))
    .where(and(...conditions))
    .orderBy(asc(journalEntries.entryDate), asc(journalEntries.entryNumber))
    .limit(params.limit ?? 500);

  // Opening balance: everything before the range, so the running balance the
  // user sees continues from the prior period rather than starting at zero.
  let opening: Money = '0';
  if (params.accountId) {
    const priorConditions = [
      eq(journalLines.companyId, ctx.companyId),
      eq(journalLines.accountId, params.accountId),
      postedEntryFilter(),
      sql`${journalEntries.entryDate} < ${params.from}`,
    ];
    const [prior] = await db
      .select({
        debit: sql<string>`coalesce(sum(${journalLines.baseDebit}), 0)`,
        credit: sql<string>`coalesce(sum(${journalLines.baseCredit}), 0)`,
        type: accounts.type,
      })
      .from(journalLines)
      .innerJoin(journalEntries, eq(journalEntries.id, journalLines.entryId))
      .innerJoin(accounts, eq(accounts.id, journalLines.accountId))
      .where(and(...priorConditions))
      .groupBy(accounts.type);

    if (prior) {
      const debitNormal = prior.type === 'asset' || prior.type === 'expense';
      opening = debitNormal
        ? subtract(prior.debit, prior.credit)
        : subtract(prior.credit, prior.debit);
    }
  }

  let running = opening;
  const rows = lines.map((line) => {
    const debitNormal = line.accountType === 'asset' || line.accountType === 'expense';
    const movement = debitNormal
      ? subtract(line.debit, line.credit)
      : subtract(line.credit, line.debit);
    running = add(running, movement);
    return { ...line, balance: running };
  });

  return { openingBalance: opening, closingBalance: running, rows, range: params };
}

/**
 * Cash Flow, derived indirectly.
 *
 * Rather than classify every transaction, movements on cash accounts are
 * grouped by the *other* side of their entry: an entry touching cash and a
 * revenue account is operating, one touching a fixed asset is investing, and
 * one touching equity or a loan is financing. This is an approximation, and it
 * is stated as such — a full indirect cash flow needs working-capital
 * adjustments a general engine cannot infer.
 */
export async function getCashFlow(ctx: TenantContext, range: ReportRange) {
  requirePermission(ctx, PERMISSIONS.reports.view);

  const cashAccounts = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(
      and(
        eq(accounts.companyId, ctx.companyId),
        inArray(accounts.subtype, ['cash', 'bank']),
      ),
    );

  const cashIds = cashAccounts.map((a) => a.id);
  if (cashIds.length === 0) {
    return {
      range,
      operating: '0' as Money,
      investing: '0' as Money,
      financing: '0' as Money,
      netChange: '0' as Money,
      openingCash: '0' as Money,
      closingCash: '0' as Money,
    };
  }

  // Entries that moved cash, with the counterpart account types they touched.
  const rows = await db
    .select({
      entryId: journalEntries.id,
      counterpartType: accounts.type,
      counterpartSubtype: accounts.subtype,
      debit: journalLines.baseDebit,
      credit: journalLines.baseCredit,
      isCash: sql<boolean>`${journalLines.accountId} in ${cashIds}`,
    })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalEntries.id, journalLines.entryId))
    .innerJoin(accounts, eq(accounts.id, journalLines.accountId))
    .where(
      and(
        ...scopeConditions(ctx, range),
        sql`exists (
          select 1 from ${journalLines} cash_line
          where cash_line.entry_id = ${journalEntries.id}
            and cash_line.account_id in ${cashIds}
        )`,
      ),
    );

  const byEntry = new Map<string, { cashMovement: Money; categories: Set<string> }>();

  for (const row of rows) {
    const entry = byEntry.get(row.entryId) ?? {
      cashMovement: '0' as Money,
      categories: new Set<string>(),
    };

    if (row.isCash) {
      entry.cashMovement = add(entry.cashMovement, subtract(row.debit, row.credit));
    } else {
      entry.categories.add(classifyCounterpart(row.counterpartType, row.counterpartSubtype));
    }
    byEntry.set(row.entryId, entry);
  }

  let operating: Money = '0';
  let investing: Money = '0';
  let financing: Money = '0';

  for (const entry of byEntry.values()) {
    // An entry touching several categories is attributed to the most specific
    // one present, preferring financing then investing, so a loan drawn to buy
    // equipment is not miscounted as ordinary trading.
    const category = entry.categories.has('financing')
      ? 'financing'
      : entry.categories.has('investing')
        ? 'investing'
        : 'operating';

    if (category === 'financing') financing = add(financing, entry.cashMovement);
    else if (category === 'investing') investing = add(investing, entry.cashMovement);
    else operating = add(operating, entry.cashMovement);
  }

  const openingRows = await db
    .select({
      debit: sql<string>`coalesce(sum(${journalLines.baseDebit}), 0)`,
      credit: sql<string>`coalesce(sum(${journalLines.baseCredit}), 0)`,
    })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalEntries.id, journalLines.entryId))
    .where(
      and(
        eq(journalLines.companyId, ctx.companyId),
        postedEntryFilter(),
        inArray(journalLines.accountId, cashIds),
        sql`${journalEntries.entryDate} < ${range.from}`,
      ),
    );

  const openingCash = subtract(openingRows[0]?.debit ?? '0', openingRows[0]?.credit ?? '0');
  const netChange = add(add(operating, investing), financing);

  const p = ctx.currencyPrecision;
  return {
    range,
    operating: round(operating, p),
    investing: round(investing, p),
    financing: round(financing, p),
    netChange: round(netChange, p),
    openingCash: round(openingCash, p),
    closingCash: round(add(openingCash, netChange), p),
  };
}

function classifyCounterpart(type: string, subtype: string): string {
  if (subtype === 'fixed_asset' || subtype === 'accumulated_depreciation') return 'investing';
  if (subtype === 'long_term_liability' || type === 'equity') return 'financing';
  return 'operating';
}

/**
 * Budget vs Actual (spec §25). Budget figures come from the budget lines;
 * actuals always from the ledger.
 */
export async function getBudgetVsActual(
  ctx: TenantContext,
  params: { budgetId: string; from: string; to: string },
) {
  requirePermission(ctx, PERMISSIONS.budgets.view);

  const [budget] = await db
    .select()
    .from(budgets)
    .where(and(eq(budgets.id, params.budgetId), eq(budgets.companyId, ctx.companyId)))
    .limit(1);

  if (!budget) {
    return { budget: null, rows: [], totalBudget: '0' as Money, totalActual: '0' as Money };
  }

  const budgetRows = await db
    .select({
      accountId: budgetLines.accountId,
      code: accounts.code,
      name: accounts.name,
      type: accounts.type,
      budgeted: sql<string>`coalesce(sum(${budgetLines.amount}), 0)`,
    })
    .from(budgetLines)
    .innerJoin(accounts, eq(accounts.id, budgetLines.accountId))
    .where(eq(budgetLines.budgetId, params.budgetId))
    .groupBy(budgetLines.accountId, accounts.code, accounts.name, accounts.type);

  const actuals = await getAccountBalances(ctx, { from: params.from, to: params.to });
  const actualByAccount = new Map(actuals.map((a) => [a.accountId, a.balance]));

  const rows = budgetRows.map((row) => {
    const actual = actualByAccount.get(row.accountId) ?? '0';
    const budgeted = money(row.budgeted);
    // Variance is actual − budget: positive means overspent for an expense,
    // and outperformed for revenue. The sign is interpreted by the caller.
    const variance = subtract(actual, budgeted);
    const variancePercent = isZero(budgeted)
      ? '0'
      : String(((Number(actual) - Number(budgeted)) / Number(budgeted)) * 100);

    return { ...row, budgeted, actual, variance, variancePercent };
  });

  return {
    budget,
    rows,
    totalBudget: sum(rows.map((r) => r.budgeted)),
    totalActual: sum(rows.map((r) => r.actual)),
  };
}

/** Dashboard figures, each computed from the ledger or open documents. */
export async function getDashboardMetrics(ctx: TenantContext, range: ReportRange) {
  requirePermission(ctx, PERMISSIONS.dashboard.view);

  const [pl, balances] = await Promise.all([
    getProfitAndLoss(ctx, range),
    getAccountBalances(ctx, { to: range.to }),
  ]);

  const cash = balances
    .filter((b) => b.subtype === 'cash' || b.subtype === 'bank')
    .reduce<Money>((acc, b) => add(acc, b.balance), '0');

  const receivable = balances
    .filter((b) => b.subtype === 'accounts_receivable')
    .reduce<Money>((acc, b) => add(acc, b.balance), '0');

  const payable = balances
    .filter((b) => b.subtype === 'accounts_payable')
    .reduce<Money>((acc, b) => add(acc, b.balance), '0');

  const today = new Date().toISOString().slice(0, 10);

  const [overdue] = await db
    .select({
      count: sql<number>`count(*)::int`,
      total: sql<string>`coalesce(sum(${documents.balanceDue}), 0)`,
    })
    .from(documents)
    .where(
      and(
        eq(documents.companyId, ctx.companyId),
        eq(documents.direction, 'outbound'),
        sql`${documents.balanceDue} > 0`,
        sql`${documents.dueDate} < ${today}`,
        inArray(documents.status, ['approved', 'sent', 'partially_paid', 'overdue']),
      ),
    );

  const [upcomingBills] = await db
    .select({
      count: sql<number>`count(*)::int`,
      total: sql<string>`coalesce(sum(${documents.balanceDue}), 0)`,
    })
    .from(documents)
    .where(
      and(
        eq(documents.companyId, ctx.companyId),
        eq(documents.direction, 'inbound'),
        sql`${documents.balanceDue} > 0`,
        inArray(documents.status, ['approved', 'sent', 'partially_paid', 'overdue']),
      ),
    );

  const p = ctx.currencyPrecision;
  return {
    range,
    revenue: pl.totalRevenue,
    expenses: pl.totalExpenses,
    netProfit: pl.netProfit,
    cash: round(cash, p),
    accountsReceivable: round(receivable, p),
    accountsPayable: round(payable, p),
    overdueInvoices: { count: overdue?.count ?? 0, total: money(overdue?.total ?? '0') },
    upcomingBills: {
      count: upcomingBills?.count ?? 0,
      total: money(upcomingBills?.total ?? '0'),
    },
  };
}

/** Monthly revenue/expense series for dashboard trend charts. */
export async function getMonthlyTrend(
  ctx: TenantContext,
  params: { from: string; to: string },
) {
  requirePermission(ctx, PERMISSIONS.dashboard.view);

  const rows = await db
    .select({
      month: sql<string>`to_char(${journalEntries.entryDate}, 'YYYY-MM')`,
      type: accounts.type,
      debit: sql<string>`coalesce(sum(${journalLines.baseDebit}), 0)`,
      credit: sql<string>`coalesce(sum(${journalLines.baseCredit}), 0)`,
    })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalEntries.id, journalLines.entryId))
    .innerJoin(accounts, eq(accounts.id, journalLines.accountId))
    .where(
      and(
        ...scopeConditions(ctx, params),
        inArray(accounts.type, ['revenue', 'expense']),
      ),
    )
    .groupBy(sql`to_char(${journalEntries.entryDate}, 'YYYY-MM')`, accounts.type);

  const byMonth = new Map<string, { month: string; revenue: Money; expenses: Money }>();

  for (const row of rows) {
    const entry = byMonth.get(row.month) ?? {
      month: row.month,
      revenue: '0' as Money,
      expenses: '0' as Money,
    };
    if (row.type === 'revenue') {
      entry.revenue = add(entry.revenue, subtract(row.credit, row.debit));
    } else {
      entry.expenses = add(entry.expenses, subtract(row.debit, row.credit));
    }
    byMonth.set(row.month, entry);
  }

  return [...byMonth.values()]
    .sort((a, b) => a.month.localeCompare(b.month))
    .map((m) => ({ ...m, netProfit: subtract(m.revenue, m.expenses) }));
}
