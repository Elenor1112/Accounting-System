import Link from 'next/link';

import { DataTable, Pagination, type Column } from '@/components/data-table';
import { Badge, PageHeader, statusTone } from '@/components/ui';
import * as fmt from '@/lib/format';
import { requireTenantContext } from '@/server/auth/session';
import { listPayments } from '@/server/services/payment-service';

export const metadata = { title: 'Payments — LedgerBase' };
export const dynamic = 'force-dynamic';

const PAGE_SIZE = 30;

type Row = Awaited<ReturnType<typeof listPayments>>[number];

export default async function PaymentsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const params = await searchParams;
  const ctx = await requireTenantContext();
  const page = Math.max(1, Number(params.page ?? '1'));

  const direction = params.direction === 'disbursement' ? 'disbursement' : 'receipt';

  const rows = await listPayments(ctx, {
    direction,
    limit: PAGE_SIZE + 1,
    offset: (page - 1) * PAGE_SIZE,
  });

  const hasMore = rows.length > PAGE_SIZE;
  const visible = hasMore ? rows.slice(0, PAGE_SIZE) : rows;
  const precision = ctx.currencyPrecision;

  const columns: Column<Row>[] = [
    {
      key: 'number',
      header: 'Number',
      render: (row) => <span className="font-medium">{row.paymentNumber}</span>,
    },
    {
      key: 'date',
      header: 'Date',
      render: (row) => <span className="text-muted-foreground">{fmt.date(row.paymentDate)}</span>,
    },
    {
      key: 'contact',
      header: direction === 'receipt' ? 'Customer' : 'Vendor',
      render: (row) => row.contactName ?? '—',
    },
    {
      key: 'method',
      header: 'Method',
      render: (row) => (
        <span className="text-muted-foreground">{fmt.humanise(row.method)}</span>
      ),
    },
    {
      key: 'amount',
      header: 'Amount',
      align: 'right',
      render: (row) => fmt.money(row.amount, { currency: row.currencyCode, precision }),
    },
    {
      key: 'allocated',
      header: 'Allocated',
      align: 'right',
      render: (row) => (
        <span className="text-muted-foreground">
          {fmt.money(row.allocatedAmount, { currency: row.currencyCode, precision })}
        </span>
      ),
    },
    {
      key: 'unapplied',
      header: 'Unapplied',
      align: 'right',
      render: (row) => (
        <span className={Number(row.unappliedAmount) > 0 ? 'text-warning' : 'text-muted-foreground'}>
          {fmt.money(row.unappliedAmount, { currency: row.currencyCode, precision })}
        </span>
      ),
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
        title={direction === 'receipt' ? 'Customer Receipts' : 'Vendor Payments'}
        description="Money received and paid, with what each settled"
      />

      <div className="mb-4 flex gap-1.5">
        <Link
          href="/payments?direction=receipt"
          className={`rounded-md px-3 py-1.5 text-sm font-medium ${
            direction === 'receipt'
              ? 'bg-accent-subtle text-accent'
              : 'text-muted-foreground hover:bg-surface-muted'
          }`}
        >
          Receipts
        </Link>
        <Link
          href="/payments?direction=disbursement"
          className={`rounded-md px-3 py-1.5 text-sm font-medium ${
            direction === 'disbursement'
              ? 'bg-accent-subtle text-accent'
              : 'text-muted-foreground hover:bg-surface-muted'
          }`}
        >
          Payments made
        </Link>
      </div>

      <DataTable
        rows={visible}
        columns={columns}
        getRowKey={(row) => row.id}
        empty={{
          title: 'No payments recorded',
          description:
            'Payments appear here once you record a receipt against an invoice or pay a bill.',
        }}
      />

      <Pagination
        basePath="/payments"
        searchParams={params}
        page={page}
        hasMore={hasMore}
      />
    </>
  );
}
