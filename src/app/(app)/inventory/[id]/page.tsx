import Link from 'next/link';
import { notFound } from 'next/navigation';

import { Badge, Card, PageHeader, SectionTitle, Stat, TableWrap } from '@/components/ui';
import * as fmt from '@/lib/format';
import { requireTenantContext } from '@/server/auth/session';
import { NotFoundError } from '@/server/errors';
import { getProduct } from '@/server/services/inventory-service';

export const dynamic = 'force-dynamic';

export default async function ProductDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const ctx = await requireTenantContext();

  let data: Awaited<ReturnType<typeof getProduct>>;
  try {
    data = await getProduct(ctx, id);
  } catch (err) {
    if (err instanceof NotFoundError) notFound();
    throw err;
  }

  const { product, movements, stockValue } = data;
  const asMoney = (value: string) =>
    fmt.money(value, {
      currency: ctx.baseCurrencyCode,
      precision: ctx.currencyPrecision,
    });

  return (
    <>
      <div className="mb-4">
        <Link href="/inventory" className="text-xs text-muted-foreground hover:text-foreground">
          ← Inventory
        </Link>
      </div>

      <PageHeader
        title={product.name}
        description={product.sku}
        actions={
          <Badge tone={product.kind === 'inventory' ? 'accent' : 'neutral'}>
            {product.kind === 'inventory' ? 'Stocked' : 'Service'}
          </Badge>
        }
      />

      <div className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="On hand"
          value={`${fmt.money(product.quantityOnHand, { precision: 0 })} ${product.unit}`}
        />
        <Stat label="Weighted average cost" value={asMoney(product.averageCost)} />
        <Stat label="Stock value" value={asMoney(stockValue)} />
        <Stat label="Selling price" value={asMoney(product.sellingPrice)} />
      </div>

      <Card>
        <SectionTitle>Details</SectionTitle>
        <dl className="space-y-1.5 text-sm">
          <div className="flex justify-between">
            <dt className="text-muted-foreground">Category</dt>
            <dd>{product.category ?? '—'}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-muted-foreground">Unit</dt>
            <dd>{product.unit}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-muted-foreground">Description</dt>
            <dd className="text-right">{product.description ?? '—'}</dd>
          </div>
        </dl>
      </Card>

      <div className="mt-5">
        <SectionTitle>Stock movements</SectionTitle>
        <TableWrap>
          <table className="w-full text-sm">
            <thead>
              <tr>
                <th className="th-base">Date</th>
                <th className="th-base">Type</th>
                <th className="th-base text-right">Quantity</th>
                <th className="th-base text-right">Unit cost</th>
                <th className="th-base text-right">Value</th>
                <th className="th-base text-right">On hand after</th>
                <th className="th-base text-right">Avg cost after</th>
                <th className="th-base">Note</th>
              </tr>
            </thead>
            <tbody>
              {movements.length === 0 ? (
                <tr>
                  <td className="td-base text-muted-foreground" colSpan={8}>
                    No movements recorded.
                  </td>
                </tr>
              ) : (
                movements.map((m) => {
                  const isInward = !m.quantity.startsWith('-');
                  return (
                    <tr key={m.id}>
                      <td className="td-base text-muted-foreground">
                        {fmt.date(m.movementDate)}
                      </td>
                      <td className="td-base">
                        <Badge tone={isInward ? 'positive' : 'neutral'}>
                          {fmt.humanise(m.movementType)}
                        </Badge>
                      </td>
                      <td
                        className={`td-base num text-right ${
                          isInward ? 'text-positive' : 'text-negative'
                        }`}
                      >
                        {fmt.money(m.quantity, { precision: 0 })}
                      </td>
                      <td className="td-base num text-right">{asMoney(m.unitCost)}</td>
                      <td className="td-base num text-right">{asMoney(m.totalCost)}</td>
                      <td className="td-base num text-right">
                        {fmt.money(m.quantityAfter, { precision: 0 })}
                      </td>
                      <td className="td-base num text-right">
                        {asMoney(m.averageCostAfter)}
                      </td>
                      <td className="td-base text-xs text-muted-foreground">
                        {m.notes ?? ''}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </TableWrap>
      </div>

      <p className="mt-3 text-xs text-muted-foreground">
        Costing is weighted average: a receipt moves the average, and a sale is valued
        at the average current at that moment. Every valued movement posts to the
        ledger, so this history and the inventory account always agree.
      </p>
    </>
  );
}
