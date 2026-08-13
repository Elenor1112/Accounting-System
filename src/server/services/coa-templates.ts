/**
 * Chart-of-accounts templates (spec §7).
 *
 * These are *starting points* a client edits after setup — not business logic.
 * Nothing in the engine branches on which template was used; it only ever reads
 * the accounts that exist. Adding an industry here is data entry, not code.
 *
 * `key` fields tag the handful of accounts the engine needs to find by role
 * (AR control, AP control, tax, retained earnings, FX gain/loss). Everything
 * else is free-form and safe to rename or delete.
 */
import type { accountSubtypeEnum, accountTypeEnum } from '@/db/schema';

type AccountType = (typeof accountTypeEnum.enumValues)[number];
type AccountSubtype = (typeof accountSubtypeEnum.enumValues)[number];

/** Roles the engine resolves by key rather than by account code. */
export type AccountRole =
  | 'accounts_receivable'
  | 'accounts_payable'
  | 'sales_tax_payable'
  | 'purchase_tax_receivable'
  | 'retained_earnings'
  | 'opening_balance_equity'
  | 'fx_gain_loss'
  | 'default_sales'
  | 'default_cash'
  | 'default_bank'
  | 'rounding'
  /** Unapplied customer receipts: a liability, not negative AR. */
  | 'customer_advances'
  /** Unapplied payments to vendors: an asset, not negative AP. */
  | 'vendor_prepayments'
  /** Uncollectible receivables written off. */
  | 'bad_debt_expense'
  /** Amounts taken out by the owner, kept apart from invested capital. */
  | 'owner_drawings'
  /** Stock on hand. Relieved automatically when an inventory product sells. */
  | 'inventory_asset'
  /** The cost side of a sale, posted against inventory. */
  | 'cost_of_goods_sold'
  /** Fixed assets at cost, and the contra that accumulates depreciation. */
  | 'fixed_assets'
  | 'accumulated_depreciation'
  | 'depreciation_expense';

export interface TemplateAccount {
  code: string;
  name: string;
  type: AccountType;
  subtype: AccountSubtype;
  /** Parent's code; the builder resolves these into ids and paths. */
  parent?: string;
  isPostable?: boolean;
  isControlAccount?: boolean;
  role?: AccountRole;
  description?: string;
}

/**
 * The universal skeleton every template starts from: the five roots, the
 * control accounts the subledgers require, and the equity accounts closing
 * needs. Industry templates add leaves beneath these.
 */
const CORE: TemplateAccount[] = [
  // ---- Assets -------------------------------------------------------------
  { code: '1000', name: 'Assets', type: 'asset', subtype: 'other_asset', isPostable: false },
  {
    code: '1100',
    name: 'Current Assets',
    type: 'asset',
    subtype: 'other_current_asset',
    parent: '1000',
    isPostable: false,
  },
  {
    code: '1110',
    name: 'Cash on Hand',
    type: 'asset',
    subtype: 'cash',
    parent: '1100',
    role: 'default_cash',
  },
  {
    code: '1120',
    name: 'Bank Account',
    type: 'asset',
    subtype: 'bank',
    parent: '1100',
    role: 'default_bank',
  },
  {
    code: '1130',
    name: 'Accounts Receivable',
    type: 'asset',
    subtype: 'accounts_receivable',
    parent: '1100',
    isControlAccount: true,
    role: 'accounts_receivable',
    description: 'Maintained by the invoices subledger. Not for manual entries.',
  },
  {
    code: '1140',
    name: 'Prepaid Expenses',
    type: 'asset',
    subtype: 'other_current_asset',
    parent: '1100',
  },
  {
    code: '1150',
    name: 'Recoverable Purchase Tax',
    type: 'asset',
    subtype: 'other_current_asset',
    parent: '1100',
    role: 'purchase_tax_receivable',
  },
  {
    code: '1155',
    name: 'Inventory',
    type: 'asset',
    subtype: 'inventory',
    parent: '1100',
    role: 'inventory_asset',
    description:
      'Stock on hand at weighted average cost. Maintained by the inventory ' +
      'subledger — it is relieved automatically when a stocked product sells.',
  },
  {
    code: '1160',
    name: 'Vendor Prepayments',
    type: 'asset',
    subtype: 'other_current_asset',
    parent: '1100',
    role: 'vendor_prepayments',
    description:
      'Payments made to vendors ahead of a bill. The mirror of Customer ' +
      'Advances: an amount owed to us, not a negative liability.',
  },
  {
    code: '1200',
    name: 'Fixed Assets',
    type: 'asset',
    subtype: 'fixed_asset',
    parent: '1000',
    isPostable: false,
  },
  {
    code: '1210',
    name: 'Equipment',
    type: 'asset',
    subtype: 'fixed_asset',
    parent: '1200',
    role: 'fixed_assets',
  },
  {
    code: '1290',
    name: 'Accumulated Depreciation',
    type: 'asset',
    subtype: 'accumulated_depreciation',
    parent: '1200',
    role: 'accumulated_depreciation',
    description:
      'Contra-asset. Credited by each depreciation run; never written to by hand.',
  },

  // ---- Liabilities --------------------------------------------------------
  {
    code: '2000',
    name: 'Liabilities',
    type: 'liability',
    subtype: 'other_current_liability',
    isPostable: false,
  },
  {
    code: '2100',
    name: 'Current Liabilities',
    type: 'liability',
    subtype: 'other_current_liability',
    parent: '2000',
    isPostable: false,
  },
  {
    code: '2110',
    name: 'Accounts Payable',
    type: 'liability',
    subtype: 'accounts_payable',
    parent: '2100',
    isControlAccount: true,
    role: 'accounts_payable',
    description: 'Maintained by the bills subledger. Not for manual entries.',
  },
  {
    code: '2120',
    name: 'Sales Tax Payable',
    type: 'liability',
    subtype: 'tax_payable',
    parent: '2100',
    role: 'sales_tax_payable',
  },
  {
    code: '2130',
    name: 'Accrued Liabilities',
    type: 'liability',
    subtype: 'other_current_liability',
    parent: '2100',
  },
  {
    code: '2140',
    name: 'Customer Advances',
    type: 'liability',
    subtype: 'other_current_liability',
    parent: '2100',
    role: 'customer_advances',
    description:
      'Receipts not yet applied to an invoice. Money held on a customer’s ' +
      'behalf is a liability; leaving it in Accounts Receivable would present ' +
      'it as a negative asset and understate both assets and liabilities.',
  },
  {
    code: '2200',
    name: 'Long-Term Liabilities',
    type: 'liability',
    subtype: 'long_term_liability',
    parent: '2000',
    isPostable: false,
  },
  {
    code: '2210',
    name: 'Loans Payable',
    type: 'liability',
    subtype: 'long_term_liability',
    parent: '2200',
  },

  // ---- Equity -------------------------------------------------------------
  { code: '3000', name: 'Equity', type: 'equity', subtype: 'equity', isPostable: false },
  { code: '3100', name: "Owner's Capital", type: 'equity', subtype: 'equity', parent: '3000' },
  {
    code: '3150',
    name: "Owner's Drawings",
    type: 'equity',
    subtype: 'equity',
    parent: '3000',
    role: 'owner_drawings',
    description:
      'Amounts withdrawn by the owner. A contra-equity account: without it a ' +
      'withdrawal is either netted against invested capital, losing the ' +
      'distinction every partnership and sole-trader account requires, or ' +
      'miscoded to an expense and understating profit.',
  },
  {
    code: '3200',
    name: 'Retained Earnings',
    type: 'equity',
    subtype: 'retained_earnings',
    parent: '3000',
    role: 'retained_earnings',
  },
  {
    code: '3300',
    name: 'Opening Balance Equity',
    type: 'equity',
    subtype: 'equity',
    parent: '3000',
    role: 'opening_balance_equity',
    description: 'Balancing account used when migrating opening balances.',
  },

  // ---- Revenue ------------------------------------------------------------
  {
    code: '4000',
    name: 'Revenue',
    type: 'revenue',
    subtype: 'operating_revenue',
    isPostable: false,
  },
  {
    code: '4100',
    name: 'Sales Revenue',
    type: 'revenue',
    subtype: 'operating_revenue',
    parent: '4000',
    role: 'default_sales',
  },
  {
    code: '4900',
    name: 'Other Income',
    type: 'revenue',
    subtype: 'other_income',
    parent: '4000',
  },
  {
    code: '4950',
    name: 'Foreign Exchange Gain/Loss',
    type: 'revenue',
    subtype: 'other_income',
    parent: '4000',
    role: 'fx_gain_loss',
    description: 'Realised currency differences on settlement.',
  },

  // ---- Expenses -----------------------------------------------------------
  {
    code: '5000',
    name: 'Cost of Sales',
    type: 'expense',
    subtype: 'cost_of_goods_sold',
    isPostable: false,
  },
  {
    code: '5100',
    name: 'Cost of Goods Sold',
    type: 'expense',
    subtype: 'cost_of_goods_sold',
    parent: '5000',
    role: 'cost_of_goods_sold',
    description:
      'Posted automatically when a stocked product sells, at weighted average ' +
      'cost, so revenue and its cost land in the same period.',
  },
  {
    code: '6000',
    name: 'Operating Expenses',
    type: 'expense',
    subtype: 'operating_expense',
    isPostable: false,
  },
  {
    code: '6100',
    name: 'Salaries and Wages',
    type: 'expense',
    subtype: 'payroll_expense',
    parent: '6000',
  },
  { code: '6200', name: 'Rent', type: 'expense', subtype: 'operating_expense', parent: '6000' },
  {
    code: '6300',
    name: 'Utilities',
    type: 'expense',
    subtype: 'operating_expense',
    parent: '6000',
  },
  {
    code: '6400',
    name: 'Office Supplies',
    type: 'expense',
    subtype: 'operating_expense',
    parent: '6000',
  },
  {
    code: '6500',
    name: 'Professional Fees',
    type: 'expense',
    subtype: 'operating_expense',
    parent: '6000',
  },
  {
    code: '6600',
    name: 'Travel and Entertainment',
    type: 'expense',
    subtype: 'operating_expense',
    parent: '6000',
  },
  {
    code: '6650',
    name: 'Bad Debt Expense',
    type: 'expense',
    subtype: 'operating_expense',
    parent: '6000',
    role: 'bad_debt_expense',
    description:
      'Receivables judged uncollectible. Without it AR stays overstated by ' +
      'every known bad debt.',
  },
  {
    code: '6700',
    name: 'Bank Charges',
    type: 'expense',
    subtype: 'operating_expense',
    parent: '6000',
  },
  {
    code: '6800',
    name: 'Depreciation Expense',
    type: 'expense',
    subtype: 'depreciation_expense',
    parent: '6000',
    role: 'depreciation_expense',
  },
  {
    code: '6900',
    name: 'Rounding Differences',
    type: 'expense',
    subtype: 'other_expense',
    parent: '6000',
    role: 'rounding',
  },
];

const extend = (...extra: TemplateAccount[]): TemplateAccount[] => [...CORE, ...extra];

export interface CoaTemplate {
  key: string;
  name: string;
  description: string;
  accounts: TemplateAccount[];
}

export const COA_TEMPLATES: CoaTemplate[] = [
  {
    key: 'general',
    name: 'General Business',
    description: 'A neutral starting chart suitable for most companies.',
    accounts: CORE,
  },
  {
    key: 'services',
    name: 'Professional Services',
    description: 'Consultancies and agencies billing time and retainers.',
    accounts: extend(
      {
        code: '4110',
        name: 'Consulting Revenue',
        type: 'revenue',
        subtype: 'operating_revenue',
        parent: '4000',
      },
      {
        code: '4120',
        name: 'Retainer Revenue',
        type: 'revenue',
        subtype: 'operating_revenue',
        parent: '4000',
      },
      {
        code: '5110',
        name: 'Subcontractor Costs',
        type: 'expense',
        subtype: 'cost_of_goods_sold',
        parent: '5000',
      },
      {
        code: '6210',
        name: 'Software Subscriptions',
        type: 'expense',
        subtype: 'operating_expense',
        parent: '6000',
      },
      {
        code: '6220',
        name: 'Advertising and Marketing',
        type: 'expense',
        subtype: 'operating_expense',
        parent: '6000',
      },
    ),
  },
  {
    key: 'retail',
    name: 'Retail',
    description: 'Businesses holding stock for resale.',
    accounts: extend(
      {
        code: '1160',
        name: 'Inventory',
        type: 'asset',
        subtype: 'inventory',
        parent: '1100',
      },
      {
        code: '4110',
        name: 'Product Sales',
        type: 'revenue',
        subtype: 'operating_revenue',
        parent: '4000',
      },
      {
        code: '4200',
        name: 'Sales Returns and Allowances',
        type: 'revenue',
        subtype: 'operating_revenue',
        parent: '4000',
      },
      {
        code: '5110',
        name: 'Purchases',
        type: 'expense',
        subtype: 'cost_of_goods_sold',
        parent: '5000',
      },
      {
        code: '5120',
        name: 'Freight In',
        type: 'expense',
        subtype: 'cost_of_goods_sold',
        parent: '5000',
      },
      {
        code: '5130',
        name: 'Inventory Shrinkage',
        type: 'expense',
        subtype: 'cost_of_goods_sold',
        parent: '5000',
      },
    ),
  },
  {
    key: 'construction',
    name: 'Construction',
    description: 'Project-based contractors tracking job costs and retentions.',
    accounts: extend(
      {
        code: '1170',
        name: 'Work in Progress',
        type: 'asset',
        subtype: 'other_current_asset',
        parent: '1100',
      },
      {
        code: '1180',
        name: 'Retention Receivable',
        type: 'asset',
        subtype: 'other_current_asset',
        parent: '1100',
      },
      {
        code: '2140',
        name: 'Retention Payable',
        type: 'liability',
        subtype: 'other_current_liability',
        parent: '2100',
      },
      {
        code: '4110',
        name: 'Contract Revenue',
        type: 'revenue',
        subtype: 'operating_revenue',
        parent: '4000',
      },
      {
        code: '5110',
        name: 'Materials',
        type: 'expense',
        subtype: 'cost_of_goods_sold',
        parent: '5000',
      },
      {
        code: '5120',
        name: 'Subcontractors',
        type: 'expense',
        subtype: 'cost_of_goods_sold',
        parent: '5000',
      },
      {
        code: '5130',
        name: 'Equipment Rental',
        type: 'expense',
        subtype: 'cost_of_goods_sold',
        parent: '5000',
      },
      {
        code: '5140',
        name: 'Site Labour',
        type: 'expense',
        subtype: 'cost_of_goods_sold',
        parent: '5000',
      },
    ),
  },
  {
    key: 'restaurant',
    name: 'Restaurant',
    description: 'Food service with ingredient costing and branch-level sales.',
    accounts: extend(
      {
        code: '1160',
        name: 'Food and Beverage Inventory',
        type: 'asset',
        subtype: 'inventory',
        parent: '1100',
      },
      {
        code: '4110',
        name: 'Food Sales',
        type: 'revenue',
        subtype: 'operating_revenue',
        parent: '4000',
      },
      {
        code: '4120',
        name: 'Beverage Sales',
        type: 'revenue',
        subtype: 'operating_revenue',
        parent: '4000',
      },
      {
        code: '4130',
        name: 'Delivery Revenue',
        type: 'revenue',
        subtype: 'operating_revenue',
        parent: '4000',
      },
      {
        code: '5110',
        name: 'Food Costs',
        type: 'expense',
        subtype: 'cost_of_goods_sold',
        parent: '5000',
      },
      {
        code: '5120',
        name: 'Beverage Costs',
        type: 'expense',
        subtype: 'cost_of_goods_sold',
        parent: '5000',
      },
      {
        code: '6210',
        name: 'Kitchen Supplies',
        type: 'expense',
        subtype: 'operating_expense',
        parent: '6000',
      },
      {
        code: '6220',
        name: 'Delivery Platform Fees',
        type: 'expense',
        subtype: 'operating_expense',
        parent: '6000',
      },
    ),
  },
  {
    key: 'saas',
    name: 'SaaS / Technology',
    description: 'Subscription businesses with deferred revenue and hosting costs.',
    accounts: extend(
      {
        code: '2150',
        name: 'Deferred Revenue',
        type: 'liability',
        subtype: 'other_current_liability',
        parent: '2100',
      },
      {
        code: '4110',
        name: 'Subscription Revenue',
        type: 'revenue',
        subtype: 'operating_revenue',
        parent: '4000',
      },
      {
        code: '4120',
        name: 'Implementation Revenue',
        type: 'revenue',
        subtype: 'operating_revenue',
        parent: '4000',
      },
      {
        code: '5110',
        name: 'Hosting and Infrastructure',
        type: 'expense',
        subtype: 'cost_of_goods_sold',
        parent: '5000',
      },
      {
        code: '5120',
        name: 'Third-Party Software',
        type: 'expense',
        subtype: 'cost_of_goods_sold',
        parent: '5000',
      },
      {
        code: '6210',
        name: 'Research and Development',
        type: 'expense',
        subtype: 'operating_expense',
        parent: '6000',
      },
      {
        code: '6220',
        name: 'Sales and Marketing',
        type: 'expense',
        subtype: 'operating_expense',
        parent: '6000',
      },
    ),
  },
  {
    key: 'manufacturing',
    name: 'Manufacturing',
    description: 'Producers tracking raw materials, WIP and finished goods.',
    accounts: extend(
      {
        code: '1160',
        name: 'Raw Materials',
        type: 'asset',
        subtype: 'inventory',
        parent: '1100',
      },
      {
        code: '1170',
        name: 'Work in Progress',
        type: 'asset',
        subtype: 'inventory',
        parent: '1100',
      },
      {
        code: '1180',
        name: 'Finished Goods',
        type: 'asset',
        subtype: 'inventory',
        parent: '1100',
      },
      {
        code: '5110',
        name: 'Direct Materials',
        type: 'expense',
        subtype: 'cost_of_goods_sold',
        parent: '5000',
      },
      {
        code: '5120',
        name: 'Direct Labour',
        type: 'expense',
        subtype: 'cost_of_goods_sold',
        parent: '5000',
      },
      {
        code: '5130',
        name: 'Manufacturing Overhead',
        type: 'expense',
        subtype: 'cost_of_goods_sold',
        parent: '5000',
      },
    ),
  },
];

export function getTemplate(key: string): CoaTemplate {
  const template = COA_TEMPLATES.find((t) => t.key === key);
  if (!template) {
    throw new Error(
      `Unknown chart-of-accounts template "${key}". Available: ${COA_TEMPLATES.map((t) => t.key).join(', ')}`,
    );
  }
  return template;
}
