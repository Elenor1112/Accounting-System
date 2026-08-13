/**
 * Inventory subledger and automatic cost of goods sold.
 *
 * The audit's finding was blunt: revenue was recognised with no matching cost,
 * so gross profit was overstated by the full cost of every unit sold and
 * inventory grew without bound. The brief's scenario:
 *
 *   Purchase inventory → inventory increases
 *   Sell inventory     → inventory decreases, COGS increases
 *   Gross profit is correct
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import { eq } from 'drizzle-orm';

import { closeDb, db } from '@/db';
import { products } from '@/db/schema';
import { ALL_PERMISSIONS } from '@/server/auth/permissions';
import { createContact } from '@/server/services/contact-service';
import { createDocument, postDocument } from '@/server/services/document-service';
import {
  adjustStock,
  createProduct,
  getInventoryValuation,
  getProduct,
  recordMovement,
} from '@/server/services/inventory-service';
import { getAccountBalance } from '@/server/services/journal-service';
import { getProfitAndLoss } from '@/server/services/report-service';

import { createTestCompany, destroyTestCompany, type TestCompany } from './harness';

describe('inventory and cost of goods sold', () => {
  let co: TestCompany;
  let customerId: string;
  let vendorId: string;

  const year = new Date().getUTCFullYear();
  const today = `${year}-06-15`;

  before(async () => {
    co = await createTestCompany({ permissions: ALL_PERMISSIONS });
    customerId = (
      await createContact(co.ctx, { kind: 'customer', displayName: 'Stock Customer' })
    ).id;
    vendorId = (
      await createContact(co.ctx, { kind: 'vendor', displayName: 'Stock Vendor' })
    ).id;
  });

  after(async () => {
    await destroyTestCompany(co);
    await closeDb();
  });

  const balanceOf = async (code: string) =>
    Number((await getAccountBalance(co.ctx, co.accountId(code))).balance);

  /** 1155 Inventory, 5100 COGS, 4100 Sales. */
  const stockValue = () => balanceOf('1155');
  const cogs = () => balanceOf('5100');

  test('a product is created with a SKU and no stock', async () => {
    const widget = await createProduct(co.ctx, {
      sku: 'WIDGET-1',
      name: 'Standard Widget',
      unit: 'each',
      sellingPrice: '150',
    });

    assert.equal(widget.kind, 'inventory');
    assert.equal(Number(widget.quantityOnHand), 0);
    assert.equal(Number(widget.averageCost), 0);
  });

  test('a purchase increases stock and sets the weighted average', async () => {
    const [widget] = await db
      .select()
      .from(products)
      .where(eq(products.sku, 'WIDGET-1'));

    const before = stockValue();

    // 100 units at 60 = 6,000.
    await recordMovement(co.ctx, {
      productId: widget!.id,
      movementDate: today,
      quantity: '100',
      unitCost: '60',
      movementType: 'purchase',
      // Paid from the bank. A direct purchase must name its credit side —
      // stock does not appear from nowhere, and defaulting it to an expense
      // account would manufacture negative cost of sales.
      counterAccountId: co.accountId('1120'),
    });

    const after = await getProduct(co.ctx, widget!.id);
    assert.equal(Number(after.product.quantityOnHand), 100);
    assert.equal(Number(after.product.averageCost), 60);
    assert.equal(Number(after.stockValue), 6000);

    // And the ledger agrees.
    assert.equal((await stockValue()) - (await before), 6000);
  });

  test('a second purchase at a different price moves the average', async () => {
    const [widget] = await db
      .select()
      .from(products)
      .where(eq(products.sku, 'WIDGET-1'));

    // 100 @ 60 = 6,000, plus 100 @ 80 = 8,000 → 200 units, 14,000, avg 70.
    await recordMovement(co.ctx, {
      productId: widget!.id,
      movementDate: today,
      quantity: '100',
      unitCost: '80',
      movementType: 'purchase',
      counterAccountId: co.accountId('1120'),
    });

    const after = await getProduct(co.ctx, widget!.id);
    assert.equal(Number(after.product.quantityOnHand), 200);
    assert.equal(
      Number(after.product.averageCost),
      70,
      'weighted average must be (6,000 + 8,000) / 200',
    );
    assert.equal(Number(after.stockValue), 14000);
  });

  test('selling stock relieves inventory and posts COGS automatically', async () => {
    const [widget] = await db
      .select()
      .from(products)
      .where(eq(products.sku, 'WIDGET-1'));

    const stockBefore = await stockValue();
    const cogsBefore = await cogs();
    const revenueBefore = await balanceOf('4100');

    // Sell 50 units at 150 = 7,500 revenue. Cost is 50 × 70 = 3,500.
    const invoice = await createDocument(co.ctx, {
      direction: 'outbound',
      documentType: 'invoice',
      contactId: customerId,
      issueDate: today,
      lines: [
        {
          description: 'Standard Widget',
          quantity: '50',
          unitPrice: '150',
          accountId: co.accountId('4100'),
          productId: widget!.id,
        },
      ],
    });
    await postDocument(co.approver, invoice.id);

    // Revenue recognised.
    assert.equal((await balanceOf('4100')) - revenueBefore, 7500);

    // The entry the system never used to make: cost recognised, stock relieved.
    assert.equal(
      (await cogs()) - cogsBefore,
      3500,
      'COGS must be 50 units at the weighted average of 70',
    );
    assert.equal(
      (await stockValue()) - stockBefore,
      -3500,
      'inventory must fall by the same amount',
    );

    // Stock quantity down; the average is unchanged by an outward movement.
    const after = await getProduct(co.ctx, widget!.id);
    assert.equal(Number(after.product.quantityOnHand), 150);
    assert.equal(Number(after.product.averageCost), 70);
  });

  test('gross profit is correct after the sale', async () => {
    // The whole point of the fix. Revenue 7,500 less cost 3,500 = 4,000.
    // Before COGS existed this read as 7,500 of gross profit on a sale that
    // actually earned 4,000.
    const pl = await getProfitAndLoss(co.ctx, {
      from: `${year}-01-01`,
      to: `${year}-12-31`,
    });

    assert.equal(Number(pl.totalRevenue), 7500);
    assert.equal(Number(pl.grossProfit), 4000, 'gross profit must be net of cost');
  });

  test('the inventory account equals quantity × average cost', async () => {
    // The subledger tie-out: if these ever disagree, one of the two is wrong
    // and the balance sheet cannot be trusted.
    const valuation = await getInventoryValuation(co.ctx, { asOf: today });
    const ledger = await stockValue();

    assert.equal(
      Number(valuation.totalValue),
      ledger,
      'the inventory valuation must tie to the inventory control account',
    );
    // 150 units at 70.
    assert.equal(Number(valuation.totalValue), 10500);
  });

  test('selling more than is on hand is refused', async () => {
    const [widget] = await db
      .select()
      .from(products)
      .where(eq(products.sku, 'WIDGET-1'));

    await assert.rejects(
      recordMovement(co.ctx, {
        productId: widget!.id,
        movementDate: today,
        quantity: '9999',
        movementType: 'sale',
      }),
      /only 150 on hand/,
    );
  });

  test('a purchase through a bill increases stock without double-posting', async () => {
    const gadget = await createProduct(co.ctx, {
      sku: 'GADGET-1',
      name: 'Gadget',
      sellingPrice: '400',
    });

    const stockBefore = await stockValue();

    // A bill already debits the inventory account through its own line, so the
    // movement must record quantity and cost without posting again.
    const bill = await createDocument(co.ctx, {
      direction: 'inbound',
      documentType: 'bill',
      contactId: vendorId,
      issueDate: today,
      lines: [
        {
          description: 'Gadget',
          quantity: '20',
          unitPrice: '250',
          accountId: co.accountId('1155'),
          productId: gadget.id,
        },
      ],
    });
    await postDocument(co.approver, bill.id);

    // 20 × 250 = 5,000, counted exactly once.
    assert.equal(
      (await stockValue()) - stockBefore,
      5000,
      'a bill must not debit inventory twice',
    );

    const after = await getProduct(co.ctx, gadget.id);
    assert.equal(Number(after.product.quantityOnHand), 20);
    assert.equal(Number(after.product.averageCost), 250);
  });

  test('a credit note returns stock and reverses the cost', async () => {
    const [widget] = await db
      .select()
      .from(products)
      .where(eq(products.sku, 'WIDGET-1'));

    const stockBefore = await stockValue();
    const cogsBefore = await cogs();

    // 10 units come back.
    const creditNote = await createDocument(co.ctx, {
      direction: 'outbound',
      documentType: 'credit_note',
      contactId: customerId,
      issueDate: today,
      lines: [
        {
          description: 'Returned widgets',
          quantity: '10',
          unitPrice: '150',
          accountId: co.accountId('4100'),
          productId: widget!.id,
        },
      ],
    });
    await postDocument(co.approver, creditNote.id);

    // Stock back in at 70, cost reversed by the same.
    assert.equal((await stockValue()) - stockBefore, 700);
    assert.equal((await cogs()) - cogsBefore, -700);

    const after = await getProduct(co.ctx, widget!.id);
    assert.equal(Number(after.product.quantityOnHand), 160);
  });

  test('a write-off reduces stock and charges the cost', async () => {
    const [widget] = await db
      .select()
      .from(products)
      .where(eq(products.sku, 'WIDGET-1'));

    const stockBefore = await stockValue();

    await adjustStock(co.ctx, {
      productId: widget!.id,
      quantity: '10',
      movementDate: today,
      direction: 'decrease',
      reason: 'Damaged in the warehouse',
    });

    assert.equal((await stockValue()) - stockBefore, -700);

    const after = await getProduct(co.ctx, widget!.id);
    assert.equal(Number(after.product.quantityOnHand), 150);
  });

  test('a stock adjustment requires a reason', async () => {
    const [widget] = await db
      .select()
      .from(products)
      .where(eq(products.sku, 'WIDGET-1'));

    await assert.rejects(
      adjustStock(co.ctx, {
        productId: widget!.id,
        quantity: '1',
        movementDate: today,
        direction: 'decrease',
        reason: '  ',
      }),
      /needs a reason/,
    );
  });

  test('a direct purchase with no counter account is refused', async () => {
    // Stock cannot appear from nowhere. Before this guard the routine credited
    // Cost of Goods Sold, manufacturing negative cost of sales and overstating
    // gross profit by the value of every unit received.
    const [widget] = await db
      .select()
      .from(products)
      .where(eq(products.sku, 'WIDGET-1'));

    await assert.rejects(
      recordMovement(co.ctx, {
        productId: widget!.id,
        movementDate: today,
        quantity: '5',
        unitCost: '70',
        movementType: 'purchase',
      }),
      /needs a counter account/,
    );
  });

  test('a service product carries no stock and cannot move', async () => {
    const service = await createProduct(co.ctx, {
      sku: 'CONSULT-1',
      name: 'Consulting hour',
      kind: 'service',
      sellingPrice: '200',
    });

    await assert.rejects(
      recordMovement(co.ctx, {
        productId: service.id,
        movementDate: today,
        quantity: '1',
        unitCost: '50',
        movementType: 'purchase',
      }),
      /is a service and carries no stock/,
    );
  });

  test('selling a service posts revenue with no COGS', async () => {
    const [service] = await db
      .select()
      .from(products)
      .where(eq(products.sku, 'CONSULT-1'));

    const cogsBefore = await cogs();
    const revenueBefore = await balanceOf('4100');

    const invoice = await createDocument(co.ctx, {
      direction: 'outbound',
      documentType: 'invoice',
      contactId: customerId,
      issueDate: today,
      lines: [
        {
          description: 'Consulting',
          quantity: '5',
          unitPrice: '200',
          accountId: co.accountId('4100'),
          productId: service!.id,
        },
      ],
    });
    await postDocument(co.approver, invoice.id);

    assert.equal((await balanceOf('4100')) - revenueBefore, 1000);
    assert.equal(
      (await cogs()) - cogsBefore,
      0,
      'a service has no cost of sale to recognise',
    );
  });

  test('the inventory valuation still ties to the ledger after every movement', async () => {
    const valuation = await getInventoryValuation(co.ctx, { asOf: today });
    assert.equal(Number(valuation.totalValue), await stockValue());
  });
});
