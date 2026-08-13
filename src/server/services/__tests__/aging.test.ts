/**
 * Point-in-time AR/AP aging.
 *
 * The audit's finding: `getAgingReport` used `asOf` for the bucket boundaries
 * but summed each document's *current* `balanceDue`, so a prior-period aging
 * blended one period's arithmetic with today's balances and reconciled to
 * nothing. The scenario below is the minimal proof — an invoice in one month
 * settled in the next — and it fails against the old query.
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import { closeDb } from '@/db';
import { ALL_PERMISSIONS } from '@/server/auth/permissions';
import { createContact, getAgingReport, getContactBalance } from '@/server/services/contact-service';
import { createDocument, postDocument } from '@/server/services/document-service';
import { createBankAccount } from '@/server/services/banking-service';
import { createPayment } from '@/server/services/payment-service';

import { createTestCompany, destroyTestCompany, type TestCompany } from './harness';

describe('point-in-time aging', () => {
  let co: TestCompany;
  let customerId: string;
  let bankAccountId: string;

  // Two months inside the calendar the harness generates, so the period
  // control is satisfied while the dates stay comfortably in the past.
  const year = new Date().getUTCFullYear();
  const juneIssue = `${year}-06-10`;
  const juneDue = `${year}-06-30`;
  const juneEnd = `${year}-06-30`;
  const julyPayment = `${year}-07-15`;
  const julyEnd = `${year}-07-31`;

  before(async () => {
    co = await createTestCompany({ permissions: ALL_PERMISSIONS });

    const customer = await createContact(co.ctx, {
      kind: 'customer',
      displayName: 'Aging Test Customer',
    });
    customerId = customer.id;

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

  test('an invoice paid in July is still outstanding in June aging', async () => {
    const invoice = await createDocument(co.ctx, {
      direction: 'outbound',
      documentType: 'invoice',
      contactId: customerId,
      issueDate: juneIssue,
      dueDate: juneDue,
      lines: [
        {
          description: 'June consulting',
          quantity: '1',
          unitPrice: '10000',
          accountId: co.accountId('4100'),
        },
      ],
    });
    await postDocument(co.approver, invoice.id);

    // Settled in full, but dated in July.
    await createPayment(co.ctx, {
      direction: 'receipt',
      contactId: customerId,
      paymentDate: julyPayment,
      amount: '10000',
      bankAccountId,
      allocations: [{ documentId: invoice.id, amountApplied: '10000' }],
    });

    // --- As at 30 June: the invoice was unpaid, and must still appear.
    const june = await getAgingReport(co.ctx, {
      direction: 'outbound',
      asOf: juneEnd,
    });
    const juneRow = june.find((r) => r.contactId === customerId);

    assert.ok(juneRow, 'the June aging lost an invoice that was outstanding on 30 June');
    assert.equal(
      Number(juneRow.total),
      10000,
      'June aging must show the invoice at its 30 June balance, not its balance today',
    );
    // Due 30 June, reported as at 30 June: not yet overdue.
    assert.equal(Number(juneRow.current), 10000);
    assert.equal(Number(juneRow.days1to30), 0);

    // --- As at 31 July: the payment has landed, so the invoice is gone.
    const july = await getAgingReport(co.ctx, {
      direction: 'outbound',
      asOf: julyEnd,
    });
    const julyRow = july.find((r) => r.contactId === customerId);
    assert.equal(
      julyRow,
      undefined,
      'an invoice settled by 31 July must not appear in the July aging',
    );
  });

  test('a partial payment reduces the balance only from its own date', async () => {
    // Its own customer: the report groups by contact, so sharing one customer
    // across tests would sum unrelated invoices into the same row.
    const { id: partialCustomerId } = await createContact(co.ctx, {
      kind: 'customer',
      displayName: 'Partial Payment Customer',
    });

    const invoice = await createDocument(co.ctx, {
      direction: 'outbound',
      documentType: 'invoice',
      contactId: partialCustomerId,
      issueDate: juneIssue,
      dueDate: juneDue,
      lines: [
        {
          description: 'June retainer',
          quantity: '1',
          unitPrice: '4000',
          accountId: co.accountId('4100'),
        },
      ],
    });
    await postDocument(co.approver, invoice.id);

    await createPayment(co.ctx, {
      direction: 'receipt',
      contactId: partialCustomerId,
      paymentDate: julyPayment,
      amount: '1500',
      bankAccountId,
      allocations: [{ documentId: invoice.id, amountApplied: '1500' }],
    });

    const june = await getAgingReport(co.ctx, { direction: 'outbound', asOf: juneEnd });
    const juneTotal = Number(june.find((r) => r.contactId === partialCustomerId)?.total ?? 0);
    assert.equal(juneTotal, 4000, 'the July part-payment must not reduce the June balance');

    const july = await getAgingReport(co.ctx, { direction: 'outbound', asOf: julyEnd });
    const julyTotal = Number(july.find((r) => r.contactId === partialCustomerId)?.total ?? 0);
    assert.equal(julyTotal, 2500, 'by 31 July only the unpaid remainder should age');
  });

  test('a document issued after the reporting date is excluded', async () => {
    const august = `${year}-08-05`;
    const { id: augustCustomerId } = await createContact(co.ctx, {
      kind: 'customer',
      displayName: 'August Customer',
    });

    const invoice = await createDocument(co.ctx, {
      direction: 'outbound',
      documentType: 'invoice',
      contactId: augustCustomerId,
      issueDate: august,
      dueDate: august,
      lines: [
        {
          description: 'August work',
          quantity: '1',
          unitPrice: '7777',
          accountId: co.accountId('4100'),
        },
      ],
    });
    await postDocument(co.approver, invoice.id);

    // As at 30 June this invoice did not exist. The old query included it,
    // because it filtered on balance rather than on issue date.
    const june = await getAgingReport(co.ctx, { direction: 'outbound', asOf: juneEnd });
    assert.equal(
      june.find((r) => r.contactId === augustCustomerId),
      undefined,
      'an invoice issued in August must not appear in a June aging',
    );

    // It does appear once the reporting date reaches it.
    const september = await getAgingReport(co.ctx, {
      direction: 'outbound',
      asOf: `${year}-09-30`,
    });
    assert.equal(
      Number(september.find((r) => r.contactId === augustCustomerId)?.total ?? 0),
      7777,
    );
  });

  test('a draft invoice never ages', async () => {
    const { id: draftCustomerId } = await createContact(co.ctx, {
      kind: 'customer',
      displayName: 'Draft Only Customer',
    });

    await createDocument(co.ctx, {
      direction: 'outbound',
      documentType: 'invoice',
      contactId: draftCustomerId,
      issueDate: juneIssue,
      dueDate: juneDue,
      lines: [
        {
          description: 'Unposted draft',
          quantity: '1',
          unitPrice: '999999',
          accountId: co.accountId('4100'),
        },
      ],
    });

    const june = await getAgingReport(co.ctx, { direction: 'outbound', asOf: juneEnd });
    assert.equal(
      june.find((r) => r.contactId === draftCustomerId),
      undefined,
      'a draft is not a receivable and must not appear in the aging',
    );
  });

  test('the contact balance agrees with the aging total as at the same date', async () => {
    // The two must be the same arithmetic, or a customer screen and the AR
    // report will disagree about what the customer owes.
    const aging = await getAgingReport(co.ctx, { direction: 'outbound', asOf: juneEnd });
    const agingTotal = Number(aging.find((r) => r.contactId === customerId)?.total ?? 0);

    const balance = await getContactBalance(co.ctx, customerId, { asOf: juneEnd });

    assert.equal(Number(balance.outstanding), agingTotal);
  });
});
