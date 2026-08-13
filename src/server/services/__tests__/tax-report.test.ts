/**
 * Tax / VAT return.
 *
 * The audit's finding: tax was configured, calculated and posted correctly, and
 * nothing assembled it into the one report a business is legally obliged to
 * produce. These tests check the arithmetic *and* the tie-out to the tax
 * control accounts, since a return that does not reconcile to the ledger is
 * worse than no return at all.
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import { eq } from 'drizzle-orm';

import { closeDb, db } from '@/db';
import { taxes } from '@/db/schema';
import { ALL_PERMISSIONS } from '@/server/auth/permissions';
import { createContact } from '@/server/services/contact-service';
import { createDocument, postDocument } from '@/server/services/document-service';
import { getTaxReport } from '@/server/services/report-service';

import { createTestCompany, destroyTestCompany, type TestCompany } from './harness';

describe('tax report', () => {
  let co: TestCompany;
  let customerId: string;
  let vendorId: string;
  let taxId: string;

  const year = new Date().getUTCFullYear();
  const range = { from: `${year}-01-01`, to: `${year}-12-31` };
  const issueDate = `${year}-05-15`;

  before(async () => {
    co = await createTestCompany({ permissions: ALL_PERMISSIONS });

    const [tax] = await db
      .insert(taxes)
      .values({
        companyId: co.companyId,
        code: 'VAT14',
        name: 'VAT 14%',
        ratePercent: '14',
        isInclusive: false,
        salesAccountId: co.accountId('2120'),
        purchaseAccountId: co.accountId('1150'),
      })
      .returning();
    taxId = tax!.id;

    const customer = await createContact(co.ctx, {
      kind: 'customer',
      displayName: 'Taxable Customer',
    });
    customerId = customer.id;

    const vendor = await createContact(co.ctx, {
      kind: 'vendor',
      displayName: 'Taxable Vendor',
    });
    vendorId = vendor.id;
  });

  after(async () => {
    await destroyTestCompany(co);
    await closeDb();
  });

  async function postDoc(
    direction: 'outbound' | 'inbound',
    documentType: string,
    unitPrice: string,
    accountCode: string,
  ) {
    const doc = await createDocument(co.ctx, {
      direction,
      documentType,
      contactId: direction === 'outbound' ? customerId : vendorId,
      issueDate,
      lines: [
        {
          description: 'Taxable supply',
          quantity: '1',
          unitPrice,
          accountId: co.accountId(accountCode),
          taxId,
        },
      ],
    });
    await postDocument(co.approver, doc.id);
    return doc;
  }

  test('output tax is reported from posted sales', async () => {
    // 10,000 at 14% → 1,400 output tax on a 10,000 base.
    await postDoc('outbound', 'invoice', '10000', '4100');

    const report = await getTaxReport(co.ctx, range);
    const row = report.rows.find((r) => r.taxId === taxId);

    assert.ok(row, 'the tax rate must appear on the return');
    assert.equal(Number(row.taxableSales), 10000);
    assert.equal(Number(row.outputTax), 1400);
    assert.equal(row.ratePercent, '14');
  });

  test('input tax is reported from posted purchases', async () => {
    // 4,000 at 14% → 560 input tax.
    await postDoc('inbound', 'bill', '4000', '6200');

    const report = await getTaxReport(co.ctx, range);
    const row = report.rows.find((r) => r.taxId === taxId);

    assert.ok(row);
    assert.equal(Number(row.taxablePurchases), 4000);
    assert.equal(Number(row.inputTax), 560);
  });

  test('net tax payable is output less input', async () => {
    const report = await getTaxReport(co.ctx, range);

    assert.equal(Number(report.totalOutputTax), 1400);
    assert.equal(Number(report.totalInputTax), 560);
    assert.equal(Number(report.netTaxPayable), 840);
  });

  test('the return reconciles to the tax control accounts', async () => {
    // The whole point: figures assembled from documents must agree with what
    // was actually posted to the ledger, or the return cannot be defended.
    const report = await getTaxReport(co.ctx, range);

    assert.equal(Number(report.reconciliation.ledgerOutputTax), 1400);
    assert.equal(Number(report.reconciliation.ledgerInputTax), 560);
    assert.equal(Number(report.reconciliation.outputDifference), 0);
    assert.equal(Number(report.reconciliation.inputDifference), 0);
    assert.equal(report.reconciliation.isReconciled, true);
  });

  test('a credit note reduces output tax rather than adding to input tax', async () => {
    // A sales credit note reverses a supply. Netting it against output tax is
    // correct; treating it as a purchase would overstate both sides of the
    // return while leaving the net unchanged.
    await postDoc('outbound', 'credit_note', '2000', '4100');

    const report = await getTaxReport(co.ctx, range);
    const row = report.rows.find((r) => r.taxId === taxId);

    assert.ok(row);
    assert.equal(Number(row.taxableSales), 8000, '10,000 less the 2,000 credited');
    assert.equal(Number(row.outputTax), 1120, '1,400 less 280');
    // Input tax is untouched by a sales credit note.
    assert.equal(Number(row.inputTax), 560);

    // And it still ties to the ledger, which posted the same reversal.
    assert.equal(report.reconciliation.isReconciled, true);
  });

  test('a draft document is excluded until it is posted', async () => {
    const before = await getTaxReport(co.ctx, range);

    await createDocument(co.ctx, {
      direction: 'outbound',
      documentType: 'invoice',
      contactId: customerId,
      issueDate,
      lines: [
        {
          description: 'Not yet posted',
          quantity: '1',
          unitPrice: '50000',
          accountId: co.accountId('4100'),
          taxId,
        },
      ],
    });

    const after = await getTaxReport(co.ctx, range);
    assert.equal(
      Number(after.totalOutputTax),
      Number(before.totalOutputTax),
      'a draft carries tax but has not entered the ledger, so it cannot be on the return',
    );
    assert.equal(after.reconciliation.isReconciled, true);
  });

  test('a period with no taxed activity returns an empty, reconciled report', async () => {
    const report = await getTaxReport(co.ctx, {
      from: `${year - 1}-01-01`,
      to: `${year - 1}-06-30`,
    });

    assert.equal(report.rows.length, 0);
    assert.equal(Number(report.netTaxPayable), 0);
    assert.equal(report.reconciliation.isReconciled, true);
  });
});
