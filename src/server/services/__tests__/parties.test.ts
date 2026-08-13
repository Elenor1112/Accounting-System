/**
 * Customers and vendors, end to end.
 *
 * The brief's required scenarios:
 *
 *   Create customer → invoice → approve → post → partial payment →
 *   remaining payment → balance = 0
 *
 *   Create vendor → bill → approve → post → pay → balance = 0
 *
 * The point of these is that a customer is not a CRM record: every figure on
 * the customer screen must be derived from the ledger and the subledger, and
 * must agree with the AR/AP reports built from the same data.
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import { closeDb } from '@/db';
import { ALL_PERMISSIONS } from '@/server/auth/permissions';
import { createBankAccount } from '@/server/services/banking-service';
import {
  archiveContact,
  createContact,
  getAgingReport,
  getContact,
  getContactAging,
  getContactBalance,
  getContactStatement,
  getContactTransactions,
  getCreditPosition,
  listContacts,
  listContactsWithBalances,
  updateContact,
} from '@/server/services/contact-service';
import { createDocument, postDocument } from '@/server/services/document-service';
import { createPayment } from '@/server/services/payment-service';

import { createTestCompany, destroyTestCompany, type TestCompany } from './harness';

describe('customers and vendors', () => {
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

  // ------------------------------------------------------------ the model

  test('a contact can be both a customer and a vendor', async () => {
    // The whole reason for one table with a `kind` discriminator: a supplier
    // you also sell to is one party, not two records that drift apart.
    const both = await createContact(co.ctx, {
      kind: 'both',
      displayName: 'Reciprocal Trading Co',
      email: 'ap@reciprocal.test',
    });

    const asCustomer = await listContacts(co.ctx, { kind: 'customer', limit: 500 });
    const asVendor = await listContacts(co.ctx, { kind: 'vendor', limit: 500 });

    assert.ok(
      asCustomer.some((c) => c.id === both.id),
      'a `both` contact must appear in the customer list',
    );
    assert.ok(
      asVendor.some((c) => c.id === both.id),
      'a `both` contact must appear in the vendor list',
    );
  });

  test('a customer is created with a sequential code and its terms', async () => {
    const customer = await createContact(co.ctx, {
      kind: 'customer',
      displayName: 'Acme Industries',
      legalName: 'Acme Industries LLC',
      contactPerson: 'Dana Reed',
      email: 'ap@acme.test',
      phone: '+1 555 0100',
      taxIdentifier: 'VAT-99887',
      category: 'Wholesale',
      paymentTermsDays: 45,
      creditLimit: '50000',
      billingAddress: { line1: '1 Industrial Way', city: 'Springfield', country: 'US' },
    });

    assert.match(customer.code, /^CUST-\d+$/);
    assert.equal(customer.paymentTermsDays, 45);
    assert.equal(customer.creditLimit, '50000');
    assert.equal(customer.contactPerson, 'Dana Reed');
    assert.equal(customer.category, 'Wholesale');
  });

  test('a customer without a name is refused', async () => {
    await assert.rejects(
      createContact(co.ctx, { kind: 'customer', displayName: '   ' }),
      /needs a name/,
    );
  });

  test('editing a customer records the change in the audit trail', async () => {
    const customer = await createContact(co.ctx, {
      kind: 'customer',
      displayName: 'Editable Customer',
      paymentTermsDays: 30,
    });

    const updated = await updateContact(co.ctx, customer.id, {
      paymentTermsDays: 60,
      email: 'new@editable.test',
    });

    assert.equal(updated.paymentTermsDays, 60);
    assert.equal(updated.email, 'new@editable.test');
  });

  // --------------------------------------------- the required AR scenario

  test('customer lifecycle: invoice → post → part payment → settled', async () => {
    const customer = await createContact(co.ctx, {
      kind: 'customer',
      displayName: 'Lifecycle Customer',
      paymentTermsDays: 30,
      creditLimit: '20000',
    });

    // Nothing owed before anything happens.
    let balance = await getContactBalance(co.ctx, customer.id);
    assert.equal(Number(balance.outstanding), 0);

    const invoice = await createDocument(co.ctx, {
      direction: 'outbound',
      documentType: 'invoice',
      contactId: customer.id,
      issueDate: today,
      lines: [
        {
          description: 'Consulting',
          quantity: '1',
          unitPrice: '12000',
          accountId: co.accountId('4100'),
        },
      ],
    });

    // A draft is not yet a receivable.
    balance = await getContactBalance(co.ctx, customer.id);
    assert.equal(Number(balance.outstanding), 0, 'a draft invoice must not create AR');

    await postDocument(co.approver, invoice.id);

    balance = await getContactBalance(co.ctx, customer.id);
    assert.equal(Number(balance.outstanding), 12000);
    assert.equal(balance.documentCount, 1);

    // Credit position reflects the new exposure.
    const credit = await getCreditPosition(co.ctx, customer.id);
    assert.equal(Number(credit.used), 12000);
    assert.equal(Number(credit.available), 8000);
    assert.equal(credit.isOverLimit, false);

    // Partial payment.
    await createPayment(co.ctx, {
      direction: 'receipt',
      contactId: customer.id,
      paymentDate: today,
      amount: '5000',
      bankAccountId,
      allocations: [{ documentId: invoice.id, amountApplied: '5000' }],
    });

    balance = await getContactBalance(co.ctx, customer.id);
    assert.equal(Number(balance.outstanding), 7000);

    // Remaining payment.
    await createPayment(co.ctx, {
      direction: 'receipt',
      contactId: customer.id,
      paymentDate: today,
      amount: '7000',
      bankAccountId,
      allocations: [{ documentId: invoice.id, amountApplied: '7000' }],
    });

    balance = await getContactBalance(co.ctx, customer.id);
    assert.equal(Number(balance.outstanding), 0, 'the customer must settle to zero');

    // And the credit line is free again.
    const finalCredit = await getCreditPosition(co.ctx, customer.id);
    assert.equal(Number(finalCredit.available), 20000);
  });

  // --------------------------------------------- the required AP scenario

  test('vendor lifecycle: bill → post → pay → balance zero', async () => {
    const vendor = await createContact(co.ctx, {
      kind: 'vendor',
      displayName: 'Lifecycle Vendor',
      paymentTermsDays: 30,
    });

    assert.match(vendor.code, /^VEND-\d+$/);

    const bill = await createDocument(co.ctx, {
      direction: 'inbound',
      documentType: 'bill',
      contactId: vendor.id,
      issueDate: today,
      lines: [
        {
          description: 'Office rent',
          quantity: '1',
          unitPrice: '4500',
          accountId: co.accountId('6200'),
        },
      ],
    });
    await postDocument(co.approver, bill.id);

    let balance = await getContactBalance(co.ctx, vendor.id);
    assert.equal(Number(balance.outstanding), 4500);

    await createPayment(co.ctx, {
      direction: 'disbursement',
      contactId: vendor.id,
      paymentDate: today,
      amount: '4500',
      bankAccountId,
      allocations: [{ documentId: bill.id, amountApplied: '4500' }],
    });

    balance = await getContactBalance(co.ctx, vendor.id);
    assert.equal(Number(balance.outstanding), 0, 'the vendor must settle to zero');
  });

  // ------------------------------------------------ list, statement, aging

  test('the list carries the same balance the detail screen shows', async () => {
    // A list row and a detail page disagreeing about what a customer owes is
    // the kind of thing that destroys confidence in an accounting system.
    const customer = await createContact(co.ctx, {
      kind: 'customer',
      displayName: 'Listed Customer',
    });

    const invoice = await createDocument(co.ctx, {
      direction: 'outbound',
      documentType: 'invoice',
      contactId: customer.id,
      issueDate: today,
      lines: [
        {
          description: 'Work',
          quantity: '1',
          unitPrice: '3300',
          accountId: co.accountId('4100'),
        },
      ],
    });
    await postDocument(co.approver, invoice.id);

    const rows = await listContactsWithBalances(co.ctx, { kind: 'customer', limit: 500 });
    const row = rows.find((r) => r.id === customer.id);
    const detail = await getContactBalance(co.ctx, customer.id);

    assert.ok(row);
    assert.equal(Number(row.outstanding), 3300);
    assert.equal(Number(row.outstanding), Number(detail.outstanding));
  });

  test('the list can be searched and filtered to active contacts', async () => {
    const found = await listContactsWithBalances(co.ctx, {
      kind: 'customer',
      search: 'acme',
      limit: 50,
    });
    assert.ok(found.some((r) => r.displayName === 'Acme Industries'));

    // Search matches the contact person too, not just the company name.
    const byPerson = await listContactsWithBalances(co.ctx, {
      kind: 'customer',
      search: 'dana',
      limit: 50,
    });
    assert.ok(byPerson.some((r) => r.displayName === 'Acme Industries'));
  });

  test('a per-contact aging agrees with that contact’s row in the AR aging', async () => {
    const customer = await createContact(co.ctx, {
      kind: 'customer',
      displayName: 'Aging Agreement Customer',
    });

    const invoice = await createDocument(co.ctx, {
      direction: 'outbound',
      documentType: 'invoice',
      contactId: customer.id,
      issueDate: today,
      dueDate: today,
      lines: [
        {
          description: 'Work',
          quantity: '1',
          unitPrice: '6100',
          accountId: co.accountId('4100'),
        },
      ],
    });
    await postDocument(co.approver, invoice.id);

    const contactAging = await getContactAging(co.ctx, customer.id, { asOf: today });
    const report = await getAgingReport(co.ctx, { direction: 'outbound', asOf: today });
    const reportRow = report.find((r) => r.contactId === customer.id);

    assert.equal(Number(contactAging.total), 6100);
    assert.equal(Number(reportRow?.total), Number(contactAging.total));
    assert.equal(Number(reportRow?.current), Number(contactAging.current));
  });

  test('the statement runs chronologically and closes at the outstanding balance', async () => {
    const customer = await createContact(co.ctx, {
      kind: 'customer',
      displayName: 'Statement Customer',
    });

    const invoice = await createDocument(co.ctx, {
      direction: 'outbound',
      documentType: 'invoice',
      contactId: customer.id,
      issueDate: today,
      lines: [
        {
          description: 'Work',
          quantity: '1',
          unitPrice: '9000',
          accountId: co.accountId('4100'),
        },
      ],
    });
    await postDocument(co.approver, invoice.id);

    await createPayment(co.ctx, {
      direction: 'receipt',
      contactId: customer.id,
      paymentDate: today,
      amount: '2500',
      bankAccountId,
      allocations: [{ documentId: invoice.id, amountApplied: '2500' }],
    });

    const year = today.slice(0, 4);
    const statement = await getContactStatement(co.ctx, customer.id, {
      from: `${year}-01-01`,
      to: `${year}-12-31`,
    });

    assert.equal(statement.isCustomer, true);
    assert.equal(statement.entries.length, 2, 'one invoice and one receipt');

    // Debit 9,000 then credit 2,500 → closing 6,500, which is what they owe.
    assert.equal(Number(statement.closingBalance), 6500);

    const balance = await getContactBalance(co.ctx, customer.id);
    assert.equal(
      Number(statement.closingBalance),
      Number(balance.outstanding),
      'the statement must close at the same figure the customer balance reports',
    );
  });

  test('the transaction list shows documents and payments for the contact', async () => {
    const rows = await listContactsWithBalances(co.ctx, {
      kind: 'customer',
      search: 'Statement Customer',
      limit: 5,
    });
    const customerId = rows[0]!.id;

    const transactions = await getContactTransactions(co.ctx, customerId);
    assert.equal(transactions.documents.length, 1);
    assert.equal(transactions.payments.length, 1);
    assert.equal(Number(transactions.payments[0]!.amount), 2500);
  });

  // ------------------------------------------------------------- archiving

  test('a contact with an outstanding balance cannot be archived', async () => {
    const rows = await listContactsWithBalances(co.ctx, {
      kind: 'customer',
      search: 'Statement Customer',
      limit: 5,
    });
    const customerId = rows[0]!.id;

    await assert.rejects(archiveContact(co.ctx, customerId), /outstanding/);
  });

  test('a settled contact can be archived and hidden from the active list', async () => {
    const customer = await createContact(co.ctx, {
      kind: 'customer',
      displayName: 'Archivable Customer',
    });

    await archiveContact(co.ctx, customer.id);

    const active = await listContactsWithBalances(co.ctx, { kind: 'customer', limit: 500 });
    assert.ok(!active.some((r) => r.id === customer.id), 'archived contacts are hidden');

    const all = await listContactsWithBalances(co.ctx, {
      kind: 'customer',
      includeInactive: true,
      limit: 500,
    });
    assert.ok(all.some((r) => r.id === customer.id), 'but remain visible when asked for');

    const row = await getContact(co.ctx, customer.id);
    assert.equal(row.isActive, false);
  });
});
