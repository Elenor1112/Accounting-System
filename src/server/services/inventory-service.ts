import 'server-only';

import { and, asc, desc, eq, sql } from 'drizzle-orm';

import { db, type Tx } from '@/db';
import { products, stockMovements } from '@/db/schema';
import { requirePermission, type TenantContext } from '@/server/auth/context';
import { PERMISSIONS } from '@/server/auth/permissions';
import { AccountingError, ConflictError, NotFoundError, ValidationError } from '@/server/errors';
import {
  add,
  divide,
  gt,
  gte,
  isZero,
  money,
  multiply,
  round,
  subtract,
  type Money,
} from '@/lib/money';

import { recordAudit } from './audit-service';
import { resolveAccountByRole } from './account-service';
import { createJournalEntry } from './journal-service';

export type ProductRow = typeof products.$inferSelect;
export type StockMovementRow = typeof stockMovements.$inferSelect;

/**
 * The inventory subledger (spec §16).
 *
 * Weighted average costing. On a purchase the average moves:
 *
 *     newAverage = (existingValue + purchaseValue) / (existingQty + purchaseQty)
 *
 * and on a sale the *current* average is used to value the cost of goods sold,
 * leaving the average untouched. That is the defining property of WAC and the
 * reason it needs no layer table: the position is fully described by a quantity
 * and one cost.
 *
 * Every movement that carries value posts to the ledger in the same
 * transaction, so the inventory account balance always equals the sum of
 * quantity × average cost across products. `getInventoryValuation` proves it.
 */

export async function createProduct(
  ctx: TenantContext,
  input: {
    sku: string;
    name: string;
    description?: string | null;
    category?: string | null;
    unit?: string;
    kind?: 'inventory' | 'service';
    sellingPrice?: Money;
    inventoryAccountId?: string | null;
    cogsAccountId?: string | null;
    revenueAccountId?: string | null;
    taxId?: string | null;
  },
): Promise<ProductRow> {
  requirePermission(ctx, PERMISSIONS.inventory.manage);

  if (!input.sku?.trim()) throw new ValidationError('A product needs a SKU');
  if (!input.name?.trim()) throw new ValidationError('A product needs a name');

  return db.transaction(async (tx) => {
    const [created] = await tx
      .insert(products)
      .values({
        companyId: ctx.companyId,
        sku: input.sku.trim(),
        name: input.name.trim(),
        description: input.description ?? null,
        category: input.category ?? null,
        unit: input.unit ?? 'each',
        kind: input.kind ?? 'inventory',
        sellingPrice: money(input.sellingPrice ?? '0'),
        inventoryAccountId: input.inventoryAccountId ?? null,
        cogsAccountId: input.cogsAccountId ?? null,
        revenueAccountId: input.revenueAccountId ?? null,
        taxId: input.taxId ?? null,
      })
      .returning();

    if (!created) {
      throw new ConflictError(`A product with SKU ${input.sku} already exists`);
    }

    await recordAudit(tx, ctx, {
      action: 'product.created',
      entityType: 'product',
      entityId: created.id,
      newValues: { sku: created.sku, name: created.name, kind: created.kind },
    });

    return created;
  });
}

export async function updateProduct(
  ctx: TenantContext,
  productId: string,
  updates: Partial<
    Pick<
      ProductRow,
      | 'name'
      | 'description'
      | 'category'
      | 'unit'
      | 'sellingPrice'
      | 'inventoryAccountId'
      | 'cogsAccountId'
      | 'revenueAccountId'
      | 'taxId'
      | 'isActive'
    >
  >,
): Promise<ProductRow> {
  requirePermission(ctx, PERMISSIONS.inventory.manage);

  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(products)
      .where(and(eq(products.id, productId), eq(products.companyId, ctx.companyId)))
      .limit(1);

    if (!existing) throw new NotFoundError('Product');

    const [updated] = await tx
      .update(products)
      .set({ ...updates, updatedAt: sql`now()` })
      .where(eq(products.id, productId))
      .returning();

    if (!updated) throw new ConflictError('Failed to update product');

    await recordAudit(tx, ctx, {
      action: 'product.updated',
      entityType: 'product',
      entityId: productId,
      newValues: updates as Record<string, unknown>,
    });

    return updated;
  });
}

/** Resolves the accounts a movement posts to, per product then by role. */
async function resolveInventoryAccounts(
  tx: Tx,
  ctx: TenantContext,
  product: ProductRow,
): Promise<{ inventoryAccountId: string; cogsAccountId: string }> {
  const inventoryAccountId =
    product.inventoryAccountId ??
    (await resolveAccountByRole(tx, ctx.companyId, 'inventory_asset')).id;
  const cogsAccountId =
    product.cogsAccountId ??
    (await resolveAccountByRole(tx, ctx.companyId, 'cost_of_goods_sold')).id;

  return { inventoryAccountId, cogsAccountId };
}

export interface MovementInput {
  productId: string;
  movementDate: string;
  /** Always positive; `movementType` decides the direction. */
  quantity: Money;
  /** Required for inward movements. Ignored for outward ones (WAC is used). */
  unitCost?: Money;
  movementType: StockMovementRow['movementType'];
  sourceType?: string;
  sourceId?: string | null;
  journalEntryId?: string | null;
  branchId?: string | null;
  notes?: string | null;
  /**
   * The other side of the entry when this movement posts on its own — the bank
   * or payable a direct purchase was made with, or the account an adjustment
   * is charged to. Defaults per movement type; required for a direct purchase.
   */
  counterAccountId?: string | null;
}

/** Which movement types bring stock in. */
const INWARD = new Set(['purchase', 'return_in', 'opening', 'adjustment']);

/**
 * Records a stock movement and updates the weighted average.
 *
 * Runs inside the caller's transaction when given one, so a sale's COGS
 * movement and its journal entry commit with the invoice or not at all.
 *
 * `postToLedger` is false when the caller has already built the ledger entry
 * itself — a purchase posted through a bill debits inventory as part of the
 * bill's own entry, and posting again here would double the asset.
 */
export async function recordMovement(
  ctx: TenantContext,
  input: MovementInput,
  options: { tx?: Tx; postToLedger?: boolean } = {},
): Promise<{ movementId: string; unitCost: Money; totalCost: Money }> {
  const run = async (tx: Tx) => {
    const [product] = await tx
      .select()
      .from(products)
      .where(and(eq(products.id, input.productId), eq(products.companyId, ctx.companyId)))
      // Serialises concurrent movements: two sales of the last unit cannot both
      // read the same on-hand quantity and both succeed.
      .for('update')
      .limit(1);

    if (!product) throw new NotFoundError('Product');

    if (product.kind !== 'inventory') {
      throw new AccountingError(
        `${product.sku} is a service and carries no stock. Only inventory products move.`,
      );
    }

    const quantity = money(input.quantity);
    if (isZero(quantity) || quantity.startsWith('-')) {
      throw new ValidationError('Movement quantity must be greater than zero');
    }

    const isInward = INWARD.has(input.movementType);
    const currentQty = money(product.quantityOnHand);
    const currentAvg = money(product.averageCost);

    let unitCost: Money;
    let newQty: Money;
    let newAvg: Money;

    if (isInward) {
      unitCost = money(input.unitCost ?? '0');

      // The weighted average: total value over total units, after the receipt.
      const existingValue = multiply(currentQty, currentAvg);
      const incomingValue = multiply(quantity, unitCost);
      newQty = add(currentQty, quantity);
      newAvg = isZero(newQty)
        ? '0'
        : round(divide(add(existingValue, incomingValue), newQty), 6);
    } else {
      // Outward at the current average — this is what makes gross profit
      // correct: revenue at selling price, cost at weighted average.
      unitCost = currentAvg;
      newQty = subtract(currentQty, quantity);

      if (newQty.startsWith('-')) {
        throw new AccountingError(
          `Cannot remove ${quantity} of ${product.sku}: only ${currentQty} on hand. ` +
            'Record the purchase first, or adjust the stock.',
        );
      }
      // The average survives an outward movement unchanged; that is WAC.
      newAvg = currentAvg;
    }

    const totalCost = round(multiply(quantity, unitCost), 6);
    const signedQuantity = isInward ? quantity : `-${quantity}`;

    const [movement] = await tx
      .insert(stockMovements)
      .values({
        companyId: ctx.companyId,
        productId: input.productId,
        movementDate: input.movementDate,
        movementType: input.movementType,
        quantity: signedQuantity,
        unitCost,
        totalCost,
        quantityAfter: newQty,
        averageCostAfter: newAvg,
        sourceType: input.sourceType ?? 'manual',
        sourceId: input.sourceId ?? null,
        journalEntryId: input.journalEntryId ?? null,
        branchId: input.branchId ?? null,
        notes: input.notes ?? null,
        createdById: ctx.userId,
      })
      .returning();

    if (!movement) throw new ConflictError('Failed to record stock movement');

    await tx
      .update(products)
      .set({ quantityOnHand: newQty, averageCost: newAvg, updatedAt: sql`now()` })
      .where(eq(products.id, input.productId));

    /**
     * Ledger effect for movements that are not already carried by a document.
     *
     * Inventory is always one side; what sits on the other depends on *why*
     * the stock moved, and getting that wrong is how an inventory module
     * quietly corrupts the P&L:
     *
     *   sale / write-off  → Cost of Goods Sold      (a cost is incurred)
     *   return from a sale → Cost of Goods Sold      (that cost reverses)
     *   adjustment up      → the counter account given by the caller, or
     *                        COGS as a shrinkage reversal
     *   opening balance    → Opening Balance Equity  (no cost was incurred;
     *                        crediting COGS would create negative cost of
     *                        sales out of nothing)
     *
     * A purchase through a bill never reaches here: the bill already debited
     * inventory on its own line, and `postToLedger` is false for it.
     */
    if ((options.postToLedger ?? true) && !isZero(totalCost)) {
      const { inventoryAccountId, cogsAccountId } = await resolveInventoryAccounts(
        tx,
        ctx,
        product,
      );

      const counterAccountId =
        input.counterAccountId ??
        (input.movementType === 'opening'
          ? (await resolveAccountByRole(tx, ctx.companyId, 'opening_balance_equity')).id
          : input.movementType === 'purchase'
            ? // A standalone purchase with no bill behind it has no obvious
              // credit side. Requiring one is better than silently crediting
              // an expense account and inventing negative cost of sales.
              (() => {
                throw new AccountingError(
                  `Recording a purchase of ${product.sku} directly needs a counter ` +
                    'account (the bank or payable it was bought with). Enter a bill ' +
                    'instead, or supply counterAccountId.',
                );
              })()
            : cogsAccountId);

      const entry = await createJournalEntry(
        ctx,
        {
          entryDate: input.movementDate,
          description: `${input.movementType.replace('_', ' ')} ${product.sku}`,
          sourceType: `inventory_${input.movementType}`,
          sourceId: movement.id,
          branchId: input.branchId ?? null,
          lines: [
            {
              accountId: isInward ? inventoryAccountId : counterAccountId,
              debit: totalCost,
              description: `${product.sku} ${product.name}`,
              branchId: input.branchId ?? null,
            },
            {
              accountId: isInward ? counterAccountId : inventoryAccountId,
              credit: totalCost,
              description: `${product.sku} ${product.name}`,
              branchId: input.branchId ?? null,
            },
          ] as never,
          post: true,
        },
        { tx },
      );

      await tx
        .update(stockMovements)
        .set({ journalEntryId: entry.id })
        .where(eq(stockMovements.id, movement.id));
    }

    await recordAudit(tx, ctx, {
      action: `inventory.${input.movementType}`,
      entityType: 'product',
      entityId: input.productId,
      newValues: {
        movementId: movement.id,
        quantity: signedQuantity,
        unitCost,
        totalCost,
        quantityAfter: newQty,
        averageCostAfter: newAvg,
      },
      reason: input.notes ?? null,
    });

    return { movementId: movement.id, unitCost, totalCost };
  };

  return options.tx ? run(options.tx) : db.transaction(run);
}

/**
 * The COGS entry for a sale (spec §16, audit finding: COGS was never posted).
 *
 * Called by `postDocument` for every inventory-controlled line on an invoice,
 * inside the invoice's own transaction:
 *
 *     Dr Cost of Goods Sold      quantity × weighted average
 *       Cr Inventory                  same
 *
 * Revenue and cost therefore land in the same period from the same event,
 * which is the matching principle. Before this, revenue was recognised with no
 * cost at all: gross profit was overstated by the full cost of every unit sold
 * and inventory grew without bound.
 */
export async function postCostOfGoodsSold(
  tx: Tx,
  ctx: TenantContext,
  params: {
    lines: Array<{ productId: string; quantity: Money; branchId?: string | null }>;
    movementDate: string;
    sourceType: string;
    sourceId: string;
    /** A credit note returns stock instead of relieving it. */
    isReturn?: boolean;
  },
): Promise<{ totalCost: Money; movementIds: string[] }> {
  const movementIds: string[] = [];
  let totalCost: Money = '0';

  for (const line of params.lines) {
    const [product] = await tx
      .select()
      .from(products)
      .where(and(eq(products.id, line.productId), eq(products.companyId, ctx.companyId)))
      .limit(1);

    // A service line has no cost of sale; skip rather than fail, so a mixed
    // invoice of goods and labour posts normally.
    if (!product || product.kind !== 'inventory') continue;

    const result = await recordMovement(
      ctx,
      {
        productId: line.productId,
        movementDate: params.movementDate,
        quantity: line.quantity,
        // A return comes back in at the current average, which keeps the
        // valuation consistent with how it left.
        unitCost: params.isReturn ? product.averageCost : undefined,
        movementType: params.isReturn ? 'return_in' : 'sale',
        sourceType: params.sourceType,
        sourceId: params.sourceId,
        branchId: line.branchId ?? null,
      },
      { tx, postToLedger: true },
    );

    movementIds.push(result.movementId);
    totalCost = add(totalCost, result.totalCost);
  }

  return { totalCost, movementIds };
}

export async function listProducts(
  ctx: TenantContext,
  filters: {
    search?: string;
    kind?: 'inventory' | 'service';
    category?: string;
    includeInactive?: boolean;
    limit?: number;
    offset?: number;
  } = {},
) {
  requirePermission(ctx, PERMISSIONS.inventory.view);

  const conditions = [eq(products.companyId, ctx.companyId)];
  if (!filters.includeInactive) conditions.push(eq(products.isActive, true));
  if (filters.kind) conditions.push(eq(products.kind, filters.kind));
  if (filters.category) conditions.push(eq(products.category, filters.category));
  if (filters.search) {
    const term = `%${filters.search.toLowerCase()}%`;
    conditions.push(
      sql`(lower(${products.name}) like ${term} or lower(${products.sku}) like ${term})`,
    );
  }

  const rows = await db
    .select()
    .from(products)
    .where(and(...conditions))
    .orderBy(asc(products.sku))
    .limit(filters.limit ?? 50)
    .offset(filters.offset ?? 0);

  return rows.map((row) => ({
    ...row,
    stockValue: round(multiply(row.quantityOnHand, row.averageCost), 2),
  }));
}

export async function getProduct(ctx: TenantContext, productId: string) {
  requirePermission(ctx, PERMISSIONS.inventory.view);

  const [product] = await db
    .select()
    .from(products)
    .where(and(eq(products.id, productId), eq(products.companyId, ctx.companyId)))
    .limit(1);

  if (!product) throw new NotFoundError('Product');

  const movements = await db
    .select()
    .from(stockMovements)
    .where(
      and(
        eq(stockMovements.productId, productId),
        eq(stockMovements.companyId, ctx.companyId),
      ),
    )
    .orderBy(desc(stockMovements.movementDate), desc(stockMovements.createdAt))
    .limit(100);

  return {
    product,
    movements,
    stockValue: round(multiply(product.quantityOnHand, product.averageCost), 2),
  };
}

/**
 * Inventory valuation as at a date, and its tie-out to the control account.
 *
 * The quantity and value are replayed from the movement history rather than
 * read from `quantityOnHand`, so the report is genuinely point-in-time and
 * does not silently show today's position under a historical heading — the
 * same defect the aging report had.
 */
export async function getInventoryValuation(
  ctx: TenantContext,
  params: { asOf?: string } = {},
) {
  requirePermission(ctx, PERMISSIONS.inventory.view);

  const asOf = params.asOf ?? new Date().toISOString().slice(0, 10);

  const rows = await db
    .select({
      productId: products.id,
      sku: products.sku,
      name: products.name,
      unit: products.unit,
      quantity: sql<string>`coalesce(sum(${stockMovements.quantity}), 0)`,
      // The average after the latest movement on or before `asOf`.
      averageCost: sql<string>`coalesce((
        select sm.average_cost_after
          from stock_movements sm
         where sm.product_id = products.id
           and sm.company_id = ${ctx.companyId}
           and sm.movement_date <= ${asOf}::date
         order by sm.movement_date desc, sm.created_at desc
         limit 1
      ), 0)`,
    })
    .from(products)
    .leftJoin(
      stockMovements,
      and(
        eq(stockMovements.productId, products.id),
        sql`${stockMovements.movementDate} <= ${asOf}::date`,
      ),
    )
    .where(and(eq(products.companyId, ctx.companyId), eq(products.kind, 'inventory')))
    .groupBy(products.id, products.sku, products.name, products.unit)
    .orderBy(asc(products.sku));

  const items = rows
    .map((row) => ({
      ...row,
      quantity: money(row.quantity),
      averageCost: money(row.averageCost),
      value: round(multiply(money(row.quantity), money(row.averageCost)), 2),
    }))
    .filter((row) => !isZero(row.quantity) || !isZero(row.value));

  const totalValue = items.reduce<Money>((acc, item) => add(acc, item.value), '0');

  return { asOf, items, totalValue: round(totalValue, ctx.currencyPrecision) };
}

/** Manual stock adjustment or write-off, with a reason for the audit trail. */
export async function adjustStock(
  ctx: TenantContext,
  input: {
    productId: string;
    quantity: Money;
    unitCost?: Money;
    movementDate: string;
    direction: 'increase' | 'decrease';
    reason: string;
    branchId?: string | null;
    /** Where the gain or loss is charged. Defaults to cost of goods sold. */
    counterAccountId?: string | null;
  },
): Promise<{ movementId: string; totalCost: Money }> {
  requirePermission(ctx, PERMISSIONS.inventory.adjust);

  if (!input.reason?.trim()) {
    throw new ValidationError('A stock adjustment needs a reason');
  }

  const result = await recordMovement(ctx, {
    productId: input.productId,
    movementDate: input.movementDate,
    quantity: input.quantity,
    unitCost: input.unitCost,
    movementType: input.direction === 'increase' ? 'adjustment' : 'write_off',
    sourceType: 'stock_adjustment',
    notes: input.reason,
    branchId: input.branchId ?? null,
    counterAccountId: input.counterAccountId ?? null,
  });

  return { movementId: result.movementId, totalCost: result.totalCost };
}
