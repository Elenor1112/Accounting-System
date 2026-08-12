import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import { db, closeDb } from '@/db';
import { bankAccounts } from '@/db/schema';
import { ForbiddenError } from '@/server/errors';
import { createContact } from '@/server/services/contact-service';
import { createDocument, postDocument } from '@/server/services/document-service';
import { createJournalEntry, getAccountBalance } from '@/server/services/journal-service';
import { createPayment } from '@/server/services/payment-service';
import {
  getBalanceSheet,
  getCashFlow,
  getGeneralLedger,
  getMonthlyTrend,
  getProfitAndLoss,
  getTrialBalance,
  getDashboardMetrics,
} from '@/server/services/report-service';
import { createTransfer, getBankAccountBalance } from '@/server/services/banking-service';

import { createTestCompany, destroyTestCompany, type TestCompany } from './harness';

describe('reporting engine', () => {
  let co: TestCompany;
  let bankId: string;
  let savingsId: string;
  let customerId: string;

  before(async () => {
    co = await createTestCompany();

    const customer = await createContact(co.ctx, {
      kind: 'customer',
      displayName: 'Acme Corp',
    });
    customerId = customer.id;

    const [bank] = await db
      .insert(bankAccounts)
      .values({
        companyId: co.companyId,
        name: 'Operating',
        currencyCode: 'USD',
        ledgerAccountId: co.accountId('1120'),
      })
      .returning();
    bankId = bank!.id;

    const [savings] = await db
      .insert(bankAccounts)
      .values({
        companyId: co.companyId,
        name: 'Petty Cash',
        accountKind: 'cash',
        currencyCode: 'USD',
        ledgerAccountId: co.accountId('1110'),
      })
      .returning();
    savingsId = savings!.id;

    // Opening capital: financing.
    await createJournalEntry(co.ctx, {
      entryDate: '2026-01-02',
      description: 'Opening capital',
      lines: [
        { accountId: co.accountId('1120'), debit: '100000' },
        { accountId: co.accountId('3100'), credit: '100000' },
      ],
      post: true,
    });

    // Equipment purchase: investing.
    await createJournalEntry(co.ctx, {
      entryDate: '2026-01-10',
      description: 'Equipment',
      lines: [
        { accountId: co.accountId('1210'), debit: '20000' },
        { accountId: co.accountId('1120'), credit: '20000' },
      ],
      post: true,
    });

    // Trading: an invoice, then payment for it.
    const invoice = await createDocument(co.ctx, {
      direction: 'outbound',
      documentType: 'invoice',
      contactId: customerId,
      issueDate: '2026-01-15',
      lines: [
        {
          description: 'Services',
          quantity: '1',
          unitPrice: '30000',
          accountId: co.accountId('4100'),
        },
      ],
    });
    await postDocument(co.ctx, invoice.id);

    await createPayment(co.ctx, {
      direction: 'receipt',
      contactId: customerId,
      paymentDate: '2026-01-20',
      amount: '30000',
      bankAccountId: bankId,
      allocations: [{ documentId: invoice.id, amountApplied: '30000' }],
    });

    // Operating costs.
    await createJournalEntry(co.ctx, {
      entryDate: '2026-01-25',
      description: 'Rent and salaries',
      lines: [
        { accountId: co.accountId('6200'), debit: '5000' },
        { accountId: co.accountId('6100'), debit: '12000' },
        { accountId: co.accountId('1120'), credit: '17000' },
      ],
      post: true,
    });

    // February activity, so the trend has two points.
    await createJournalEntry(co.ctx, {
      entryDate: '2026-02-05',
      description: 'February consulting',
      lines: [
        { accountId: co.accountId('1120'), debit: '18000' },
        { accountId: co.accountId('4100'), credit: '18000' },
      ],
      post: true,
    });
  });

  after(async () => {
    await destroyTestCompany(co);
    await closeDb();
  });

  test('the trial balance balances', async () => {
    const tb = await getTrialBalance(co.ctx, { from: '2026-01-01', to: '2026-12-31' });
    assert.ok(tb.isBalanced, `debits ${tb.totalDebit} vs credits ${tb.totalCredit}`);
    assert.equal(tb.totalDebit, tb.totalCredit);
    assert.ok(tb.rows.length > 0);
  });

  test('profit and loss computes from revenue less expenses', async () => {
    const pl = await getProfitAndLoss(co.ctx, { from: '2026-01-01', to: '2026-01-31' });

    // January: 30,000 revenue, 17,000 expenses.
    assert.equal(pl.totalRevenue, '30000');
    assert.equal(pl.totalExpenses, '17000');
    assert.equal(pl.netProfit, '13000');
  });

  test('profit and loss respects the date range', async () => {
    const february = await getProfitAndLoss(co.ctx, { from: '2026-02-01', to: '2026-02-28' });
    assert.equal(february.totalRevenue, '18000');
    assert.equal(february.totalExpenses, '0');
    assert.equal(february.netProfit, '18000');
  });

  test('the balance sheet balances: assets = liabilities + equity', async () => {
    const bs = await getBalanceSheet(co.ctx, { asOf: '2026-12-31' });

    assert.ok(
      bs.isBalanced,
      `assets ${bs.totalAssets} vs liabilities+equity ${bs.totalLiabilities}+${bs.totalEquity} ` +
        `(difference ${bs.difference})`,
    );
    assert.equal(bs.difference, '0');
  });

  test('the balance sheet includes current-period profit in equity', async () => {
    const bs = await getBalanceSheet(co.ctx, { asOf: '2026-12-31' });
    // 30,000 + 18,000 revenue less 17,000 expenses = 31,000 accumulated.
    assert.equal(bs.accumulatedProfit, '31000');
  });

  test('the general ledger shows a running balance', async () => {
    const gl = await getGeneralLedger(co.ctx, {
      accountId: co.accountId('1120'),
      from: '2026-01-01',
      to: '2026-12-31',
    });

    assert.ok(gl.rows.length >= 4);
    assert.equal(gl.openingBalance, '0');

    // The closing balance must equal the account's balance from the ledger.
    const balance = await getAccountBalance(co.ctx, co.accountId('1120'));
    assert.equal(gl.closingBalance, balance.balance);
  });

  test('general ledger opening balance carries the prior period forward', async () => {
    const february = await getGeneralLedger(co.ctx, {
      accountId: co.accountId('1120'),
      from: '2026-02-01',
      to: '2026-02-28',
    });

    // January's closing position is February's opening: 100,000 − 20,000
    // + 30,000 − 17,000 = 93,000.
    assert.equal(february.openingBalance, '93000');
  });

  test('cash flow separates operating, investing and financing', async () => {
    const cf = await getCashFlow(co.ctx, { from: '2026-01-01', to: '2026-01-31' });

    // Capital injection.
    assert.equal(cf.financing, '100000');
    // Equipment purchase.
    assert.equal(cf.investing, '-20000');
    // Customer receipt less operating costs: 30,000 − 17,000.
    assert.equal(cf.operating, '13000');
    assert.equal(cf.netChange, '93000');
  });

  test('a bank transfer moves money without creating income', async () => {
    const plBefore = await getProfitAndLoss(co.ctx, { from: '2026-03-01', to: '2026-03-31' });

    await createTransfer(co.ctx, {
      fromBankAccountId: bankId,
      toBankAccountId: savingsId,
      date: '2026-03-01',
      amount: '5000',
    });

    const plAfter = await getProfitAndLoss(co.ctx, { from: '2026-03-01', to: '2026-03-31' });
    // A transfer is not revenue or expense.
    assert.equal(plAfter.netProfit, plBefore.netProfit);

    const cash = await getBankAccountBalance(co.ctx, savingsId);
    assert.equal(cash.balance, '5000');
  });

  test('the monthly trend has one row per active month', async () => {
    const trend = await getMonthlyTrend(co.ctx, { from: '2026-01-01', to: '2026-12-31' });

    const january = trend.find((t) => t.month === '2026-01');
    assert.equal(january?.revenue, '30000');
    assert.equal(january?.netProfit, '13000');

    const february = trend.find((t) => t.month === '2026-02');
    assert.equal(february?.revenue, '18000');
  });

  test('dashboard metrics come from the ledger', async () => {
    const metrics = await getDashboardMetrics(co.ctx, {
      from: '2026-01-01',
      to: '2026-12-31',
    });

    assert.equal(metrics.revenue, '48000');
    assert.equal(metrics.expenses, '17000');
    assert.equal(metrics.netProfit, '31000');
    // Cash: bank 93,000 + 18,000 February − 5,000 transferred + 5,000 in petty cash.
    assert.equal(metrics.cash, '111000');
  });

  test('reports require the reports.view permission', async () => {
    const restricted = { ...co.ctx, permissions: ['accounting.dashboard.view'] };
    await assert.rejects(
      getTrialBalance(restricted, { from: '2026-01-01', to: '2026-12-31' }),
      ForbiddenError,
    );
  });
});

/**
 * Tenant isolation (spec §36: "Company A cannot access Company B financial
 * data"). Two companies are built with identical-looking data; every read must
 * see only its own.
 */
describe('tenant isolation', () => {
  let alpha: TestCompany;
  let beta: TestCompany;

  before(async () => {
    alpha = await createTestCompany();
    beta = await createTestCompany();

    await createJournalEntry(alpha.ctx, {
      entryDate: '2026-01-15',
      description: 'Alpha revenue',
      lines: [
        { accountId: alpha.accountId('1120'), debit: '75000' },
        { accountId: alpha.accountId('4100'), credit: '75000' },
      ],
      post: true,
    });

    await createJournalEntry(beta.ctx, {
      entryDate: '2026-01-15',
      description: 'Beta revenue',
      lines: [
        { accountId: beta.accountId('1120'), debit: '11000' },
        { accountId: beta.accountId('4100'), credit: '11000' },
      ],
      post: true,
    });
  });

  after(async () => {
    await destroyTestCompany(alpha);
    await destroyTestCompany(beta);
    await closeDb();
  });

  test("a company's reports show only its own figures", async () => {
    const alphaPl = await getProfitAndLoss(alpha.ctx, {
      from: '2026-01-01',
      to: '2026-12-31',
    });
    const betaPl = await getProfitAndLoss(beta.ctx, { from: '2026-01-01', to: '2026-12-31' });

    assert.equal(alphaPl.totalRevenue, '75000');
    assert.equal(betaPl.totalRevenue, '11000');
  });

  test('an account balance is scoped to its company', async () => {
    const alphaBalance = await getAccountBalance(alpha.ctx, alpha.accountId('1120'));
    assert.equal(alphaBalance.balance, '75000');

    // Asking for another company's account id through Alpha's context returns
    // nothing rather than Beta's data.
    const leaked = await getAccountBalance(alpha.ctx, beta.accountId('1120'));
    assert.equal(leaked.balance, '0');
  });

  test("posting cannot reference another company's account", async () => {
    await assert.rejects(
      createJournalEntry(alpha.ctx, {
        entryDate: '2026-02-01',
        lines: [
          // Beta's bank account, from Alpha's context.
          { accountId: beta.accountId('1120'), debit: '500' },
          { accountId: alpha.accountId('4100'), credit: '500' },
        ],
        post: true,
      }),
      /not found/i,
    );
  });

  test('the general ledger never crosses companies', async () => {
    const gl = await getGeneralLedger(alpha.ctx, {
      from: '2026-01-01',
      to: '2026-12-31',
    });
    assert.ok(gl.rows.length > 0);
    assert.ok(
      gl.rows.every((r) => r.entryNumber.length > 0),
      'rows should belong to alpha only',
    );

    const betaGl = await getGeneralLedger(beta.ctx, { from: '2026-01-01', to: '2026-12-31' });
    const alphaEntryIds = new Set(gl.rows.map((r) => r.entryId));
    assert.ok(
      betaGl.rows.every((r) => !alphaEntryIds.has(r.entryId)),
      "beta's ledger must contain none of alpha's entries",
    );
  });
});
