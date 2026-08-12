/**
 * Development seed: provisions a demo company with realistic activity.
 *
 * Everything here goes through the same services the application uses, so the
 * seed is also an end-to-end exercise of the engine — if seeding succeeds,
 * provisioning, posting, invoicing, payment allocation and reporting all work.
 * No number is written directly to the ledger.
 *
 * Demo data is clearly labelled and confined to its own organization, so it is
 * never mistaken for production records.
 */
import { config } from 'dotenv';

config({ path: '.env.local' });

import { eq } from 'drizzle-orm';

import { closeDb, db } from '@/db';
import { bankAccounts, companies, expenseCategories, organizations, taxes } from '@/db/schema';
import { resolveTenantContext } from '@/server/auth/context';
import { provisionCompany } from '@/server/services/company-service';
import { createContact } from '@/server/services/contact-service';
import { createDocument, postDocument } from '@/server/services/document-service';
import { createExpense, approveExpense } from '@/server/services/expense-service';
import { createJournalEntry } from '@/server/services/journal-service';
import { createPayment } from '@/server/services/payment-service';
import { createWorkflow } from '@/server/services/workflow-service';
import { createCustomField } from '@/server/services/custom-field-service';
import { getBalanceSheet, getProfitAndLoss, getTrialBalance } from '@/server/services/report-service';
import { accounts } from '@/db/schema';
import { and } from 'drizzle-orm';

const DEMO_ORG = 'Demo Organization';

async function accountIdByCode(companyId: string, code: string): Promise<string> {
  const [row] = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.companyId, companyId), eq(accounts.code, code)))
    .limit(1);
  if (!row) throw new Error(`Seed: account ${code} not found`);
  return row.id;
}

async function main() {
  const existing = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.name, DEMO_ORG))
    .limit(1);

  if (existing.length > 0) {
    console.log(
      'Demo organization already exists. Run `npm run db:reset` first if you want a clean seed.',
    );
    await closeDb();
    return;
  }

  console.log('Provisioning demo company…');

  const provisioned = await provisionCompany({
    organizationName: DEMO_ORG,
    companyName: 'Northwind Studio',
    legalName: 'Northwind Creative Studio LLC',
    baseCurrencyCode: 'USD',
    countryCode: 'US',
    coaTemplate: 'services',
    fiscalYearStartMonth: 1,
    owner: {
      name: 'Demo Owner',
      email: 'owner@demo.test',
      password: 'demo-password-123',
    },
    branches: [
      { code: 'HQ', name: 'Head Office' },
      { code: 'BR2', name: 'Downtown Branch' },
    ],
  });

  console.log(`  organization ${provisioned.organizationId}`);
  console.log(`  company      ${provisioned.companyId}`);
  console.log(`  accounts     ${provisioned.accountsCreated}`);

  const ctx = await resolveTenantContext({
    userId: provisioned.userId,
    companyId: provisioned.companyId,
  });

  const code = (c: string) => accountIdByCode(ctx.companyId, c);

  // --- Configuration -------------------------------------------------------
  const [salesTax] = await db
    .insert(taxes)
    .values({
      companyId: ctx.companyId,
      code: 'VAT10',
      name: 'Sales Tax 10%',
      ratePercent: '10',
      salesAccountId: await code('2120'),
      purchaseAccountId: await code('1150'),
    })
    .returning();

  const [bank] = await db
    .insert(bankAccounts)
    .values({
      companyId: ctx.companyId,
      name: 'Business Checking',
      accountKind: 'bank',
      bankName: 'First National',
      accountNumber: '****4471',
      currencyCode: 'USD',
      ledgerAccountId: await code('1120'),
    })
    .returning();

  await db.insert(bankAccounts).values({
    companyId: ctx.companyId,
    name: 'Petty Cash',
    accountKind: 'cash',
    currencyCode: 'USD',
    ledgerAccountId: await code('1110'),
  });

  const [travelCategory] = await db
    .insert(expenseCategories)
    .values({
      companyId: ctx.companyId,
      name: 'Travel',
      accountId: await code('6600'),
    })
    .returning();

  await db.insert(expenseCategories).values({
    companyId: ctx.companyId,
    name: 'Software',
    accountId: await code('6210'),
  });

  await createWorkflow(ctx, {
    documentType: 'invoice',
    name: 'Invoice approval',
    steps: [
      { name: 'Finance review', approverRoleKey: 'accountant' },
      { name: 'Management sign-off', approverRoleKey: 'owner', minAmount: '50000' },
    ],
  });

  await createCustomField(ctx, {
    entityType: 'invoice',
    key: 'campaign_code',
    label: 'Campaign Code',
    fieldType: 'text',
    showInList: true,
  });

  console.log('  configured taxes, banking, categories, workflow, custom field');

  // --- Opening balance -----------------------------------------------------
  await createJournalEntry(ctx, {
    entryDate: '2026-01-02',
    description: 'Opening capital contribution',
    lines: [
      { accountId: await code('1120'), debit: '150000' },
      { accountId: await code('3100'), credit: '150000' },
    ],
    post: true,
  });

  // --- Contacts ------------------------------------------------------------
  // Created sequentially, not with Promise.all: each allocates a code from the
  // same counter row, so running them concurrently would have them queue on
  // that lock anyway — and a conflict inside one transaction aborts it.
  const customers = [];
  for (const spec of [
    { displayName: 'Acme Corporation', email: 'ap@acme.test', paymentTermsDays: 30 },
    { displayName: 'Globex Industries', email: 'finance@globex.test', paymentTermsDays: 45 },
    { displayName: 'Initech LLC', email: 'billing@initech.test', paymentTermsDays: 15 },
  ]) {
    customers.push(await createContact(ctx, { kind: 'customer', ...spec }));
  }

  const vendors = [];
  for (const spec of [
    { displayName: 'Office Supplies Co', email: 'sales@officesupplies.test' },
    { displayName: 'Cloud Hosting Inc', email: 'billing@cloudhost.test' },
  ]) {
    vendors.push(await createContact(ctx, { kind: 'vendor', ...spec }));
  }

  console.log(`  ${customers.length} customers, ${vendors.length} vendors`);

  // --- Sales ---------------------------------------------------------------
  const revenueAccount = await code('4110'); // Consulting Revenue
  const invoices = [];

  const invoiceSpecs = [
    { customer: 0, date: '2026-01-15', desc: 'Brand strategy engagement', qty: '1', price: '45000' },
    { customer: 1, date: '2026-01-22', desc: 'Website redesign — phase 1', qty: '1', price: '28000' },
    { customer: 2, date: '2026-02-03', desc: 'Monthly retainer — February', qty: '1', price: '12000' },
    { customer: 0, date: '2026-02-14', desc: 'Campaign production', qty: '40', price: '350' },
    { customer: 1, date: '2026-03-01', desc: 'Website redesign — phase 2', qty: '1', price: '32000' },
    { customer: 2, date: '2026-03-12', desc: 'Monthly retainer — March', qty: '1', price: '12000' },
  ];

  for (const spec of invoiceSpecs) {
    const invoice = await createDocument(ctx, {
      direction: 'outbound',
      documentType: 'invoice',
      contactId: customers[spec.customer]!.id,
      issueDate: spec.date,
      lines: [
        {
          description: spec.desc,
          quantity: spec.qty,
          unitPrice: spec.price,
          accountId: revenueAccount,
          taxId: salesTax!.id,
        },
      ],
    });
    await postDocument(ctx, invoice.id);
    invoices.push(invoice);
  }

  console.log(`  ${invoices.length} invoices posted`);

  // --- Receipts: some paid in full, one partial, some outstanding ----------
  await createPayment(ctx, {
    direction: 'receipt',
    contactId: customers[0]!.id,
    paymentDate: '2026-02-10',
    amount: '49500',
    bankAccountId: bank!.id,
    method: 'bank_transfer',
    reference: 'WIRE-88213',
    allocations: [{ documentId: invoices[0]!.id, amountApplied: '49500' }],
  });

  await createPayment(ctx, {
    direction: 'receipt',
    contactId: customers[1]!.id,
    paymentDate: '2026-02-20',
    amount: '15000',
    bankAccountId: bank!.id,
    method: 'bank_transfer',
    allocations: [{ documentId: invoices[1]!.id, amountApplied: '15000' }],
  });

  await createPayment(ctx, {
    direction: 'receipt',
    contactId: customers[2]!.id,
    paymentDate: '2026-02-18',
    amount: '13200',
    bankAccountId: bank!.id,
    method: 'card',
    allocations: [{ documentId: invoices[2]!.id, amountApplied: '13200' }],
  });

  console.log('  3 customer receipts recorded');

  // --- Purchases -----------------------------------------------------------
  const bills = [];
  const billSpecs = [
    { vendor: 1, date: '2026-01-31', desc: 'Cloud hosting — January', price: '2400', account: '5110' },
    { vendor: 0, date: '2026-02-05', desc: 'Office supplies', price: '860', account: '6400' },
    { vendor: 1, date: '2026-02-28', desc: 'Cloud hosting — February', price: '2400', account: '5110' },
  ];

  for (const spec of billSpecs) {
    const bill = await createDocument(ctx, {
      direction: 'inbound',
      documentType: 'bill',
      contactId: vendors[spec.vendor]!.id,
      issueDate: spec.date,
      lines: [
        {
          description: spec.desc,
          quantity: '1',
          unitPrice: spec.price,
          accountId: await code(spec.account),
        },
      ],
    });
    await postDocument(ctx, bill.id);
    bills.push(bill);
  }

  await createPayment(ctx, {
    direction: 'disbursement',
    contactId: vendors[1]!.id,
    paymentDate: '2026-02-10',
    amount: '2400',
    bankAccountId: bank!.id,
    allocations: [{ documentId: bills[0]!.id, amountApplied: '2400' }],
  });

  console.log(`  ${bills.length} bills posted, 1 vendor payment`);

  // --- Operating costs and expenses ---------------------------------------
  for (const month of ['01', '02', '03']) {
    await createJournalEntry(ctx, {
      entryDate: `2026-${month}-28`,
      description: `Payroll and rent — 2026-${month}`,
      lines: [
        { accountId: await code('6100'), debit: '18000' },
        { accountId: await code('6200'), debit: '4500' },
        { accountId: await code('1120'), credit: '22500' },
      ],
      post: true,
    });
  }

  const expense = await createExpense(ctx, {
    categoryId: travelCategory!.id,
    expenseDate: '2026-03-05',
    description: 'Client visit — flights and hotel',
    amount: '1850',
    paymentAccountId: await code('1120'),
    submit: true,
  });
  await approveExpense(ctx, expense.id);

  await createExpense(ctx, {
    categoryId: travelCategory!.id,
    expenseDate: '2026-03-20',
    description: 'Conference registration (awaiting approval)',
    amount: '950',
    isReimbursable: true,
    submit: true,
  });

  console.log('  payroll entries, 1 approved expense, 1 pending expense');

  // --- Verify the seeded books are coherent --------------------------------
  const range = { from: '2026-01-01', to: '2026-12-31' };
  const tb = await getTrialBalance(ctx, range);
  const pl = await getProfitAndLoss(ctx, range);
  const bs = await getBalanceSheet(ctx, { asOf: '2026-12-31' });

  console.log('\nSeeded books:');
  console.log(`  trial balance   debits ${tb.totalDebit} = credits ${tb.totalCredit}  ${tb.isBalanced ? 'OK' : 'FAILED'}`);
  console.log(`  revenue         ${pl.totalRevenue}`);
  console.log(`  expenses        ${pl.totalExpenses}`);
  console.log(`  net profit      ${pl.netProfit}`);
  console.log(`  total assets    ${bs.totalAssets}`);
  console.log(`  liabilities+eq  ${bs.totalLiabilities} + ${bs.totalEquity}`);
  console.log(`  balance sheet   ${bs.isBalanced ? 'BALANCED' : `OUT BY ${bs.difference}`}`);

  if (!tb.isBalanced || !bs.isBalanced) {
    throw new Error('Seeded books do not balance — the engine has a bug.');
  }

  const [company] = await db
    .select({ name: companies.name })
    .from(companies)
    .where(eq(companies.id, ctx.companyId));

  console.log(`\nDone. Sign in as owner@demo.test / demo-password-123 (${company?.name}).`);
}

main()
  .then(() => closeDb())
  .catch(async (err) => {
    console.error('\nSeed failed:', err.message);
    if (err.cause) console.error('Cause:', err.cause);
    await closeDb();
    process.exit(1);
  });
