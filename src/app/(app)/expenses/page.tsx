import { DataTable, Pagination, type Column } from '@/components/data-table';
import { FilterBar } from '@/components/filter-bar';
import { Badge, PageHeader, statusTone } from '@/components/ui';
import * as fmt from '@/lib/format';
import { requireTenantContext } from '@/server/auth/session';
import { listExpenses } from '@/server/services/expense-service';

export const metadata = { title: 'Expenses — LedgerBase' };
export const dynamic = 'force-dynamic';

const PAGE_SIZE = 30;

type Row = Awaited<ReturnType<typeof listExpenses>>[number];

export default async function ExpensesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const params = await searchParams;
  const ctx = await requireTenantContext();
  const page = Math.max(1, Number(params.page ?? '1'));

  const rows = await listExpenses(ctx, {
    status: params.status as never,
    limit: PAGE_SIZE + 1,
    offset: (page - 1) * PAGE_SIZE,
  });

  const hasMore = rows.length > PAGE_SIZE;
  const visible = hasMore ? rows.slice(0, PAGE_SIZE) : rows;

  const columns: Column<Row>[] = [
    {
      key: 'number',
      header: 'Number',
      render: (row) => <span className="font-medium">{row.expenseNumber}</span>,
    },
    {
      key: 'date',
      header: 'Date',
      render: (row) => <span className="text-muted-foreground">{fmt.date(row.expenseDate)}</span>,
    },
    { key: 'description', header: 'Description', render: (row) => row.description },
    {
      key: 'category',
      header: 'Category',
      render: (row) => <span className="text-muted-foreground">{row.categoryName ?? '—'}</span>,
    },
    {
      key: 'by',
      header: 'Submitted by',
      render: (row) => <span className="text-muted-foreground">{row.submittedBy ?? '—'}</span>,
    },
    {
      key: 'amount',
      header: 'Amount',
      align: 'right',
      render: (row) =>
        fmt.money(row.amount, {
          currency: row.currencyCode,
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
        title="Expenses"
        description="Claims and company costs, posted on approval"
      />

      <FilterBar
        basePath="/expenses"
        searchParams={params}
        searchPlaceholder="Search expenses…"
        selects={[
          {
            name: 'status',
            label: 'Status',
            options: [
              { value: '', label: 'All statuses' },
              { value: 'draft', label: 'Draft' },
              { value: 'pending_approval', label: 'Pending approval' },
              { value: 'posted', label: 'Posted' },
              { value: 'rejected', label: 'Rejected' },
            ],
          },
        ]}
      />

      <DataTable
        rows={visible}
        columns={columns}
        getRowKey={(row) => row.id}
        empty={{
          title: 'No expenses',
          description: 'Expense claims appear here once submitted.',
        }}
      />

      <Pagination basePath="/expenses" searchParams={params} page={page} hasMore={hasMore} />
    </>
  );
}
