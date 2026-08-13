import Link from 'next/link';

import { DataTable, Pagination, type Column } from '@/components/data-table';
import { FilterBar } from '@/components/filter-bar';
import { Badge, Button, PageHeader, statusTone } from '@/components/ui';
import * as fmt from '@/lib/format';
import { can } from '@/server/auth/context';
import { PERMISSIONS } from '@/server/auth/permissions';
import { requireTenantContext } from '@/server/auth/session';
import { listJournalEntries } from '@/server/services/journal-service';

export const metadata = { title: 'Journal Entries — LedgerBase' };
export const dynamic = 'force-dynamic';

const PAGE_SIZE = 30;

type Row = Awaited<ReturnType<typeof listJournalEntries>>[number];

export default async function JournalPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const params = await searchParams;
  const ctx = await requireTenantContext();
  const page = Math.max(1, Number(params.page ?? '1'));

  const rows = await listJournalEntries(ctx, {
    status: params.status,
    search: params.q,
    limit: PAGE_SIZE + 1,
    offset: (page - 1) * PAGE_SIZE,
  });

  const hasMore = rows.length > PAGE_SIZE;
  const visible = hasMore ? rows.slice(0, PAGE_SIZE) : rows;

  const columns: Column<Row>[] = [
    {
      key: 'number',
      header: 'Entry',
      render: (row) => (
        <Link href={`/journal/${row.id}`} className="font-medium text-accent hover:underline">
          {row.entryNumber}
        </Link>
      ),
    },
    {
      key: 'date',
      header: 'Date',
      render: (row) => <span className="text-muted-foreground">{fmt.date(row.entryDate)}</span>,
    },
    {
      key: 'description',
      header: 'Description',
      render: (row) => <span>{row.description ?? '—'}</span>,
    },
    {
      key: 'source',
      header: 'Source',
      render: (row) => (
        <span className="text-muted-foreground">{fmt.humanise(row.sourceType)}</span>
      ),
    },
    {
      key: 'amount',
      header: 'Amount',
      align: 'right',
      render: (row) =>
        fmt.money(row.totalDebit, {
          currency: ctx.baseCurrencyCode,
          precision: ctx.currencyPrecision,
        }),
    },
    {
      key: 'status',
      header: 'Status',
      render: (row) => <Badge tone={statusTone(row.status)}>{fmt.humanise(row.status)}</Badge>,
    },
  ];

  return (
    <>
      <PageHeader
        title="Journal Entries"
        description="Every posting to the general ledger"
        actions={
          can(ctx, PERMISSIONS.transactions.create) ? (
            <Link href="/journal/new">
              <Button variant="primary">New entry</Button>
            </Link>
          ) : null
        }
      />

      <FilterBar
        basePath="/journal"
        searchParams={params}
        searchPlaceholder="Search entry number, description or reference…"
        selects={[
          {
            name: 'status',
            label: 'Status',
            options: [
              { value: '', label: 'All statuses' },
              { value: 'draft', label: 'Draft' },
              { value: 'posted', label: 'Posted' },
              { value: 'reversed', label: 'Reversed' },
            ],
          },
        ]}
      />

      <DataTable
        rows={visible}
        columns={columns}
        getRowKey={(row) => row.id}
        empty={{
          title: 'No journal entries',
          description:
            'Entries appear here as documents are posted, or when you record a manual entry.',
        }}
      />

      <Pagination
        basePath="/journal"
        searchParams={params}
        page={page}
        hasMore={hasMore}
      />
    </>
  );
}
