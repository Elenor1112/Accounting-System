import { sql } from 'drizzle-orm';
import { customType, pgEnum, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * Strips the trailing zeros Postgres pads onto a `numeric(20,6)` value.
 *
 * Postgres returns `6500.000000` where the application's own arithmetic
 * produces `6500`. Both are the same number, but the difference leaks into
 * every equality check and every rendered figure, so it is normalised once
 * here — at the column boundary — rather than at each call site.
 */
function canonicalDecimal(value: string): string {
  if (!value.includes('.')) return value;
  const trimmed = value.replace(/0+$/, '').replace(/\.$/, '');
  return trimmed === '' || trimmed === '-' ? '0' : trimmed;
}

/**
 * Money is stored as `numeric(20, 6)` everywhere and moved through the app as
 * a decimal *string* — never a JS number. Binary floating point cannot
 * represent 0.1 exactly, so accumulating float amounts silently drifts and a
 * ledger that must satisfy `sum(debit) = sum(credit)` would fail to balance by
 * fractions of a cent. Six decimal places leaves room for currencies with
 * three minor units and for exchange-rate-converted amounts that need rounding
 * headroom above the presentation scale.
 *
 * Values are canonicalised on read so the database and the application agree
 * on how a number looks, not merely on what it is worth.
 */
const decimalColumn = (precision: number, scale: number) =>
  customType<{ data: string; driverData: string }>({
    dataType: () => `numeric(${precision}, ${scale})`,
    fromDriver: (value) => canonicalDecimal(String(value)),
    toDriver: (value) => String(value),
  });

export const amount = decimalColumn(20, 6);

/** Exchange rates need more decimals than money: some pairs trade at 0.00001234. */
export const rate = decimalColumn(20, 10);

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
