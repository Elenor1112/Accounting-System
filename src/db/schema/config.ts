import { relations } from 'drizzle-orm';
import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { amount, primaryKeyId, rate, timestamps } from './_shared';
import { accounts } from './ledger';
import { companies } from './tenancy';

/**
 * Configurable document numbering (spec §10: "Do not hardcode numbering").
 *
 * A sequence owns a pattern such as `INV-{YYYY}-{####}` and the counter that
 * fills it. Counters are allocated with `SELECT … FOR UPDATE` inside the
 * document's own transaction, so two users creating an invoice at the same
 * instant cannot receive the same number.
 */
export const numberSequences = pgTable(
  'number_sequences',
  {
    id: primaryKeyId(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    /** `invoice`, `bill`, `payment`, `journal`, `credit_note`, … */
    documentType: text('document_type').notNull(),
    /**
     * Tokens: `{YYYY}` `{YY}` `{MM}` `{DD}` `{####}` (any run of #, zero-padded),
     * plus `{BRANCH}` for branch-scoped numbering. Everything else is literal.
     */
    pattern: text('pattern').notNull(),
    nextValue: integer('next_value').notNull().default(1),
    /**
     * When set, the counter restarts at 1 whenever this period changes, which
     * is what makes `INV-2026-0001` start over each January.
     */
    resetPolicy: text('reset_policy', { enum: ['never', 'yearly', 'monthly'] })
      .notNull()
      .default('yearly'),
    /** The period the counter was last used in, to detect a reset boundary. */
    lastResetKey: text('last_reset_key'),
    ...timestamps,
  },
  (t) => [uniqueIndex('number_sequences_company_type_key').on(t.companyId, t.documentType)],
);

/**
 * Currencies enabled for a company. ISO code plus the minor-unit count, since
 * JPY has 0 decimals and KWD has 3 — assuming 2 everywhere would misround.
 */
export const currencies = pgTable(
  'currencies',
  {
    id: primaryKeyId(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    code: text('code').notNull(),
    name: text('name').notNull(),
    symbol: text('symbol'),
    decimalPlaces: integer('decimal_places').notNull().default(2),
    isActive: boolean('is_active').notNull().default(true),
    ...timestamps,
  },
  (t) => [uniqueIndex('currencies_company_code_key').on(t.companyId, t.code)],
);

/**
 * Dated exchange rates. Rates are looked up by "the latest rate on or before
 * the transaction date", so historical documents keep converting at the rate
 * that applied when they were issued, not today's.
 */
export const exchangeRates = pgTable(
  'exchange_rates',
  {
    id: primaryKeyId(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    fromCurrency: text('from_currency').notNull(),
    toCurrency: text('to_currency').notNull(),
    rate: rate('rate').notNull(),
    effectiveDate: date('effective_date').notNull(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('exchange_rates_unique_key').on(
      t.companyId,
      t.fromCurrency,
      t.toCurrency,
      t.effectiveDate,
    ),
    index('exchange_rates_lookup_idx').on(
      t.companyId,
      t.fromCurrency,
      t.toCurrency,
      t.effectiveDate,
    ),
  ],
);

/**
 * Configurable taxes (spec §17). Deliberately country-neutral: a rate, a
 * direction, and the accounts the collected/paid amounts land in. Country
 * packs can later seed rows here without the engine changing.
 */
export const taxes = pgTable(
  'taxes',
  {
    id: primaryKeyId(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    code: text('code').notNull(),
    name: text('name').notNull(),
    /** Percentage, e.g. `14` for 14%. Not a fraction — avoids 0.14 vs 14 bugs. */
    ratePercent: amount('rate_percent').notNull(),
    /**
     * Inclusive means the line price already contains the tax and it must be
     * extracted; exclusive means it is added on top.
     */
    isInclusive: boolean('is_inclusive').notNull().default(false),
    /** Sales tax accrues to a liability; purchase tax to a recoverable asset. */
    salesAccountId: uuid('sales_account_id').references(() => accounts.id, {
      onDelete: 'restrict',
    }),
    purchaseAccountId: uuid('purchase_account_id').references(() => accounts.id, {
      onDelete: 'restrict',
    }),
    effectiveFrom: date('effective_from'),
    effectiveTo: date('effective_to'),
    isActive: boolean('is_active').notNull().default(true),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('taxes_company_code_key').on(t.companyId, t.code),
    unique('taxes_id_company_key').on(t.id, t.companyId),
  ],
);

/**
 * Custom field definitions (spec §20).
 *
 * Client-defined fields never alter the schema. A definition row describes the
 * field; values live in `custom_field_values` keyed by entity id. This costs a
 * join to read but means a client adding a field is a data change, not a
 * migration — which is what makes the product sellable to many businesses.
 */
export const customFieldDefinitions = pgTable(
  'custom_field_definitions',
  {
    id: primaryKeyId(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    /** `customer`, `vendor`, `invoice`, `bill`, `expense`, `payment`, … */
    entityType: text('entity_type').notNull(),
    key: text('key').notNull(),
    label: text('label').notNull(),
    fieldType: text('field_type', {
      enum: [
        'text',
        'number',
        'currency',
        'date',
        'boolean',
        'select',
        'multi_select',
        'user',
        'customer',
        'vendor',
        'file',
      ],
    }).notNull(),
    /** Options for select types; `[{value,label}]`. */
    options: jsonb('options').notNull().default([]),
    isRequired: boolean('is_required').notNull().default(false),
    /** Shown in list views as a column when true. */
    showInList: boolean('show_in_list').notNull().default(false),
    sortOrder: integer('sort_order').notNull().default(0),
    isActive: boolean('is_active').notNull().default(true),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('custom_field_defs_company_entity_key').on(t.companyId, t.entityType, t.key),
    index('custom_field_defs_lookup_idx').on(t.companyId, t.entityType, t.isActive),
  ],
);

export const customFieldValues = pgTable(
  'custom_field_values',
  {
    id: primaryKeyId(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    definitionId: uuid('definition_id')
      .notNull()
      .references(() => customFieldDefinitions.id, { onDelete: 'cascade' }),
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id').notNull(),
    /** Single JSON column: the definition's `fieldType` says how to read it. */
    value: jsonb('value'),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('custom_field_values_unique_key').on(t.definitionId, t.entityId),
    index('custom_field_values_entity_idx').on(t.companyId, t.entityType, t.entityId),
  ],
);

/**
 * Configurable approval workflows (spec §21).
 *
 * A workflow belongs to a document type and holds ordered steps. Each step may
 * carry an amount threshold, so "over 50,000 needs the finance manager" is a
 * row, not a branch in the code.
 */
export const workflows = pgTable(
  'workflows',
  {
    id: primaryKeyId(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    documentType: text('document_type').notNull(),
    name: text('name').notNull(),
    isActive: boolean('is_active').notNull().default(true),
    ...timestamps,
  },
  (t) => [index('workflows_company_type_idx').on(t.companyId, t.documentType, t.isActive)],
);

export const workflowSteps = pgTable(
  'workflow_steps',
  {
    id: primaryKeyId(),
    companyId: uuid('company_id').notNull(),
    workflowId: uuid('workflow_id')
      .notNull()
      .references(() => workflows.id, { onDelete: 'cascade' }),
    stepOrder: integer('step_order').notNull(),
    name: text('name').notNull(),
    /** Role key whose holders may approve this step. */
    approverRoleKey: text('approver_role_key'),
    /** Step applies only at or above this document total; null = always. */
    minAmount: amount('min_amount'),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('workflow_steps_order_key').on(t.workflowId, t.stepOrder),
    index('workflow_steps_workflow_idx').on(t.workflowId),
  ],
);

/**
 * An approval decision on a specific document. Rows are append-only: a
 * rejection followed by a re-approval leaves both, so the history of who
 * signed off on what survives.
 */
export const approvals = pgTable(
  'approvals',
  {
    id: primaryKeyId(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id').notNull(),
    stepId: uuid('step_id').references(() => workflowSteps.id, { onDelete: 'set null' }),
    stepOrder: integer('step_order').notNull().default(0),
    status: text('status', { enum: ['pending', 'approved', 'rejected'] })
      .notNull()
      .default('pending'),
    actorId: uuid('actor_id'),
    comment: text('comment'),
    /**
     * There is deliberately no `decidedAt` column. It previously existed as
     * `decidedAt: timestamps.createdAt`, which reused the *same column object*
     * and therefore mapped `decided_at` onto `created_at` — so every INSERT
     * named `created_at` twice and Postgres rejected it. Nothing ever inserted
     * an approval row until the workflow engine was wired into posting, which
     * is why a broken table definition survived this long. The decision time
     * is `updatedAt`, set when the row moves off `pending`, and that is what
     * `getApprovalStatus` reports.
     */
    ...timestamps,
  },
  (t) => [index('approvals_entity_idx').on(t.companyId, t.entityType, t.entityId)],
);

export const numberSequencesRelations = relations(numberSequences, ({ one }) => ({
  company: one(companies, {
    fields: [numberSequences.companyId],
    references: [companies.id],
  }),
}));

export const taxesRelations = relations(taxes, ({ one }) => ({
  company: one(companies, { fields: [taxes.companyId], references: [companies.id] }),
  salesAccount: one(accounts, {
    fields: [taxes.salesAccountId],
    references: [accounts.id],
    relationName: 'tax_sales_account',
  }),
  purchaseAccount: one(accounts, {
    fields: [taxes.purchaseAccountId],
    references: [accounts.id],
    relationName: 'tax_purchase_account',
  }),
}));

export const workflowsRelations = relations(workflows, ({ one, many }) => ({
  company: one(companies, { fields: [workflows.companyId], references: [companies.id] }),
  steps: many(workflowSteps),
}));

export const workflowStepsRelations = relations(workflowSteps, ({ one }) => ({
  workflow: one(workflows, {
    fields: [workflowSteps.workflowId],
    references: [workflows.id],
  }),
}));

export const customFieldDefinitionsRelations = relations(
  customFieldDefinitions,
  ({ one, many }) => ({
    company: one(companies, {
      fields: [customFieldDefinitions.companyId],
      references: [companies.id],
    }),
    values: many(customFieldValues),
  }),
);

export const customFieldValuesRelations = relations(customFieldValues, ({ one }) => ({
  definition: one(customFieldDefinitions, {
    fields: [customFieldValues.definitionId],
    references: [customFieldDefinitions.id],
  }),
}));
