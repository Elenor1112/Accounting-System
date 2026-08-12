import { relations, sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import {
  accountSubtypeEnum,
  accountTypeEnum,
  amount,
  journalStatusEnum,
  primaryKeyId,
  rate,
  timestamps,
} from './_shared';
import { users } from './identity';
import { branches, companies } from './tenancy';

/**
 * The chart of accounts (spec §7). Hierarchical via `parentId`, with depth kept
 * shallow in practice; `path` caches the ancestor codes so a subtree rollup in
 * a report is one indexed prefix scan instead of a recursive CTE per row.
 *
 * Accounts are never deleted once referenced by a posted line — the service
 * layer archives them instead (`isArchived`), and archived accounts reject new
 * postings.
 */
export const accounts = pgTable(
  'accounts',
  {
    id: primaryKeyId(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),

    code: text('code').notNull(),
    name: text('name').notNull(),
    description: text('description'),

    type: accountTypeEnum('type').notNull(),
    subtype: accountSubtypeEnum('subtype').notNull(),

    parentId: uuid('parent_id'),
    /** Materialized ancestry, e.g. `1000.1100.1110`. Maintained by the service. */
    path: text('path').notNull(),
    depth: integer('depth').notNull().default(0),

    /**
     * A control account is maintained by the subledger (AR by invoices, AP by
     * bills) and must not accept hand-written journal lines, or the subledger
     * and the ledger would disagree. Enforced in the posting service.
     */
    isControlAccount: boolean('is_control_account').notNull().default(false),
    /** Parent/rollup accounts hold no lines of their own. */
    isPostable: boolean('is_postable').notNull().default(true),

    currencyCode: text('currency_code'),
    isArchived: boolean('is_archived').notNull().default(false),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('accounts_company_code_key').on(t.companyId, t.code),
    index('accounts_company_type_idx').on(t.companyId, t.type),
    index('accounts_company_path_idx').on(t.companyId, t.path),
    foreignKey({
      columns: [t.parentId],
      foreignColumns: [t.id],
      name: 'accounts_parent_fk',
    }).onDelete('restrict'),
    /**
     * Composite target for journal lines' tenant-carrying foreign key: it lets
     * a line prove its account lives in the same company as its entry (see
     * `journalLines`). Declared as a table *constraint* rather than a unique
     * index so Postgres emits it inline with CREATE TABLE — a referenced
     * unique index added afterwards would not yet exist when the dependent
     * foreign key is created.
     */
    unique('accounts_id_company_key').on(t.id, t.companyId),
  ],
);

/**
 * Fiscal periods (spec §33). A posting date must fall inside an open period;
 * closing a period is what stops backdated entries from rewriting a month that
 * has already been reported.
 */
export const fiscalPeriods = pgTable(
  'fiscal_periods',
  {
    id: primaryKeyId(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    fiscalYear: integer('fiscal_year').notNull(),
    periodNumber: integer('period_number').notNull(),
    name: text('name').notNull(),
    startDate: date('start_date').notNull(),
    endDate: date('end_date').notNull(),
    /**
     * `open` accepts postings. `closed` rejects them but can be reopened by a
     * user holding `accounting.periods.manage`. `locked` is permanent: it
     * survives year-end and is the state auditors rely on.
     */
    status: text('status', { enum: ['open', 'closed', 'locked'] })
      .notNull()
      .default('open'),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    closedById: uuid('closed_by_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('fiscal_periods_company_year_num_key').on(
      t.companyId,
      t.fiscalYear,
      t.periodNumber,
    ),
    index('fiscal_periods_company_dates_idx').on(t.companyId, t.startDate, t.endDate),
    check('fiscal_periods_range_ck', sql`${t.endDate} >= ${t.startDate}`),
    unique('fiscal_periods_id_company_key').on(t.id, t.companyId),
  ],
);

/**
 * A journal entry is the only way value enters the ledger. Invoices, payments,
 * bills and expenses are *source documents*: they describe intent, then produce
 * one of these. `sourceType`/`sourceId` link back to whichever document caused
 * the entry, which is what makes a drill-down from a report to its origin
 * possible without duplicating balances anywhere.
 */
export const journalEntries = pgTable(
  'journal_entries',
  {
    id: primaryKeyId(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    branchId: uuid('branch_id').references(() => branches.id, {
      onDelete: 'restrict',
    }),

    entryNumber: text('entry_number').notNull(),
    entryDate: date('entry_date').notNull(),
    periodId: uuid('period_id').references(() => fiscalPeriods.id, {
      onDelete: 'restrict',
    }),

    description: text('description'),
    reference: text('reference'),

    /** e.g. `invoice`, `payment`, `bill`, `expense`, `transfer`, `manual`. */
    sourceType: text('source_type').notNull().default('manual'),
    sourceId: uuid('source_id'),

    currencyCode: text('currency_code').notNull(),
    exchangeRate: rate('exchange_rate').notNull().default('1'),

    status: journalStatusEnum('status').notNull().default('draft'),

    /**
     * Cached totals in base currency. Written by the posting service inside the
     * same transaction as the lines, and asserted equal before status becomes
     * `posted`. They exist so a trial balance does not have to re-aggregate
     * every line to show entry-level figures.
     */
    totalDebit: amount('total_debit').notNull().default('0'),
    totalCredit: amount('total_credit').notNull().default('0'),

    /** Reversal linkage (spec §34), both directions for cheap lookups. */
    reversesEntryId: uuid('reverses_entry_id'),
    reversedByEntryId: uuid('reversed_by_entry_id'),

    createdById: uuid('created_by_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    approvedById: uuid('approved_by_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    postedById: uuid('posted_by_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    postedAt: timestamp('posted_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('journal_entries_company_number_key').on(t.companyId, t.entryNumber),
    // The workhorse index: every ledger/trial-balance/report query filters by
    // company and date, and almost all of them only want posted rows.
    index('journal_entries_company_date_idx').on(t.companyId, t.entryDate, t.status),
    index('journal_entries_source_idx').on(t.companyId, t.sourceType, t.sourceId),
    index('journal_entries_period_idx').on(t.periodId),
    foreignKey({
      columns: [t.reversesEntryId],
      foreignColumns: [t.id],
      name: 'journal_entries_reverses_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [t.reversedByEntryId],
      foreignColumns: [t.id],
      name: 'journal_entries_reversed_by_fk',
    }).onDelete('restrict'),
    /**
     * A posted entry must balance. This is the single most important
     * constraint in the schema: it holds even if a bug bypasses the service
     * layer, because Postgres refuses the row outright.
     */
    check(
      'journal_entries_balanced_ck',
      sql`${t.status} <> 'posted' OR ${t.totalDebit} = ${t.totalCredit}`,
    ),
    check('journal_entries_rate_positive_ck', sql`${t.exchangeRate} > 0`),
    // Table constraint, not an index — see the note on `accounts_id_company_key`.
    unique('journal_entries_id_company_key').on(t.id, t.companyId),
  ],
);

/**
 * One side of one entry. Exactly one of `debit`/`credit` is non-zero — the
 * check constraint below makes the "both filled in" mistake impossible rather
 * than merely discouraged.
 *
 * Both transaction-currency and base-currency amounts are stored (spec §18).
 * The original is never overwritten by its conversion, so a USD invoice still
 * reads as USD 1,000 years later regardless of what the rate did.
 */
export const journalLines = pgTable(
  'journal_lines',
  {
    id: primaryKeyId(),
    companyId: uuid('company_id').notNull(),
    entryId: uuid('entry_id').notNull(),
    accountId: uuid('account_id').notNull(),

    lineNumber: integer('line_number').notNull(),

    debit: amount('debit').notNull().default('0'),
    credit: amount('credit').notNull().default('0'),

    currencyCode: text('currency_code').notNull(),
    exchangeRate: rate('exchange_rate').notNull().default('1'),
    /** `debit`/`credit` converted at `exchangeRate`. What reports sum. */
    baseDebit: amount('base_debit').notNull().default('0'),
    baseCredit: amount('base_credit').notNull().default('0'),

    description: text('description'),

    // Reporting dimensions (spec §19, §24). Nullable: not every line has them.
    branchId: uuid('branch_id').references(() => branches.id, {
      onDelete: 'restrict',
    }),
    customerId: uuid('customer_id'),
    vendorId: uuid('vendor_id'),
    projectId: uuid('project_id'),

    createdAt: timestamps.createdAt,
  },
  (t) => [
    index('journal_lines_entry_idx').on(t.entryId, t.lineNumber),
    // Drives the general ledger and every account balance rollup.
    index('journal_lines_company_account_idx').on(t.companyId, t.accountId),
    index('journal_lines_customer_idx').on(t.companyId, t.customerId),
    index('journal_lines_vendor_idx').on(t.companyId, t.vendorId),

    /**
     * Composite FKs carrying `companyId` into the reference. This is the
     * structural guarantee of tenant isolation for the ledger: it is not
     * possible to attach a line to an account belonging to another company,
     * even with a hand-written INSERT.
     */
    foreignKey({
      columns: [t.entryId, t.companyId],
      foreignColumns: [journalEntries.id, journalEntries.companyId],
      name: 'journal_lines_entry_company_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.accountId, t.companyId],
      foreignColumns: [accounts.id, accounts.companyId],
      name: 'journal_lines_account_company_fk',
    }).onDelete('restrict'),

    check('journal_lines_debit_nonneg_ck', sql`${t.debit} >= 0`),
    check('journal_lines_credit_nonneg_ck', sql`${t.credit} >= 0`),
    /** Exactly one side carries value — never both, never neither. */
    check(
      'journal_lines_one_side_ck',
      sql`(${t.debit} > 0 AND ${t.credit} = 0) OR (${t.credit} > 0 AND ${t.debit} = 0)`,
    ),
  ],
);

export const accountsRelations = relations(accounts, ({ one, many }) => ({
  company: one(companies, {
    fields: [accounts.companyId],
    references: [companies.id],
  }),
  parent: one(accounts, {
    fields: [accounts.parentId],
    references: [accounts.id],
    relationName: 'account_parent',
  }),
  children: many(accounts, { relationName: 'account_parent' }),
  lines: many(journalLines),
}));

export const journalEntriesRelations = relations(journalEntries, ({ one, many }) => ({
  company: one(companies, {
    fields: [journalEntries.companyId],
    references: [companies.id],
  }),
  branch: one(branches, {
    fields: [journalEntries.branchId],
    references: [branches.id],
  }),
  period: one(fiscalPeriods, {
    fields: [journalEntries.periodId],
    references: [fiscalPeriods.id],
  }),
  lines: many(journalLines),
  reverses: one(journalEntries, {
    fields: [journalEntries.reversesEntryId],
    references: [journalEntries.id],
    relationName: 'entry_reversal',
  }),
}));

export const journalLinesRelations = relations(journalLines, ({ one }) => ({
  entry: one(journalEntries, {
    fields: [journalLines.entryId],
    references: [journalEntries.id],
  }),
  account: one(accounts, {
    fields: [journalLines.accountId],
    references: [accounts.id],
  }),
  branch: one(branches, {
    fields: [journalLines.branchId],
    references: [branches.id],
  }),
}));

export const fiscalPeriodsRelations = relations(fiscalPeriods, ({ one, many }) => ({
  company: one(companies, {
    fields: [fiscalPeriods.companyId],
    references: [companies.id],
  }),
  entries: many(journalEntries),
}));
