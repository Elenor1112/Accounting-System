import { relations, sql } from 'drizzle-orm';
import {
  check,
  date,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { amount, primaryKeyId, timestamps } from './_shared';
import { users } from './identity';
import { accounts, journalEntries } from './ledger';
import { branches, companies } from './tenancy';

/**
 * The fixed asset register (spec §16, audit finding: assets stayed at cost for
 * ever).
 *
 * An asset is held at cost and depreciated over its useful life, with the
 * charge accumulating in a contra-asset account rather than reducing the cost
 * figure — so the balance sheet can always show cost, accumulated
 * depreciation, and net book value separately, which is what statutory
 * accounts require.
 *
 * Straight-line only for now: it covers the large majority of SMB assets, and
 * an incorrect reducing-balance implementation would be worse than an absent
 * one. The `method` column exists so a second method can be added without a
 * migration.
 */
export const fixedAssets = pgTable(
  'fixed_assets',
  {
    id: primaryKeyId(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),

    assetNumber: text('asset_number').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    category: text('category'),

    acquisitionDate: date('acquisition_date').notNull(),
    /** What was paid, including anything capitalised into the asset. */
    cost: amount('cost').notNull(),
    /** Expected value at the end of its life; never depreciated below this. */
    residualValue: amount('residual_value').notNull().default('0'),
    usefulLifeMonths: integer('useful_life_months').notNull(),

    method: text('method', { enum: ['straight_line'] })
      .notNull()
      .default('straight_line'),

    /**
     * Running total of depreciation charged, maintained by the depreciation
     * run inside the same transaction as its journal entry — so the register
     * and the accumulated depreciation account cannot drift apart.
     */
    accumulatedDepreciation: amount('accumulated_depreciation').notNull().default('0'),
    /** The period end through which depreciation has been charged. */
    depreciatedTo: date('depreciated_to'),

    status: text('status', { enum: ['active', 'disposed', 'written_off'] })
      .notNull()
      .default('active'),

    disposalDate: date('disposal_date'),
    disposalProceeds: amount('disposal_proceeds'),

    /** Where the asset, its contra and its charge live. Role-resolved if null. */
    assetAccountId: uuid('asset_account_id').references(() => accounts.id, {
      onDelete: 'restrict',
    }),
    accumulatedAccountId: uuid('accumulated_account_id').references(() => accounts.id, {
      onDelete: 'restrict',
    }),
    expenseAccountId: uuid('expense_account_id').references(() => accounts.id, {
      onDelete: 'restrict',
    }),

    branchId: uuid('branch_id').references(() => branches.id, { onDelete: 'restrict' }),
    createdById: uuid('created_by_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('fixed_assets_company_number_key').on(t.companyId, t.assetNumber),
    index('fixed_assets_company_status_idx').on(t.companyId, t.status),
    unique('fixed_assets_id_company_key').on(t.id, t.companyId),

    check('fixed_assets_cost_positive_ck', sql`${t.cost} > 0`),
    check('fixed_assets_residual_nonneg_ck', sql`${t.residualValue} >= 0`),
    /** Residual above cost would make the depreciable amount negative. */
    check('fixed_assets_residual_lte_cost_ck', sql`${t.residualValue} <= ${t.cost}`),
    check('fixed_assets_life_positive_ck', sql`${t.usefulLifeMonths} > 0`),
    /**
     * An asset can never be depreciated below its residual value — the single
     * most common fixed-asset error, and one worth enforcing in the database
     * rather than trusting a schedule calculation.
     */
    check(
      'fixed_assets_accum_within_depreciable_ck',
      sql`${t.accumulatedDepreciation} >= 0
          AND ${t.accumulatedDepreciation} <= (${t.cost} - ${t.residualValue})`,
    ),
  ],
);

/**
 * One row per depreciation charge, so the register can be replayed and each
 * charge traced to the journal entry that recorded it.
 */
export const depreciationEntries = pgTable(
  'depreciation_entries',
  {
    id: primaryKeyId(),
    companyId: uuid('company_id').notNull(),
    assetId: uuid('asset_id').notNull(),

    /** The period this charge covers, identified by its last day. */
    periodEnd: date('period_end').notNull(),
    amount: amount('amount').notNull(),
    /** Accumulated depreciation after this charge. */
    accumulatedAfter: amount('accumulated_after').notNull(),
    /** Cost less accumulated depreciation after this charge. */
    netBookValueAfter: amount('net_book_value_after').notNull(),

    journalEntryId: uuid('journal_entry_id').references(() => journalEntries.id, {
      onDelete: 'restrict',
    }),

    createdById: uuid('created_by_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamps.createdAt,
  },
  (t) => [
    /**
     * One charge per asset per period. This is what makes running depreciation
     * twice for the same month a no-op instead of a double charge — the most
     * likely way a depreciation engine misstates the accounts.
     */
    uniqueIndex('depreciation_entries_asset_period_key').on(t.assetId, t.periodEnd),
    index('depreciation_entries_company_period_idx').on(t.companyId, t.periodEnd),
    foreignKey({
      columns: [t.assetId, t.companyId],
      foreignColumns: [fixedAssets.id, fixedAssets.companyId],
      name: 'depreciation_entries_asset_company_fk',
    }).onDelete('restrict'),
    check('depreciation_entries_amount_positive_ck', sql`${t.amount} > 0`),
  ],
);

export const fixedAssetsRelations = relations(fixedAssets, ({ one, many }) => ({
  company: one(companies, {
    fields: [fixedAssets.companyId],
    references: [companies.id],
  }),
  branch: one(branches, {
    fields: [fixedAssets.branchId],
    references: [branches.id],
  }),
  depreciation: many(depreciationEntries),
}));

export const depreciationEntriesRelations = relations(depreciationEntries, ({ one }) => ({
  asset: one(fixedAssets, {
    fields: [depreciationEntries.assetId],
    references: [fixedAssets.id],
  }),
  journalEntry: one(journalEntries, {
    fields: [depreciationEntries.journalEntryId],
    references: [journalEntries.id],
  }),
}));
