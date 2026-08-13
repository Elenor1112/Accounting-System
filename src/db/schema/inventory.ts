import { relations, sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  foreignKey,
  index,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { amount, primaryKeyId, timestamps } from './_shared';
import { users } from './identity';
import { accounts } from './ledger';
import { branches, companies } from './tenancy';

/**
 * The item master (spec §16, audit finding: inventory had no subledger).
 *
 * Products come in two kinds. A `service` is billed and never stocked — it has
 * a revenue account and nothing else. An `inventory` product is stocked, and
 * selling one *must* relieve inventory and recognise cost, or revenue is
 * recognised with no matching cost and both profit and assets are overstated
 * on every sale.
 *
 * Costing is weighted average, held on the product itself as `averageCost`.
 * WAC rather than FIFO because a single moving average is far easier for an
 * SMB to reason about and to explain to an auditor than a stack of layers, and
 * it needs no layer table to stay correct under partial sales and returns.
 */
export const products = pgTable(
  'products',
  {
    id: primaryKeyId(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),

    sku: text('sku').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    category: text('category'),
    /** Each, kg, hour — presentation only; the ledger is unit-agnostic. */
    unit: text('unit').notNull().default('each'),

    kind: text('kind', { enum: ['inventory', 'service'] })
      .notNull()
      .default('inventory'),

    /**
     * Weighted average cost per unit, maintained by the movement service.
     *
     * This is the one derived figure the inventory subledger stores, and it is
     * recomputed from the movement it accompanies inside the same transaction —
     * `quantityOnHand` and `averageCost` are always written together, so the
     * inventory account balance and quantity × cost cannot drift apart.
     */
    averageCost: amount('average_cost').notNull().default('0'),
    quantityOnHand: amount('quantity_on_hand').notNull().default('0'),

    /** Default selling price; a document line may still override it. */
    sellingPrice: amount('selling_price').notNull().default('0'),

    /** Where value lands. Resolved per product so a client can split by line. */
    inventoryAccountId: uuid('inventory_account_id').references(() => accounts.id, {
      onDelete: 'restrict',
    }),
    cogsAccountId: uuid('cogs_account_id').references(() => accounts.id, {
      onDelete: 'restrict',
    }),
    revenueAccountId: uuid('revenue_account_id').references(() => accounts.id, {
      onDelete: 'restrict',
    }),

    taxId: uuid('tax_id'),

    isActive: boolean('is_active').notNull().default(true),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('products_company_sku_key').on(t.companyId, t.sku),
    index('products_company_active_idx').on(t.companyId, t.isActive),
    index('products_company_name_idx').on(t.companyId, t.name),
    unique('products_id_company_key').on(t.id, t.companyId),
    /**
     * Stock and cost can never be negative in a weighted-average system: a
     * negative average cost is meaningless, and negative stock means a sale was
     * allowed that the subledger cannot value.
     */
    check('products_avg_cost_nonneg_ck', sql`${t.averageCost} >= 0`),
    check('products_qty_nonneg_ck', sql`${t.quantityOnHand} >= 0`),
    check('products_selling_price_nonneg_ck', sql`${t.sellingPrice} >= 0`),
  ],
);

/**
 * The perpetual stock ledger: one row per movement, never updated.
 *
 * Every row records the quantity and unit cost that moved, and the resulting
 * on-hand position, so the subledger can be replayed and tied to the inventory
 * control account at any date. This is the inventory equivalent of a journal
 * line: history is appended, not edited.
 */
export const stockMovements = pgTable(
  'stock_movements',
  {
    id: primaryKeyId(),
    companyId: uuid('company_id').notNull(),
    productId: uuid('product_id').notNull(),

    movementDate: date('movement_date').notNull(),

    /**
     * `purchase` and `sale` come from bills and invoices; `adjustment` and
     * `write_off` are deliberate corrections; `return_in`/`return_out` reverse
     * a sale or a purchase; `opening` seeds a migrated balance.
     */
    movementType: text('movement_type', {
      enum: [
        'purchase',
        'sale',
        'return_in',
        'return_out',
        'adjustment',
        'write_off',
        'opening',
      ],
    }).notNull(),

    /** Signed: positive brings stock in, negative takes it out. */
    quantity: amount('quantity').notNull(),
    /** Cost per unit for this movement. For an outward move, the WAC used. */
    unitCost: amount('unit_cost').notNull().default('0'),
    /** quantity × unitCost, the amount posted to the ledger. */
    totalCost: amount('total_cost').notNull().default('0'),

    /** Position after this movement, for point-in-time valuation. */
    quantityAfter: amount('quantity_after').notNull(),
    averageCostAfter: amount('average_cost_after').notNull().default('0'),

    /** The document or entry that caused it. */
    sourceType: text('source_type').notNull().default('manual'),
    sourceId: uuid('source_id'),
    journalEntryId: uuid('journal_entry_id'),

    branchId: uuid('branch_id').references(() => branches.id, { onDelete: 'restrict' }),
    notes: text('notes'),
    createdById: uuid('created_by_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamps.createdAt,
  },
  (t) => [
    index('stock_movements_product_idx').on(t.companyId, t.productId, t.movementDate),
    index('stock_movements_source_idx').on(t.companyId, t.sourceType, t.sourceId),
    index('stock_movements_date_idx').on(t.companyId, t.movementDate),
    /** Tenant-carrying composite FK, as everywhere else in the ledger. */
    foreignKey({
      columns: [t.productId, t.companyId],
      foreignColumns: [products.id, products.companyId],
      name: 'stock_movements_product_company_fk',
    }).onDelete('restrict'),
    /** A zero-quantity movement records nothing and would corrupt the average. */
    check('stock_movements_qty_nonzero_ck', sql`${t.quantity} <> 0`),
    check('stock_movements_unit_cost_nonneg_ck', sql`${t.unitCost} >= 0`),
    check('stock_movements_qty_after_nonneg_ck', sql`${t.quantityAfter} >= 0`),
  ],
);

export const productsRelations = relations(products, ({ one, many }) => ({
  company: one(companies, {
    fields: [products.companyId],
    references: [companies.id],
  }),
  inventoryAccount: one(accounts, {
    fields: [products.inventoryAccountId],
    references: [accounts.id],
    relationName: 'product_inventory_account',
  }),
  cogsAccount: one(accounts, {
    fields: [products.cogsAccountId],
    references: [accounts.id],
    relationName: 'product_cogs_account',
  }),
  revenueAccount: one(accounts, {
    fields: [products.revenueAccountId],
    references: [accounts.id],
    relationName: 'product_revenue_account',
  }),
  movements: many(stockMovements),
}));

export const stockMovementsRelations = relations(stockMovements, ({ one }) => ({
  product: one(products, {
    fields: [stockMovements.productId],
    references: [products.id],
  }),
  branch: one(branches, {
    fields: [stockMovements.branchId],
    references: [branches.id],
  }),
}));
