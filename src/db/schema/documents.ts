import { relations, sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { amount, documentStatusEnum, primaryKeyId, rate, timestamps } from './_shared';
import { contacts } from './contacts';
import { users } from './identity';
import { accounts, journalEntries } from './ledger';
import { branches, companies } from './tenancy';

/**
 * Invoices and bills share this table, discriminated by `direction`.
 *
 * An invoice (sale, `outbound`) and a bill (purchase, `inbound`) have the same
 * shape — a counterparty, dated lines, tax, a running balance — and differ
 * only in which control account they post to and which way the money flows.
 * One table keeps the numbering, tax, allocation and aging logic single rather
 * than duplicated and drifting apart.
 */
export const documents = pgTable(
  'documents',
  {
    id: primaryKeyId(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    branchId: uuid('branch_id').references(() => branches.id, { onDelete: 'restrict' }),

    /** `outbound` = invoice/credit note (AR); `inbound` = bill/debit note (AP). */
    direction: text('direction', { enum: ['outbound', 'inbound'] }).notNull(),
    /** `invoice`, `bill`, `credit_note`, `debit_note`, `quote`, `purchase_order`. */
    documentType: text('document_type').notNull(),

    documentNumber: text('document_number').notNull(),
    contactId: uuid('contact_id').notNull(),

    issueDate: date('issue_date').notNull(),
    dueDate: date('due_date'),

    currencyCode: text('currency_code').notNull(),
    exchangeRate: rate('exchange_rate').notNull().default('1'),

    /** Totals in transaction currency, computed from lines by the service. */
    subtotal: amount('subtotal').notNull().default('0'),
    discountTotal: amount('discount_total').notNull().default('0'),
    taxTotal: amount('tax_total').notNull().default('0'),
    total: amount('total').notNull().default('0'),
    /** Settled so far, maintained by payment allocations. */
    amountPaid: amount('amount_paid').notNull().default('0'),
    /** `total - amountPaid`. Stored so aging queries need no per-row subquery. */
    balanceDue: amount('balance_due').notNull().default('0'),

    status: documentStatusEnum('status').notNull().default('draft'),

    reference: text('reference'),
    notes: text('notes'),
    terms: text('terms'),
    attachments: jsonb('attachments').notNull().default([]),

    /** The posting this document produced; null until posted. */
    journalEntryId: uuid('journal_entry_id').references(() => journalEntries.id, {
      onDelete: 'restrict',
    }),

    createdById: uuid('created_by_id').references(() => users.id, { onDelete: 'set null' }),
    approvedById: uuid('approved_by_id').references(() => users.id, { onDelete: 'set null' }),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    voidedAt: timestamp('voided_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('documents_company_number_key').on(t.companyId, t.documentType, t.documentNumber),
    // Drives list views, aging, and the "open items" lookup when allocating.
    index('documents_company_status_idx').on(
      t.companyId,
      t.direction,
      t.status,
      t.issueDate,
    ),
    index('documents_contact_idx').on(t.companyId, t.contactId, t.status),
    index('documents_due_idx').on(t.companyId, t.direction, t.dueDate),
    foreignKey({
      columns: [t.contactId, t.companyId],
      foreignColumns: [contacts.id, contacts.companyId],
      name: 'documents_contact_company_fk',
    }).onDelete('restrict'),
    check('documents_total_nonneg_ck', sql`${t.total} >= 0`),
    check(
      'documents_paid_not_over_total_ck',
      sql`${t.amountPaid} <= ${t.total} + 0.000001`,
    ),
    unique('documents_id_company_key').on(t.id, t.companyId),
  ],
);

export const documentLines = pgTable(
  'document_lines',
  {
    id: primaryKeyId(),
    companyId: uuid('company_id').notNull(),
    documentId: uuid('document_id').notNull(),
    lineNumber: integer('line_number').notNull(),

    description: text('description').notNull(),
    quantity: amount('quantity').notNull().default('1'),
    unitPrice: amount('unit_price').notNull().default('0'),

    /** Either a percentage or a fixed amount, per `discountType`. */
    discountType: text('discount_type', { enum: ['none', 'percent', 'amount'] })
      .notNull()
      .default('none'),
    discountValue: amount('discount_value').notNull().default('0'),
    discountAmount: amount('discount_amount').notNull().default('0'),

    taxId: uuid('tax_id'),
    taxRatePercent: amount('tax_rate_percent').notNull().default('0'),
    taxAmount: amount('tax_amount').notNull().default('0'),

    /** Revenue account for a sale; expense/asset account for a purchase. */
    accountId: uuid('account_id').notNull(),

    lineSubtotal: amount('line_subtotal').notNull().default('0'),
    lineTotal: amount('line_total').notNull().default('0'),

    branchId: uuid('branch_id').references(() => branches.id, { onDelete: 'restrict' }),
    projectId: uuid('project_id'),
    ...timestamps,
  },
  (t) => [
    index('document_lines_document_idx').on(t.documentId, t.lineNumber),
    foreignKey({
      columns: [t.documentId, t.companyId],
      foreignColumns: [documents.id, documents.companyId],
      name: 'document_lines_document_company_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.accountId, t.companyId],
      foreignColumns: [accounts.id, accounts.companyId],
      name: 'document_lines_account_company_fk',
    }).onDelete('restrict'),
    check('document_lines_qty_ck', sql`${t.quantity} <> 0`),
  ],
);

/**
 * Bank and cash accounts (spec §15).
 *
 * This is the operational record — name, number, opening balance. The *money*
 * lives in the linked ledger account; a balance shown to the user is always
 * summed from journal lines, never stored and incremented here. That is what
 * "no fake balance manipulation" means in practice.
 */
export const bankAccounts = pgTable(
  'bank_accounts',
  {
    id: primaryKeyId(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    branchId: uuid('branch_id').references(() => branches.id, { onDelete: 'restrict' }),

    name: text('name').notNull(),
    accountKind: text('account_kind', { enum: ['bank', 'cash', 'card'] })
      .notNull()
      .default('bank'),
    bankName: text('bank_name'),
    accountNumber: text('account_number'),
    iban: text('iban'),
    swift: text('swift'),

    currencyCode: text('currency_code').notNull(),
    /** The GL account this instrument maps to. */
    ledgerAccountId: uuid('ledger_account_id').notNull(),

    openingBalance: amount('opening_balance').notNull().default('0'),
    openingDate: date('opening_date'),

    isActive: boolean('is_active').notNull().default(true),
    ...timestamps,
  },
  (t) => [
    index('bank_accounts_company_idx').on(t.companyId, t.isActive),
    foreignKey({
      columns: [t.ledgerAccountId, t.companyId],
      foreignColumns: [accounts.id, accounts.companyId],
      name: 'bank_accounts_ledger_company_fk',
    }).onDelete('restrict'),
    unique('bank_accounts_id_company_key').on(t.id, t.companyId),
  ],
);

/**
 * A payment received from a customer or made to a vendor (spec §11).
 *
 * A payment exists independently of the documents it settles: it may be
 * allocated across several invoices, or sit unapplied as a customer credit.
 * `unappliedAmount` is what remains to allocate.
 */
export const payments = pgTable(
  'payments',
  {
    id: primaryKeyId(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    branchId: uuid('branch_id').references(() => branches.id, { onDelete: 'restrict' }),

    /** `receipt` = money in (from customer); `disbursement` = money out. */
    direction: text('direction', { enum: ['receipt', 'disbursement'] }).notNull(),
    paymentNumber: text('payment_number').notNull(),
    contactId: uuid('contact_id'),

    paymentDate: date('payment_date').notNull(),
    /** `cash`, `bank_transfer`, `card`, `cheque`, `online`, or a custom label. */
    method: text('method').notNull().default('bank_transfer'),
    reference: text('reference'),

    currencyCode: text('currency_code').notNull(),
    exchangeRate: rate('exchange_rate').notNull().default('1'),
    amount: amount('amount').notNull(),
    allocatedAmount: amount('allocated_amount').notNull().default('0'),
    unappliedAmount: amount('unapplied_amount').notNull().default('0'),

    bankAccountId: uuid('bank_account_id'),

    status: text('status', { enum: ['draft', 'posted', 'void'] })
      .notNull()
      .default('draft'),
    journalEntryId: uuid('journal_entry_id').references(() => journalEntries.id, {
      onDelete: 'restrict',
    }),

    notes: text('notes'),
    createdById: uuid('created_by_id').references(() => users.id, { onDelete: 'set null' }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('payments_company_number_key').on(t.companyId, t.paymentNumber),
    index('payments_company_date_idx').on(t.companyId, t.direction, t.paymentDate),
    index('payments_contact_idx').on(t.companyId, t.contactId),
    foreignKey({
      columns: [t.bankAccountId, t.companyId],
      foreignColumns: [bankAccounts.id, bankAccounts.companyId],
      name: 'payments_bank_account_company_fk',
    }).onDelete('restrict'),
    check('payments_amount_positive_ck', sql`${t.amount} > 0`),
    /** Cannot allocate more than was received (spec §32). */
    check(
      'payments_allocation_within_amount_ck',
      sql`${t.allocatedAmount} <= ${t.amount} + 0.000001`,
    ),
    unique('payments_id_company_key').on(t.id, t.companyId),
  ],
);

/**
 * Links a payment to a document it settles. The service enforces that the sum
 * of allocations never exceeds either the payment amount or the document
 * balance — the two invariants from spec §32 that keep AR/AP honest.
 */
export const paymentAllocations = pgTable(
  'payment_allocations',
  {
    id: primaryKeyId(),
    companyId: uuid('company_id').notNull(),
    paymentId: uuid('payment_id').notNull(),
    documentId: uuid('document_id').notNull(),
    /** In the document's currency. */
    amountApplied: amount('amount_applied').notNull(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('payment_allocations_unique_key').on(t.paymentId, t.documentId),
    index('payment_allocations_document_idx').on(t.documentId),
    foreignKey({
      columns: [t.paymentId, t.companyId],
      foreignColumns: [payments.id, payments.companyId],
      name: 'payment_allocations_payment_company_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.documentId, t.companyId],
      foreignColumns: [documents.id, documents.companyId],
      name: 'payment_allocations_document_company_fk',
    }).onDelete('restrict'),
    check('payment_allocations_positive_ck', sql`${t.amountApplied} > 0`),
  ],
);

export const expenseCategories = pgTable(
  'expense_categories',
  {
    id: primaryKeyId(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** The expense account postings land in. */
    accountId: uuid('account_id').notNull(),
    isActive: boolean('is_active').notNull().default(true),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('expense_categories_company_name_key').on(t.companyId, t.name),
    foreignKey({
      columns: [t.accountId, t.companyId],
      foreignColumns: [accounts.id, accounts.companyId],
      name: 'expense_categories_account_company_fk',
    }).onDelete('restrict'),
    unique('expense_categories_id_company_key').on(t.id, t.companyId),
  ],
);

/**
 * Employee/company expenses (spec §14) with their own approval lifecycle.
 * An expense is not posted before approval when approval is required.
 */
export const expenses = pgTable(
  'expenses',
  {
    id: primaryKeyId(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    branchId: uuid('branch_id').references(() => branches.id, { onDelete: 'restrict' }),

    expenseNumber: text('expense_number').notNull(),
    categoryId: uuid('category_id'),
    /** Who incurred it. */
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    /** Who it was paid to, when that is a tracked vendor. */
    contactId: uuid('contact_id'),

    expenseDate: date('expense_date').notNull(),
    description: text('description').notNull(),

    currencyCode: text('currency_code').notNull(),
    exchangeRate: rate('exchange_rate').notNull().default('1'),
    amount: amount('amount').notNull(),
    taxId: uuid('tax_id'),
    taxAmount: amount('tax_amount').notNull().default('0'),

    /** Credit side: the bank/cash paid from, or a payable if unpaid. */
    paymentAccountId: uuid('payment_account_id'),
    isReimbursable: boolean('is_reimbursable').notNull().default(false),

    status: text('status', {
      enum: ['draft', 'submitted', 'pending_approval', 'approved', 'paid', 'posted', 'rejected'],
    })
      .notNull()
      .default('draft'),

    receiptUrl: text('receipt_url'),
    journalEntryId: uuid('journal_entry_id').references(() => journalEntries.id, {
      onDelete: 'restrict',
    }),

    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    approvedById: uuid('approved_by_id').references(() => users.id, { onDelete: 'set null' }),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    createdById: uuid('created_by_id').references(() => users.id, { onDelete: 'set null' }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('expenses_company_number_key').on(t.companyId, t.expenseNumber),
    index('expenses_company_status_idx').on(t.companyId, t.status, t.expenseDate),
    foreignKey({
      columns: [t.categoryId, t.companyId],
      foreignColumns: [expenseCategories.id, expenseCategories.companyId],
      name: 'expenses_category_company_fk',
    }).onDelete('restrict'),
    check('expenses_amount_positive_ck', sql`${t.amount} > 0`),
  ],
);

/**
 * A line on a bank statement, imported or entered, awaiting reconciliation.
 * Matching one to a payment records the link — it never rewrites the payment,
 * per spec §16 ("never alter the source transaction merely because it was
 * reconciled").
 */
export const bankTransactions = pgTable(
  'bank_transactions',
  {
    id: primaryKeyId(),
    companyId: uuid('company_id').notNull(),
    bankAccountId: uuid('bank_account_id').notNull(),

    transactionDate: date('transaction_date').notNull(),
    description: text('description').notNull(),
    reference: text('reference'),
    /** Positive = money in, negative = money out, in the account's currency. */
    amount: amount('amount').notNull(),

    isReconciled: boolean('is_reconciled').notNull().default(false),
    reconciliationId: uuid('reconciliation_id'),
    /** The payment or journal entry this statement line was matched to. */
    matchedPaymentId: uuid('matched_payment_id'),
    matchedEntryId: uuid('matched_entry_id'),
    ...timestamps,
  },
  (t) => [
    index('bank_transactions_account_date_idx').on(
      t.companyId,
      t.bankAccountId,
      t.transactionDate,
    ),
    index('bank_transactions_unreconciled_idx').on(
      t.companyId,
      t.bankAccountId,
      t.isReconciled,
    ),
    foreignKey({
      columns: [t.bankAccountId, t.companyId],
      foreignColumns: [bankAccounts.id, bankAccounts.companyId],
      name: 'bank_transactions_account_company_fk',
    }).onDelete('cascade'),
  ],
);

export const reconciliations = pgTable(
  'reconciliations',
  {
    id: primaryKeyId(),
    companyId: uuid('company_id').notNull(),
    bankAccountId: uuid('bank_account_id').notNull(),
    statementDate: date('statement_date').notNull(),
    statementBalance: amount('statement_balance').notNull(),
    /** Ledger balance at `statementDate`, captured when the reconciliation closed. */
    ledgerBalance: amount('ledger_balance').notNull().default('0'),
    difference: amount('difference').notNull().default('0'),
    status: text('status', { enum: ['in_progress', 'completed'] })
      .notNull()
      .default('in_progress'),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    completedById: uuid('completed_by_id').references(() => users.id, { onDelete: 'set null' }),
    ...timestamps,
  },
  (t) => [
    index('reconciliations_account_idx').on(t.companyId, t.bankAccountId, t.statementDate),
    foreignKey({
      columns: [t.bankAccountId, t.companyId],
      foreignColumns: [bankAccounts.id, bankAccounts.companyId],
      name: 'reconciliations_account_company_fk',
    }).onDelete('cascade'),
  ],
);

/** Budgets (spec §25). Actuals are always read from the ledger, never stored. */
export const budgets = pgTable(
  'budgets',
  {
    id: primaryKeyId(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    fiscalYear: integer('fiscal_year').notNull(),
    branchId: uuid('branch_id').references(() => branches.id, { onDelete: 'restrict' }),
    status: text('status', { enum: ['draft', 'active', 'archived'] })
      .notNull()
      .default('draft'),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('budgets_company_name_year_key').on(t.companyId, t.name, t.fiscalYear),
    unique('budgets_id_company_key').on(t.id, t.companyId),
  ],
);

export const budgetLines = pgTable(
  'budget_lines',
  {
    id: primaryKeyId(),
    companyId: uuid('company_id').notNull(),
    budgetId: uuid('budget_id').notNull(),
    accountId: uuid('account_id').notNull(),
    /** 1–12 within the fiscal year; lets budget-vs-actual run monthly. */
    periodNumber: integer('period_number').notNull(),
    amount: amount('amount').notNull().default('0'),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('budget_lines_unique_key').on(t.budgetId, t.accountId, t.periodNumber),
    index('budget_lines_budget_idx').on(t.budgetId),
    foreignKey({
      columns: [t.budgetId, t.companyId],
      foreignColumns: [budgets.id, budgets.companyId],
      name: 'budget_lines_budget_company_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.accountId, t.companyId],
      foreignColumns: [accounts.id, accounts.companyId],
      name: 'budget_lines_account_company_fk',
    }).onDelete('restrict'),
  ],
);

export const documentsRelations = relations(documents, ({ one, many }) => ({
  company: one(companies, { fields: [documents.companyId], references: [companies.id] }),
  contact: one(contacts, { fields: [documents.contactId], references: [contacts.id] }),
  branch: one(branches, { fields: [documents.branchId], references: [branches.id] }),
  journalEntry: one(journalEntries, {
    fields: [documents.journalEntryId],
    references: [journalEntries.id],
  }),
  lines: many(documentLines),
  allocations: many(paymentAllocations),
}));

export const documentLinesRelations = relations(documentLines, ({ one }) => ({
  document: one(documents, {
    fields: [documentLines.documentId],
    references: [documents.id],
  }),
  account: one(accounts, { fields: [documentLines.accountId], references: [accounts.id] }),
}));

export const paymentsRelations = relations(payments, ({ one, many }) => ({
  company: one(companies, { fields: [payments.companyId], references: [companies.id] }),
  contact: one(contacts, { fields: [payments.contactId], references: [contacts.id] }),
  bankAccount: one(bankAccounts, {
    fields: [payments.bankAccountId],
    references: [bankAccounts.id],
  }),
  allocations: many(paymentAllocations),
}));

export const paymentAllocationsRelations = relations(paymentAllocations, ({ one }) => ({
  payment: one(payments, {
    fields: [paymentAllocations.paymentId],
    references: [payments.id],
  }),
  document: one(documents, {
    fields: [paymentAllocations.documentId],
    references: [documents.id],
  }),
}));

export const bankAccountsRelations = relations(bankAccounts, ({ one, many }) => ({
  company: one(companies, { fields: [bankAccounts.companyId], references: [companies.id] }),
  ledgerAccount: one(accounts, {
    fields: [bankAccounts.ledgerAccountId],
    references: [accounts.id],
  }),
  transactions: many(bankTransactions),
}));

export const expensesRelations = relations(expenses, ({ one }) => ({
  company: one(companies, { fields: [expenses.companyId], references: [companies.id] }),
  category: one(expenseCategories, {
    fields: [expenses.categoryId],
    references: [expenseCategories.id],
  }),
  contact: one(contacts, { fields: [expenses.contactId], references: [contacts.id] }),
}));

export const budgetsRelations = relations(budgets, ({ one, many }) => ({
  company: one(companies, { fields: [budgets.companyId], references: [companies.id] }),
  lines: many(budgetLines),
}));

export const budgetLinesRelations = relations(budgetLines, ({ one }) => ({
  budget: one(budgets, { fields: [budgetLines.budgetId], references: [budgets.id] }),
  account: one(accounts, { fields: [budgetLines.accountId], references: [accounts.id] }),
}));
