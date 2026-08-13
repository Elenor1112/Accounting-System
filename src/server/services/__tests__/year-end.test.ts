/**
 * Fiscal year-end close.
 *
 * The audit's finding: nothing closed a year, so retained earnings never
 * appeared in the ledger and the balance sheet computed accumulated profit
 * from inception. That workaround kept the sheet balanced but meant a manual
 * closing entry would be counted twice — a risk that became live the moment
 * the manual journal entry screen existed.
 *
 * The scenario asserted here is the one from the brief:
 *
 *   Revenue − Expenses = Net Income
 *   Close year
 *   → revenue accounts = 0, expense accounts = 0
 *   → retained earnings updated
 *   → balance sheet still balances
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import { eq } from 'drizzle-orm';

import { closeDb, db } from '@/db';
import { companies, journalEntries } from '@/db/schema';
import { ALL_PERMISSIONS } from '@/server/auth/permissions';
import { createJournalEntry, getAccountBalance } from '@/server/services/journal-service';
import { getBalanceSheet, getProfitAndLoss } from '@/server/services/report-service';
import {
  closeFiscalYear,
  fiscalYearEnd,
  previewYearEndClose,
} from '@/server/services/year-end-service';

import { createTestCompany, destroyTestCompany, type TestCompany } from './harness';

describe('year-end close', () => {
  let co: TestCompany;

  // Close last year: it is fully within the harness's generated calendar and
  // safely in the past, so the period control is satisfied.
  const fiscalYear = new Date().getUTCFullYear() - 1;
  const yearStart = `${fiscalYear}-01-01`;
  const yearEnd = `${fiscalYear}-12-31`;

  before(async () => {
    co = await createTestCompany({ permissions: ALL_PERMISSIONS });

    // Revenue 100,000 / Expenses 60,000 → net income 40,000.
    await createJournalEntry(co.ctx, {
      entryDate: `${fiscalYear}-03-15`,
      description: 'Sales for the year',
      lines: [
        { accountId: co.accountId('1120'), debit: '100000' },
        { accountId: co.accountId('4100'), credit: '100000' },
      ],
      post: true,
    });

    await createJournalEntry(co.ctx, {
      entryDate: `${fiscalYear}-06-20`,
      description: 'Rent for the year',
      lines: [
        { accountId: co.accountId('6200'), debit: '35000' },
        { accountId: co.accountId('1120'), credit: '35000' },
      ],
      post: true,
    });

    await createJournalEntry(co.ctx, {
      entryDate: `${fiscalYear}-09-10`,
      description: 'Salaries for the year',
      lines: [
        { accountId: co.accountId('6100'), debit: '25000' },
        { accountId: co.accountId('1120'), credit: '25000' },
      ],
      post: true,
    });
  });

  after(async () => {
    await destroyTestCompany(co);
    await closeDb();
  });

  const balanceOf = async (code: string) =>
    Number((await getAccountBalance(co.ctx, co.accountId(code))).balance);

  test('the fiscal year end is derived from the company start month', () => {
    // January start → 31 December of the same year.
    assert.equal(fiscalYearEnd(2026, 1), '2026-12-31');
    // July start → 30 June of the following year.
    assert.equal(fiscalYearEnd(2026, 7), '2027-06-30');
    // Leap year handled without a table.
    assert.equal(fiscalYearEnd(2023, 3), '2024-02-29');
  });

  test('the preview reports net income before anything is posted', async () => {
    const preview = await previewYearEndClose(co.ctx, fiscalYear);

    assert.equal(preview.startDate, yearStart);
    assert.equal(preview.endDate, yearEnd);
    assert.equal(Number(preview.revenue), 100000);
    assert.equal(Number(preview.expenses), 60000);
    assert.equal(Number(preview.netIncome), 40000);
    assert.equal(preview.isLoss, false);
    assert.equal(preview.alreadyClosed, false);

    // Nothing was posted by previewing.
    assert.equal(await balanceOf('3200'), 0);
  });

  test('the P&L agrees with the preview', async () => {
    // The close must move exactly what the P&L reported, or the statements and
    // the ledger disagree at the one moment they most need to match.
    const pl = await getProfitAndLoss(co.ctx, { from: yearStart, to: yearEnd });
    const preview = await previewYearEndClose(co.ctx, fiscalYear);

    assert.equal(Number(pl.netProfit), Number(preview.netIncome));
  });

  test('closing zeroes revenue and expenses and credits retained earnings', async () => {
    const result = await closeFiscalYear(co.ctx, fiscalYear);
    assert.equal(Number(result.netIncome), 40000);

    // Every revenue and expense account is nil *as at the year end*.
    const revenue = await getAccountBalance(co.ctx, co.accountId('4100'), {
      from: yearStart,
      to: yearEnd,
    });
    const rent = await getAccountBalance(co.ctx, co.accountId('6200'), {
      from: yearStart,
      to: yearEnd,
    });
    const salaries = await getAccountBalance(co.ctx, co.accountId('6100'), {
      from: yearStart,
      to: yearEnd,
    });

    assert.equal(Number(revenue.balance), 0, 'revenue must close to nil');
    assert.equal(Number(rent.balance), 0, 'rent must close to nil');
    assert.equal(Number(salaries.balance), 0, 'salaries must close to nil');

    // Retained earnings now carries the result as a real ledger balance,
    // rather than a figure the balance sheet recomputes.
    assert.equal(await balanceOf('3200'), 40000);

    // The entry is a normal, balanced, traceable posting.
    const [entry] = await db
      .select()
      .from(journalEntries)
      .where(eq(journalEntries.id, result.journalEntryId));
    assert.equal(entry?.sourceType, 'year_end_close');
    assert.equal(entry?.status, 'posted');
    assert.equal(entry?.entryDate, yearEnd);
    assert.equal(entry?.totalDebit, entry?.totalCredit);

    // And the company records where accumulation should now start.
    const [company] = await db
      .select()
      .from(companies)
      .where(eq(companies.id, co.companyId));
    assert.equal(company?.lastClosedDate, yearEnd);
  });

  test('the balance sheet does not double-count the closing entry', async () => {
    // This is the whole point of `lastClosedDate`. Before it existed the sheet
    // computed accumulated profit from inception, so a posted closing entry
    // appeared twice: in the retained earnings balance and in the sheet's own
    // recomputation, overstating equity by the full net income.
    const sheet = await getBalanceSheet(co.ctx, { asOf: yearEnd });

    assert.ok(sheet.isBalanced, `balance sheet is out by ${sheet.difference}`);
    assert.equal(
      Number(sheet.accumulatedProfit),
      0,
      'after a close there is no unclosed profit left at the year end',
    );
    assert.equal(Number(sheet.totalEquity), 40000);
    assert.equal(sheet.lastClosedDate, yearEnd);
  });

  test('profit earned after the close accumulates again from the next day', async () => {
    const thisYear = new Date().getUTCFullYear();

    await createJournalEntry(co.ctx, {
      entryDate: `${thisYear}-02-10`,
      description: 'Sales in the new year',
      lines: [
        { accountId: co.accountId('1120'), debit: '15000' },
        { accountId: co.accountId('4100'), credit: '15000' },
      ],
      post: true,
    });

    const sheet = await getBalanceSheet(co.ctx, { asOf: `${thisYear}-12-31` });

    // The new year's profit is unclosed and shows separately; the prior year's
    // is in retained earnings. Equity is the sum, counted once.
    assert.equal(Number(sheet.accumulatedProfit), 15000);
    assert.equal(Number(sheet.totalEquity), 55000);
    assert.ok(sheet.isBalanced, `balance sheet is out by ${sheet.difference}`);
  });

  test('a year cannot be closed twice', async () => {
    await assert.rejects(closeFiscalYear(co.ctx, fiscalYear), /already closed/);

    // And the guard did not corrupt anything on the way out.
    assert.equal(await balanceOf('3200'), 40000);
  });

  test('the preview reports a closed year as already closed', async () => {
    const preview = await previewYearEndClose(co.ctx, fiscalYear);
    assert.equal(preview.alreadyClosed, true);
  });

  test('closing a year with no activity is refused', async () => {
    const empty = await createTestCompany({ permissions: ALL_PERMISSIONS });
    try {
      await assert.rejects(
        closeFiscalYear(empty.ctx, new Date().getUTCFullYear() - 1),
        /no revenue or expense activity/,
      );
    } finally {
      await destroyTestCompany(empty);
    }
  });

  test('a year with unposted entries in it cannot be closed', async () => {
    const other = await createTestCompany({ permissions: ALL_PERMISSIONS });
    try {
      const year = new Date().getUTCFullYear() - 1;

      await createJournalEntry(other.ctx, {
        entryDate: `${year}-04-01`,
        lines: [
          { accountId: other.accountId('1120'), debit: '500' },
          { accountId: other.accountId('4100'), credit: '500' },
        ],
        post: true,
      });

      // A draft dated inside the year would be excluded from the result and
      // then stranded in a period about to be locked.
      await createJournalEntry(other.ctx, {
        entryDate: `${year}-05-01`,
        lines: [
          { accountId: other.accountId('6200'), debit: '250' },
          { accountId: other.accountId('1120'), credit: '250' },
        ],
      });

      await assert.rejects(closeFiscalYear(other.ctx, year), /still unposted/);
    } finally {
      await destroyTestCompany(other);
    }
  });

  test('a loss debits retained earnings instead of crediting it', async () => {
    const lossCo = await createTestCompany({ permissions: ALL_PERMISSIONS });
    try {
      const year = new Date().getUTCFullYear() - 1;

      await createJournalEntry(lossCo.ctx, {
        entryDate: `${year}-03-01`,
        lines: [
          { accountId: lossCo.accountId('1120'), debit: '20000' },
          { accountId: lossCo.accountId('4100'), credit: '20000' },
        ],
        post: true,
      });
      await createJournalEntry(lossCo.ctx, {
        entryDate: `${year}-04-01`,
        lines: [
          { accountId: lossCo.accountId('6200'), debit: '32000' },
          { accountId: lossCo.accountId('1120'), credit: '32000' },
        ],
        post: true,
      });

      const result = await closeFiscalYear(lossCo.ctx, year);
      assert.equal(Number(result.netIncome), -12000);

      // Equity is reduced by the loss.
      const re = await getAccountBalance(lossCo.ctx, lossCo.accountId('3200'));
      assert.equal(Number(re.balance), -12000);

      const sheet = await getBalanceSheet(lossCo.ctx, { asOf: `${year}-12-31` });
      assert.ok(sheet.isBalanced, `balance sheet is out by ${sheet.difference}`);
    } finally {
      await destroyTestCompany(lossCo);
    }
  });
});
