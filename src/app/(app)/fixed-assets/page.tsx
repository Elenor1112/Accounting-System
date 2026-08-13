import Link from 'next/link';

import { DataTable, type Column } from '@/components/data-table';
import { FilterBar } from '@/components/filter-bar';
import { Badge, PageHeader, Stat } from '@/components/ui';
import * as fmt from '@/lib/format';
import { requireTenantContext } from '@/server/auth/session';
import { getAssetRegister } from '@/server/services/fixed-asset-service';

export const metadata = { title: 'Fixed Assets — LedgerBase' };
export const dynamic = 'force-dynamic';

type Row = Awaited<ReturnType<typeof getAssetRegister>>['assets'][number];

export default async function FixedAssetsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const params = await searchParams;
  const ctx = await requireTenantContext();

  const register = await getAssetRegister(ctx);
  const rows = params.status
    ? register.assets.filter((a) => a.status === params.status)
    : register.assets;

  const asMoney = (value: string) =>
    fmt.money(value, {
      currency: ctx.baseCurrencyCode,
      precision: ctx.currencyPrecision,
    });

  const columns: Column<Row>[] = [
    {
      key: 'number',
      header: 'Asset',
      width: '110px',
      render: (row) => (
        <span className="tabular text-muted-foreground">{row.assetNumber}</span>
      ),
    },
    {
      key: 'name',
      header: 'Name',
      render: (row) => (
        <div>
          <span className="font-medium">{row.name}</span>
          {row.category ? (
            <span className="block text-xs text-muted-foreground">{row.category}</span>
          ) : null}
        </div>
      ),
    },
    {
      key: 'acquired',
      header: 'Acquired',
      render: (row) => (
        <span className="text-muted-foreground">{fmt.date(row.acquisitionDate)}</span>
      ),
    },
    {
      key: 'life',
      header: 'Life',
      align: 'right',
      render: (row) => (
        <span className="text-muted-foreground">{row.usefulLifeMonths} mo</span>
      ),
    },
    { key: 'cost', header: 'Cost', align: 'right', render: (row) => asMoney(row.cost) },
    {
      key: 'accumulated',
      header: 'Accum. depn',
      align: 'right',
      render: (row) => (
        <span className="text-muted-foreground">
          {asMoney(row.accumulatedDepreciation)}
        </span>
      ),
    },
    {
      key: 'nbv',
      header: 'Net book value',
      align: 'right',
      render: (row) => <span className="font-medium">{asMoney(row.netBookValue)}</span>,
    },
    {
      key: 'status',
      header: 'Status',
      render: (row) => (
        <Badge
          tone={
            row.status === 'active'
              ? 'positive'
              : row.status === 'disposed'
                ? 'neutral'
                : 'warning'
          }
        >
          {fmt.humanise(row.status)}
        </Badge>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title="Fixed Assets"
        description="The asset register: cost, accumulated depreciation and net book value"
      />

      <div className="mb-5 grid gap-3 sm:grid-cols-3">
        <Stat label="Cost" value={asMoney(register.totalCost)} />
        <Stat
          label="Accumulated depreciation"
          value={asMoney(register.totalAccumulatedDepreciation)}
        />
        <Stat label="Net book value" value={asMoney(register.totalNetBookValue)} />
      </div>

      <FilterBar
        basePath="/fixed-assets"
        searchParams={params}
        searchPlaceholder="Search assets…"
        selects={[
          {
            name: 'status',
            label: 'Status',
            options: [
              { value: '', label: 'All' },
              { value: 'active', label: 'Active' },
              { value: 'disposed', label: 'Disposed' },
            ],
          },
        ]}
      />

      <DataTable
        rows={rows}
        columns={columns}
        getRowKey={(row) => row.id}
        empty={{
          title: 'No assets registered',
          description:
            'Register an asset to depreciate it. Depreciation posts Dr Depreciation Expense / Cr Accumulated Depreciation each period.',
        }}
      />

      <p className="mt-3 text-xs text-muted-foreground">
        Straight-line depreciation. Running a period twice charges nothing further, and
        no asset is ever depreciated below its residual value.
      </p>
    </>
  );
}
