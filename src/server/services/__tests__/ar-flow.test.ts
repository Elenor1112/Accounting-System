import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import { and, eq } from 'drizzle-orm';

import { closeDb, db } from '@/db';
import { bankAccounts, documents, paymentAllocations, taxes } from '@/db/schema';
import {
  createDocument,
  getDocument,
  postDocument,
  voidDocument,
} from '@/server/services/document-service';
import { getAccountBalance } from '@/server/services/journal-service';
import { createContact, getAgingReport, getContactBalance } from '@/server/services/contact-service';
import { createPayment, listOpenDocuments, voidPayment } from '@/server/services/payment-service';

import { createTestCompany, destroyTestCompany, type TestCompany } from './harness';

/**
 * The end-to-end flow from spec §36:
 *   create invoice -> post -> record payment -> verify AR, bank, revenue,
 *   journal entries and reports.
 */
describe('accounts receivable flow', () => {
  let co: TestCompany;
  let customerId: string;
  let bankAccountId: string;
  let vatId: string;

  before(async () => {
    co = await createTestCompany();

    const customer = await createContact(co.ctx, {
      kind: 'customer',
      displayName: 'Northwind Trading',
      email: 'ap@northwind.test',
      paymentTermsDays: 30,
    });
    customerId = customer.id;

    const [bank] = await db
      .insert(bankAccounts)
      .values({
        companyId: co.companyId,
        name: 'Main Operating Account',
        accountKind: 'bank',
        currencyCode: 'USD',
        ledgerAccountId: co.accountId('1120'),
      })
      .returning();
    bankAccountId = bank!.id;

    const [vat] = await db
      .insert(taxes)
      .values({
        companyId: co.companyId,
        code: 'VAT14',
        name: 'VAT 14%',
        ratePercent: '14',
        isInclusive: false,
        salesAccountId: co.accountId('2120'),
      })
      .returning();
    vatId = vat!.id;
  });

  after(async () => {
    await destroyTestCompany(co);
    await closeDb();
  });

  test('an invoice computes its totals from its lines', async () => {
    const invoice = await createDocument(co.ctx, {
      direction: 'outbound',
      documentType: 'invoice',
      contactId: customerId,
      issueDate: '2026-02-01',
      lines: [
        {
          description: 'Consulting — February',
          quantity: '10',
          unitPrice: '500',
          accountId: co.accountId('4100'),
          taxId: vatId,
        },
        {
          description: 'Onboarding fee',
          quantity: '1',
          unitPrice: '1500',
          accountId: co.accountId('4100'),
          taxId: vatId,
        },
      ],
    });

    // 5,000 + 1,500 = 6,500 net; VAT 14% = 910; total 7,410.
    assert.equal(invoice.subtotal, '6500');
    assert.equal(invoice.taxTotal, '910');
    assert.equal(invoice.total, '7410');
    assert.equal(invoice.balanceDue, '7410');
    assert.equal(invoice.status, 'draft');
    // Due date defaults from the customer's 30-day terms.
    assert.equal(invoice.dueDate, '2026-03-03');
  });

  test('a draft invoice has no ledger effect until posted', async () => {
    const before = await getAccountBalance(co.ctx, co.accountId('4100'));

    await createDocument(co.ctx, {
      direction: 'outbound',
      documentType: 'invoice',
      contactId: customerId,
      issueDate: '2026-02-02',
      lines: [
        {
          description: 'Draft only',
          quantity: '1',
          unitPrice: '999',
          accountId: co.accountId('4100'),
        },
      ],
    });

    const after = await getAccountBalance(co.ctx, co.accountId('4100'));
    assert.equal(after.balance, before.balance);
  });

  test('posting an invoice debits AR and credits revenue and tax', async () => {
    const invoice = await createDocument(co.ctx, {
      direction: 'outbound',
      documentType: 'invoice',
      contactId: customerId,
      issueDate: '2026-02-10',
      lines: [
        {
          description: 'Retainer',
          quantity: '1',
          unitPrice: '10000',
          accountId: co.accountId('4100'),
          taxId: vatId,
        },
      ],
    });

    const arBefore = await getAccountBalance(co.ctx, co.accountId('1130'));
    const revenueBefore = await getAccountBalance(co.ctx, co.accountId('4100'));
    const taxBefore = await getAccountBalance(co.ctx, co.accountId('2120'));

    await postDocument(co.ctx, invoice.id);

    const arAfter = await getAccountBalance(co.ctx, co.accountId('1130'));
    const revenueAfter = await getAccountBalance(co.ctx, co.accountId('4100'));
    const taxAfter = await getAccountBalance(co.ctx, co.accountId('2120'));

    // AR (an asset) rises by the gross total…
    assert.equal(Number(arAfter.balance) - Number(arBefore.balance), 11400);
    // …revenue by the net…
    assert.equal(Number(revenueAfter.balance) - Number(revenueBefore.balance), 10000);
    // …and the tax liability by the VAT.
    assert.equal(Number(taxAfter.balance) - Number(taxBefore.balance), 1400);
  });

  test('a posted invoice cannot be posted twice', async () => {
    const invoice = await createDocument(co.ctx, {
      direction: 'outbound',
      documentType: 'invoice',
      contactId: customerId,
      issueDate: '2026-02-11',
      lines: [
        { description: 'Once', quantity: '1', unitPrice: '100', accountId: co.accountId('4100') },
      ],
    });

    await postDocument(co.ctx, invoice.id);
    await assert.rejects(postDocument(co.ctx, invoice.id), /already been posted/);
  });

  test('a quote is not a financial document and cannot be posted', async () => {
    const quote = await createDocument(co.ctx, {
      direction: 'outbound',
      documentType: 'quote',
      contactId: customerId,
      issueDate: '2026-02-12',
      lines: [
        { description: 'Proposal', quantity: '1', unitPrice: '5000', accountId: co.accountId('4100') },
      ],
    });

    await assert.rejects(postDocument(co.ctx, quote.id), /not a financial document/);
  });

  test('a full payment settles the invoice and clears AR', async () => {
    const invoice = await createDocument(co.ctx, {
      direction: 'outbound',
      documentType: 'invoice',
      contactId: customerId,
      issueDate: '2026-03-01',
      lines: [
        { description: 'Project delivery', quantity: '1', unitPrice: '4000', accountId: co.accountId('4100') },
      ],
    });
    await postDocument(co.ctx, invoice.id);

    const arBefore = await getAccountBalance(co.ctx, co.accountId('1130'));
    const bankBefore = await getAccountBalance(co.ctx, co.accountId('1120'));

    await createPayment(co.ctx, {
      direction: 'receipt',
      contactId: customerId,
      paymentDate: '2026-03-05',
      amount: '4000',
      bankAccountId,
      method: 'bank_transfer',
      allocations: [{ documentId: invoice.id, amountApplied: '4000' }],
    });

    const arAfter = await getAccountBalance(co.ctx, co.accountId('1130'));
    const bankAfter = await getAccountBalance(co.ctx, co.accountId('1120'));

    // AR falls, bank rises, by the same amount.
    assert.equal(Number(arBefore.balance) - Number(arAfter.balance), 4000);
    assert.equal(Number(bankAfter.balance) - Number(bankBefore.balance), 4000);

    const { document } = await getDocument(co.ctx, invoice.id);
    assert.equal(document.amountPaid, '4000');
    assert.equal(document.balanceDue, '0');
    assert.equal(document.status, 'paid');
  });

  test('a partial payment leaves the remaining balance outstanding', async () => {
    const invoice = await createDocument(co.ctx, {
      direction: 'outbound',
      documentType: 'invoice',
      contactId: customerId,
      issueDate: '2026-03-10',
      lines: [
        { description: 'Phase 1', quantity: '1', unitPrice: '9000', accountId: co.accountId('4100') },
      ],
    });
    await postDocument(co.ctx, invoice.id);

    await createPayment(co.ctx, {
      direction: 'receipt',
      contactId: customerId,
      paymentDate: '2026-03-12',
      amount: '3500',
      bankAccountId,
      allocations: [{ documentId: invoice.id, amountApplied: '3500' }],
    });

    const { document } = await getDocument(co.ctx, invoice.id);
    assert.equal(document.amountPaid, '3500');
    assert.equal(document.balanceDue, '5500');
    assert.equal(document.status, 'partially_paid');
  });

  test('over-allocating a payment to an invoice is refused', async () => {
    const invoice = await createDocument(co.ctx, {
      direction: 'outbound',
      documentType: 'invoice',
      contactId: customerId,
      issueDate: '2026-03-15',
      lines: [
        { description: 'Small job', quantity: '1', unitPrice: '250', accountId: co.accountId('4100') },
      ],
    });
    await postDocument(co.ctx, invoice.id);

    await assert.rejects(
      createPayment(co.ctx, {
        direction: 'receipt',
        contactId: customerId,
        paymentDate: '2026-03-16',
        amount: '1000',
        bankAccountId,
        allocations: [{ documentId: invoice.id, amountApplied: '1000' }],
      }),
      /only 250 is outstanding/,
    );
  });

  test('allocations cannot exceed the payment amount', async () => {
    const invoice = await createDocument(co.ctx, {
      direction: 'outbound',
      documentType: 'invoice',
      contactId: customerId,
      issueDate: '2026-03-17',
      lines: [
        { description: 'Job', quantity: '1', unitPrice: '5000', accountId: co.accountId('4100') },
      ],
    });
    await postDocument(co.ctx, invoice.id);

    await assert.rejects(
      createPayment(co.ctx, {
        direction: 'receipt',
        contactId: customerId,
        paymentDate: '2026-03-18',
        amount: '100',
        bankAccountId,
        allocations: [{ documentId: invoice.id, amountApplied: '500' }],
      }),
      /but the payment is only/,
    );
  });

  test('an unposted invoice cannot receive a payment', async () => {
    const draft = await createDocument(co.ctx, {
      direction: 'outbound',
      documentType: 'invoice',
      contactId: customerId,
      issueDate: '2026-03-19',
      lines: [
        { description: 'Not posted', quantity: '1', unitPrice: '400', accountId: co.accountId('4100') },
      ],
    });

    await assert.rejects(
      createPayment(co.ctx, {
        direction: 'receipt',
        contactId: customerId,
        paymentDate: '2026-03-20',
        amount: '400',
        bankAccountId,
        allocations: [{ documentId: draft.id, amountApplied: '400' }],
      }),
      /has not been posted yet/,
    );
  });

  test('an unapplied payment keeps its balance available', async () => {
    const payment = await createPayment(co.ctx, {
      direction: 'receipt',
      contactId: customerId,
      paymentDate: '2026-04-01',
      amount: '2000',
      bankAccountId,
      notes: 'Advance on account',
    });

    assert.equal(payment.allocatedAmount, '0');
    assert.equal(payment.unappliedAmount, '2000');
  });

  test('open documents are listed for allocation', async () => {
    const open = await listOpenDocuments(co.ctx, {
      contactId: customerId,
      direction: 'receipt',
    });
    assert.ok(open.length > 0);
    assert.ok(open.every((d) => Number(d.balanceDue) > 0));
  });

  test('voiding a payment restores the invoice balance', async () => {
    const invoice = await createDocument(co.ctx, {
      direction: 'outbound',
      documentType: 'invoice',
      contactId: customerId,
      issueDate: '2026-04-10',
      lines: [
        { description: 'To be unpaid', quantity: '1', unitPrice: '1200', accountId: co.accountId('4100') },
      ],
    });
    await postDocument(co.ctx, invoice.id);

    const payment = await createPayment(co.ctx, {
      direction: 'receipt',
      contactId: customerId,
      paymentDate: '2026-04-11',
      amount: '1200',
      bankAccountId,
      allocations: [{ documentId: invoice.id, amountApplied: '1200' }],
    });

    const paid = await getDocument(co.ctx, invoice.id);
    assert.equal(paid.document.status, 'paid');

    await voidPayment(co.ctx, payment.id, 'Cheque bounced');

    const restored = await getDocument(co.ctx, invoice.id);
    assert.equal(restored.document.balanceDue, '1200');
    assert.equal(restored.document.amountPaid, '0');

    // The allocation rows are gone…
    const remaining = await db
      .select()
      .from(paymentAllocations)
      .where(eq(paymentAllocations.paymentId, payment.id));
    assert.equal(remaining.length, 0);
  });

  test('a customer balance reflects outstanding invoices', async () => {
    const balance = await getContactBalance(co.ctx, customerId);
    assert.ok(Number(balance.outstanding) > 0);
    assert.ok(balance.documentCount > 0);
  });

  test('the aging report buckets by days overdue', async () => {
    const aging = await getAgingReport(co.ctx, { direction: 'outbound', asOf: '2026-06-30' });
    assert.ok(aging.length > 0);

    const row = aging.find((r) => r.contactId === customerId);
    assert.ok(row);
    // Every invoice above was issued well before the as-of date.
    assert.ok(Number(row!.total) > 0);

    // Buckets must add up to the total.
    const bucketSum =
      Number(row!.current) +
      Number(row!.days1to30) +
      Number(row!.days31to60) +
      Number(row!.days61to90) +
      Number(row!.days90plus);
    assert.equal(bucketSum, Number(row!.total));
  });

  test('voiding a posted invoice reverses its ledger effect', async () => {
    const invoice = await createDocument(co.ctx, {
      direction: 'outbound',
      documentType: 'invoice',
      contactId: customerId,
      issueDate: '2026-05-01',
      lines: [
        { description: 'Cancelled work', quantity: '1', unitPrice: '3000', accountId: co.accountId('4100') },
      ],
    });
    await postDocument(co.ctx, invoice.id);

    const arBefore = await getAccountBalance(co.ctx, co.accountId('1130'));

    await voidDocument(co.ctx, invoice.id, 'Client cancelled the engagement');

    const arAfter = await getAccountBalance(co.ctx, co.accountId('1130'));
    // The receivable is removed again.
    assert.equal(Number(arBefore.balance) - Number(arAfter.balance), 3000);

    const [row] = await db.select().from(documents).where(eq(documents.id, invoice.id));
    assert.equal(row?.status, 'void');
  });

  test('a paid invoice cannot be voided while payments are applied', async () => {
    const invoice = await createDocument(co.ctx, {
      direction: 'outbound',
      documentType: 'invoice',
      contactId: customerId,
      issueDate: '2026-05-10',
      lines: [
        { description: 'Paid work', quantity: '1', unitPrice: '800', accountId: co.accountId('4100') },
      ],
    });
    await postDocument(co.ctx, invoice.id);
    await createPayment(co.ctx, {
      direction: 'receipt',
      contactId: customerId,
      paymentDate: '2026-05-11',
      amount: '800',
      bankAccountId,
      allocations: [{ documentId: invoice.id, amountApplied: '800' }],
    });

    await assert.rejects(
      voidDocument(co.ctx, invoice.id, 'changed mind'),
      /has payments applied/,
    );
  });

  test('a credit note reverses the direction of an invoice', async () => {
    const arBefore = await getAccountBalance(co.ctx, co.accountId('1130'));

    const creditNote = await createDocument(co.ctx, {
      direction: 'outbound',
      documentType: 'credit_note',
      contactId: customerId,
      issueDate: '2026-05-20',
      lines: [
        { description: 'Goodwill credit', quantity: '1', unitPrice: '500', accountId: co.accountId('4100') },
      ],
    });
    await postDocument(co.ctx, creditNote.id);

    const arAfter = await getAccountBalance(co.ctx, co.accountId('1130'));
    // A credit note reduces what the customer owes.
    assert.equal(Number(arBefore.balance) - Number(arAfter.balance), 500);
  });

  test('every posted document produced a balanced journal entry', async () => {
    const rows = await db
      .select()
      .from(documents)
      .where(and(eq(documents.companyId, co.companyId)));

    const posted = rows.filter((r) => r.journalEntryId);
    assert.ok(posted.length > 0);

    for (const row of posted) {
      const totals = await db.query.journalEntries.findFirst({
        where: (e, { eq: equals }) => equals(e.id, row.journalEntryId!),
      });
      assert.ok(totals, `entry missing for ${row.documentNumber}`);
      assert.equal(
        Number(totals!.totalDebit),
        Number(totals!.totalCredit),
        `${row.documentNumber} is unbalanced`,
      );
    }
  });
});
