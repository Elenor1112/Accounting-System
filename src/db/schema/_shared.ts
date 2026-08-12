import { sql } from 'drizzle-orm';
import { numeric, pgEnum, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * Money is stored as `numeric(20, 6)` everywhere and moved through the app as
 * a decimal *string* — never a JS number. Binary floating point cannot
 * represent 0.1 exactly, so accumulating float amounts silently drifts and a
 * ledger that must satisfy `sum(debit) = sum(credit)` would fail to balance by
 * fractions of a cent. Six decimal places leaves room for currencies with
 * three minor units and for exchange-rate-converted amounts that need rounding
 * headroom above the presentation scale.
 */
export const amount = (name: string) => numeric(name, { precision: 20, scale: 6 });

/** Exchange rates need more decimals than money: some pairs trade at 0.00001234. */
export const rate = (name: string) => numeric(name, { precision: 20, scale: 10 });

/** Every table gets these. `updatedAt` is maintained by the app, not a trigger. */
export const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .default(sql`now()`),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .default(sql`now()`),
};

export const primaryKeyId = () => uuid('id').primaryKey().defaultRandom();

// ---------------------------------------------------------------------------
// Shared enums
// ---------------------------------------------------------------------------

/**
 * The five roots of any chart of accounts. Normal balance is derived from this
 * (asset/expense are debit-normal; liability/equity/revenue are credit-normal)
 * rather than stored, so the two can never disagree.
 */
export const accountTypeEnum = pgEnum('account_type', [
  'asset',
  'liability',
  'equity',
  'revenue',
  'expense',
]);

/**
 * Sub-classification drives report placement: which side of the balance sheet a
 * line lands on, and which section of the cash flow statement. Kept separate
 * from `accountType` so reporting rules stay configurable per template.
 */
export const accountSubtypeEnum = pgEnum('account_subtype', [
  // asset
  'cash',
  'bank',
  'accounts_receivable',
  'inventory',
  'other_current_asset',
  'fixed_asset',
  'accumulated_depreciation',
  'other_asset',
  // liability
  'accounts_payable',
  'credit_card',
  'tax_payable',
  'other_current_liability',
  'long_term_liability',
  // equity
  'equity',
  'retained_earnings',
  // revenue
  'operating_revenue',
  'other_income',
  // expense
  'cost_of_goods_sold',
  'operating_expense',
  'payroll_expense',
  'depreciation_expense',
  'other_expense',
]);

/**
 * The lifecycle from §9 of the spec. `posted` is terminal for editing: a posted
 * entry can only be superseded by a linked reversal, never mutated.
 */
export const journalStatusEnum = pgEnum('journal_status', [
  'draft',
  'pending_approval',
  'approved',
  'posted',
  'reversed',
  'void',
]);

export const documentStatusEnum = pgEnum('document_status', [
  'draft',
  'pending_approval',
  'approved',
  'sent',
  'partially_paid',
  'paid',
  'overdue',
  'cancelled',
  'void',
]);
