import Link from 'next/link';

import { DataTable, Pagination, type Column } from '@/components/data-table';
import { FilterBar } from '@/components/filter-bar';
import { Badge, PageHeader, Stat } from '@/components/ui';
import * as fmt from '@/lib/format';
import { requireTenantContext } from '@/server/auth/session';
import {
  getInventoryValuation,
  listProducts,
} from '@/server/services/inventory-service';

export const metadata = { title: 'Inventory — LedgerBase' };
export const dynamic = 'force-dynamic';

const PAGE_SIZE = 30;

type Row = Awaited<ReturnType<typeof listProducts>>[number];

export default async function InventoryPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const params = await searchParams;
  const ctx = await requireTenantContext();
  const page = Math.max(1, Number(params.page ?? '1'));

  const [rows, valuation] = await Promise.all([
    listProducts(ctx, {
      search: params.q,
      kind: params.kind as 'inventory' | 'service' | undefined,
      includeInactive: params.status === 'all',
      limit: PAGE_SIZE + 1,
      offset: (page - 1) * PAGE_SIZE,
    }),
    getInventoryValuation(ctx),
  ]);

  const hasMore = rows.length > PAGE_SIZE;
  const visible = hasMore ? rows.slice(0, PAGE_SIZE) : rows;

  const asMoney = (value: string) =>
    fmt.money(value, {
      currency: ctx.baseCurrencyCode,
      precision: ctx.currencyPrecision,
    });

  const columns: Column<Row>[] = [
    {
      key: 'sku',
      header: 'SKU',
      width: '130px',
      render: (row) => (
        <Link
          href={`/inventory/${row.id}`}
          className="tabular font-medium text-accent hover:underline"
        >
          {row.sku}
        </Link>
      ),
    },
    { key: 'name', header: 'Name', render: (row) => row.name },
    {
      key: 'kind',
      header: 'Type',
      render: (row) => (
        <Badge tone={row.kind === 'inventory' ? 'accent' : 'neutral'}>
          {row.kind === 'inventory' ? 'Stocked' : 'Service'}
        </Badge>
      ),
    },
    {
      key: 'onHand',
      header: 'On hand',
      align: 'right',
      render: (row) =>
        row.kind === 'service' ? (
          <span className="text-muted-foreground">—</span>
        ) : (
          <span className="num">
            {fmt.money(row.quantityOnHand, { precision: 0 })} {row.unit}
          </span>
        ),
    },
    {
      key: 'avgCost',
      header: 'Avg cost',
      align: 'right',
      render: (row) =>
        row.kind === 'service' ? (
          <span className="text-muted-foreground">—</span>
        ) : (
          asMoney(row.averageCost)
        ),
    },
    {
      key: 'value',
      header: 'Stock value',
      align: 'right',
      render: (row) =>
        row.kind === 'service' ? (
          <span className="text-muted-foreground">—</span>
        ) : (
          <span className="font-medium">{asMoney(row.stockValue)}</span>
        ),
    },
    {
      key: 'price',
      header: 'Selling price',
      align: 'right',
      render: (row) => asMoney(row.sellingPrice),
    },
  ];

  return (
    <>
      <PageHeader
        title="Inventory"
        description="Items you stock and sell. Selling a stocked item relieves inventory and records its cost automatically."
      />

      <div className="mb-5 grid gap-3 sm:grid-cols-3">
        <Stat label="Stock value" value={asMoney(valuation.totalValue)} />
        <Stat label="Items tracked" value={String(valuation.items.length)} />
        <Stat label="Costing method" value="Weighted average" />
      </div>

      <FilterBar
        basePath="/inventory"
        searchParams={params}
        searchPlaceholder="Search by SKU or name…"
        selects={[
          {
            name: 'kind',
            label: 'Type',
            options: [
              { value: '', label: 'All types' },
              { value: 'inventory', label: 'Stocked' },
              { value: 'service', label: 'Services' },
            ],
          },
          {
            name: 'status',
            label: 'Status',
            options: [
              { value: '', label: 'Active only' },
              { value: 'all', label: 'Active and inactive' },
            ],
          },
        ]}
      />

      <DataTable
        rows={visible}
        columns={columns}
        getRowKey={(row) => row.id}
        empty={{
          title: 'No products yet',
          description:
            'Add a product to start tracking stock, or a service to bill time without stock.',
        }}
      />

      <Pagination
        basePath="/inventory"
        searchParams={params}
        page={page}
        hasMore={hasMore}
      />
    </>
  );
}
