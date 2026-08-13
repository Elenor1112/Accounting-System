/**
 * Customer advances, bad-debt write-offs and refunds.
 *
 * These cover the audit's finding that "overpayments, write-offs and refunds
 * have no path": an overpaid customer left a credit balance sitting inside
 * Accounts Receivable, presenting a liability as a negative asset, and there
 * was no way to write off a bad debt or return money held on account.
 *
 * Every assertion checks the ledger, because the point of each of these is
 * *which account* the money lands in, not whether a function returned.
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import { and, eq } from 'drizzle-orm';

import { closeDb, db } from '@/db';
import { documents, journalEntries, journalLines } from '@/db/schema';
import { ALL_PERMISSIONS } from '@/server/auth/permissions';
import { createBankAccount } from '@/server/services/banking-service';
import { createContact } from '@/server/services/contact-service';
import {
  createDocument,
  postDocument,
  writeOffDocument,
} from '@/server/services/document-service';
import { getAccountBalance } from '@/server/services/journal-service';
import {
  allocatePayment,
  createPayment,
  refundContact,
} from '@/server/services/payment-service';

import { createTestCompany, destroyTestCompany, type TestCompany } from './harness';

describe('advances, write-offs and refunds', () => {
  let co: TestCompany;
  let bankAccountId: string;

  const today = new Date().toISOString().slice(0, 10);

  before(async () => {
    co = await createTestCompany({ permissions: ALL_PERMISSIONS });
    const bank = await createBankAccount(co.ctx, {
      name: 'Main Account',
      ledgerAccountId: co.accountId('1120'),
      currencyCode: 'USD',
    });
    bankAccountId = bank.id;
  });

  after(async () => {
    await destroyTestCompany(co);
    await closeDb();
  });

  async function customer(name: string) {
    const c = await createContact(co.ctx, { kind: 'customer', displayName: name });
    return c.id;
  }

  async function postedInvoice(contactId: string, total: string) {
    const invoice = await createDocument(co.ctx, {
      direction: 'outbound',
      documentType: 'invoice',
      contactId,
      issueDate: today,
      lines: [
        {
          description: 'Services',
          quantity: '1',
          unitPrice: total,
          accountId: co.accountId('4100'),
        },
      ],
    });
    await postDocument(co.approver, invoice.id);
    return invoice;
  }

  /** Net movement on an account across this company's whole ledger. */
  async function balanceOf(code: string) {
    const b = await getAccountBalance(co.ctx, co.accountId(code));
    return Number(b.balance);
  }

  // ------------------------------------------------------- customer advances

  test('an overpayment credits Customer Advances, not Accounts Receivable', async () => {
    const contactId = await customer('Overpaying Customer');
    const invoice = await postedInvoice(contactId, '10000');

    const arBefore = await balanceOf('1130');
    const advancesBefore = await balanceOf('2140');

    // Pays 12,000 against a 10,000 invoice — the brief's scenario.
    await createPayment(co.ctx, {
      direction: 'receipt',
      contactId,
      paymentDate: today,
      amount: '12000',
      bankAccountId,
      allocations: [{ documentId: invoice.id, amountApplied: '10000' }],
    });

    const arAfter = await balanceOf('1130');
    const advancesAfter = await balanceOf('2140');

    // AR falls by exactly the invoice, and no further: the extra 2,000 must
    // not create a credit balance inside a receivable.
    assert.equal(
      arAfter - arBefore,
      -10000,
      'AR must be relieved by the invoice amount only',
    );

    // The 2,000 lands in Customer Advances as a liability (credit-normal, so a
    // positive balance).
    assert.equal(
      advancesAfter - advancesBefore,
      2000,
      'the unapplied 2,000 must be held as a customer advance',
    );

    // The invoice itself is settled.
    const [row] = await db.select().from(documents).where(eq(documents.id, invoice.id));
    assert.equal(Number(row?.balanceDue), 0);
    assert.equal(row?.status, 'paid');
  });

  test('an entirely unapplied receipt goes wholly to advances', async () => {
    const contactId = await customer('Prepaying Customer');

    const arBefore = await balanceOf('1130');
    const advancesBefore = await balanceOf('2140');

    // Money on account before any invoice exists.
    await createPayment(co.ctx, {
      direction: 'receipt',
      contactId,
      paymentDate: today,
      amount: '5000',
      bankAccountId,
    });

    assert.equal(
      (await balanceOf('1130')) - arBefore,
      0,
      'a receipt settling nothing must not touch AR at all',
    );
    assert.equal((await balanceOf('2140')) - advancesBefore, 5000);
  });

  test('applying an advance moves it from the liability to AR', async () => {
    const contactId = await customer('Advance Then Invoice Customer');

    const payment = await createPayment(co.ctx, {
      direction: 'receipt',
      contactId,
      paymentDate: today,
      amount: '3000',
      bankAccountId,
    });

    const invoice = await postedInvoice(contactId, '3000');

    const arBefore = await balanceOf('1130');
    const advancesBefore = await balanceOf('2140');

    await allocatePayment(co.ctx, payment.id, [
      { documentId: invoice.id, amountApplied: '3000' },
    ]);

    // Dr Customer Advances / Cr Accounts Receivable — the liability is
    // discharged and the receivable clears with it.
    assert.equal(
      (await balanceOf('2140')) - advancesBefore,
      -3000,
      'applying the advance must discharge the liability',
    );
    assert.equal(
      (await balanceOf('1130')) - arBefore,
      -3000,
      'applying the advance must relieve the receivable',
    );

    const [row] = await db.select().from(documents).where(eq(documents.id, invoice.id));
    assert.equal(Number(row?.balanceDue), 0);
  });

  // ------------------------------------------------------------- write-offs

  test('a bad debt write-off debits the expense and clears the receivable', async () => {
    const contactId = await customer('Uncollectible Customer');
    const invoice = await postedInvoice(contactId, '4000');

    const arBefore = await balanceOf('1130');
    const badDebtBefore = await balanceOf('6650');

    const result = await writeOffDocument(co.approver, invoice.id, {
      reason: 'Customer entered liquidation; no prospect of recovery',
    });

    assert.equal(result.amount, '4000');

    // Dr Bad Debt Expense / Cr Accounts Receivable.
    assert.equal((await balanceOf('6650')) - badDebtBefore, 4000);
    assert.equal((await balanceOf('1130')) - arBefore, -4000);

    // The document records the loss rather than pretending it was paid.
    const [row] = await db.select().from(documents).where(eq(documents.id, invoice.id));
    assert.equal(row?.status, 'written_off');
    assert.equal(Number(row?.balanceDue), 0);

    // And the entry is linked to the document it wrote off, so the write-off
    // can be traced from the invoice rather than floating unattached.
    const [entry] = await db
      .select()
      .from(journalEntries)
      .where(eq(journalEntries.id, result.journalEntryId));
    assert.equal(entry?.sourceType, 'write_off');
    assert.equal(entry?.sourceId, invoice.id);

    // The customer is carried on the lines, so the subledger stays traceable.
    const lines = await db
      .select()
      .from(journalLines)
      .where(eq(journalLines.entryId, result.journalEntryId));
    assert.ok(lines.some((l) => l.customerId === contactId));
  });

  test('a partially paid invoice writes off only the remaining balance', async () => {
    const contactId = await customer('Partial Then Written Off');
    const invoice = await postedInvoice(contactId, '5000');

    await createPayment(co.ctx, {
      direction: 'receipt',
      contactId,
      paymentDate: today,
      amount: '2000',
      bankAccountId,
      allocations: [{ documentId: invoice.id, amountApplied: '2000' }],
    });

    const badDebtBefore = await balanceOf('6650');
    const result = await writeOffDocument(co.approver, invoice.id, {
      reason: 'Balance uncollectible after part payment',
    });

    assert.equal(result.amount, '3000', 'only the unpaid remainder may be written off');
    assert.equal((await balanceOf('6650')) - badDebtBefore, 3000);
  });

  test('a write-off requires a reason and a posted document', async () => {
    const contactId = await customer('Draft Only');
    const draft = await createDocument(co.ctx, {
      direction: 'outbound',
      documentType: 'invoice',
      contactId,
      issueDate: today,
      lines: [
        {
          description: 'Services',
          quantity: '1',
          unitPrice: '100',
          accountId: co.accountId('4100'),
        },
      ],
    });

    await assert.rejects(
      writeOffDocument(co.approver, draft.id, { reason: '  ' }),
      /reason is required/,
    );
    await assert.rejects(
      writeOffDocument(co.approver, draft.id, { reason: 'Cannot pay' }),
      /has not been posted/,
    );
  });

  test('an already-settled invoice cannot be written off', async () => {
    const contactId = await customer('Fully Paid Customer');
    const invoice = await postedInvoice(contactId, '1000');
    await createPayment(co.ctx, {
      direction: 'receipt',
      contactId,
      paymentDate: today,
      amount: '1000',
      bankAccountId,
      allocations: [{ documentId: invoice.id, amountApplied: '1000' }],
    });

    await assert.rejects(
      writeOffDocument(co.approver, invoice.id, { reason: 'Mistake' }),
      /no outstanding balance/,
    );
  });

  // ---------------------------------------------------------------- refunds

  test('a refund returns money held on account and clears the advance', async () => {
    const contactId = await customer('Refunded Customer');

    await createPayment(co.ctx, {
      direction: 'receipt',
      contactId,
      paymentDate: today,
      amount: '2500',
      bankAccountId,
    });

    const advancesBefore = await balanceOf('2140');
    const bankBefore = await balanceOf('1120');

    const refund = await refundContact(co.ctx, {
      contactId,
      bankAccountId,
      amount: '2500',
      refundDate: today,
      reference: 'Refund of deposit',
    });

    assert.ok(refund.journalEntryId);

    // Dr Customer Advances / Cr Bank — the liability is discharged and the
    // money leaves.
    assert.equal((await balanceOf('2140')) - advancesBefore, -2500);
    assert.equal((await balanceOf('1120')) - bankBefore, -2500);
  });

  test('a refund cannot exceed the amount actually held on account', async () => {
    const contactId = await customer('Small Deposit Customer');

    await createPayment(co.ctx, {
      direction: 'receipt',
      contactId,
      paymentDate: today,
      amount: '400',
      bankAccountId,
    });

    await assert.rejects(
      refundContact(co.ctx, {
        contactId,
        bankAccountId,
        amount: '900',
        refundDate: today,
      }),
      /only 400 is held on account/,
    );
  });

  test('a customer with no advance cannot be refunded', async () => {
    const contactId = await customer('Nothing Held Customer');

    await assert.rejects(
      refundContact(co.ctx, {
        contactId,
        bankAccountId,
        amount: '100',
        refundDate: today,
      }),
      /only 0 is held on account/,
    );
  });

  // --------------------------------------------------------- ledger health

  test('every entry created by these flows balances', async () => {
    const entries = await db
      .select()
      .from(journalEntries)
      .where(
        and(
          eq(journalEntries.companyId, co.companyId),
          eq(journalEntries.status, 'posted'),
        ),
      );

    assert.ok(entries.length > 0);
    for (const entry of entries) {
      assert.equal(
        entry.totalDebit,
        entry.totalCredit,
        `entry ${entry.entryNumber} does not balance`,
      );
    }
  });
});
