import Link from 'next/link';
import type { ReactNode } from 'react';

import * as fmt from '@/lib/format';

import { DataTable, Pagination, type Column } from './data-table';
import { Badge, statusTone } from './ui';
import { FilterBar } from './filter-bar';

interface DocumentRow {
  id: string;
  documentNumber: string;
  documentType: string;
  contactName: string;
  issueDate: string;
  dueDate: string | null;
  currencyCode: string;
  total: string;
  amountPaid: string;
  balanceDue: string;
  status: string;
}

const STATUS_OPTIONS = [
  { value: '', label: 'All statuses' },
  { value: 'draft', label: 'Draft' },
  { value: 'approved', label: 'Approved' },
  { value: 'sent', label: 'Sent' },
  { value: 'partially_paid', label: 'Partially paid' },
  { value: 'paid', label: 'Paid' },
  { value: 'overdue', label: 'Overdue' },
  { value: 'void', label: 'Void' },
];

/** Shared list rendering for invoices and bills — the two differ only in labels. */
export function DocumentList({
  rows,
  page,
  pageSize,
  basePath,
  searchParams,
  currencyPrecision,
  entityLabel,
  emptyAction,
}: {
  rows: DocumentRow[];
  page: number;
  pageSize: number;
  basePath: string;
  searchParams: Record<string, string | undefined>;
  currencyPrecision: number;
  entityLabel: string;
  emptyAction?: ReactNode;
}) {
  const hasMore = rows.length > pageSize;
  const visible = hasMore ? rows.slice(0, pageSize) : rows;

  const columns: Column<DocumentRow>[] = [
    {
      key: 'number',
      header: 'Number',
      render: (row) => (
        <Link
          href={`${basePath}/${row.id}`}
          className="font-medium text-accent hover:underline"
        >
          {row.documentNumber}
        </Link>
      ),
    },
    {
      key: 'contact',
      header: entityLabel === 'invoice' ? 'Customer' : 'Vendor',
      render: (row) => <span className="text-foreground">{row.contactName}</span>,
    },
    {
      key: 'issued',
      header: 'Issued',
      render: (row) => (
        <span className="text-muted-foreground">{fmt.date(row.issueDate)}</span>
      ),
    },
    {
      key: 'due',
      header: 'Due',
      render: (row) => {
        // Settled documents no longer have a meaningful due state.
        if (row.status === 'paid' || row.status === 'void') {
          return <span className="text-muted-foreground">{fmt.date(row.dueDate)}</span>;
        }
        const due = fmt.relativeDue(row.dueDate);
        return (
          <span
            className={
              due.tone === 'negative'
                ? 'text-negative'
                : due.tone === 'warning'
                  ? 'text-warning'
                  : 'text-muted-foreground'
            }
          >
            {due.label}
          </span>
        );
      },
    },
    {
      key: 'total',
      header: 'Total',
      align: 'right',
      render: (row) =>
        fmt.money(row.total, { currency: row.currencyCode, precision: currencyPrecision }),
    },
    {
      key: 'paid',
      header: 'Paid',
      align: 'right',
      render: (row) => (
        <span className="text-muted-foreground">
          {fmt.money(row.amountPaid, {
            currency: row.currencyCode,
            precision: currencyPrecision,
          })}
        </span>
      ),
    },
    {
      key: 'balance',
      header: 'Balance',
      align: 'right',
      render: (row) => (
        <span className={Number(row.balanceDue) > 0 ? 'font-medium' : 'text-muted-foreground'}>
          {fmt.money(row.balanceDue, {
            currency: row.currencyCode,
            precision: currencyPrecision,
          })}
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
      <FilterBar
        basePath={basePath}
        searchParams={searchParams}
        searchPlaceholder={`Search ${entityLabel} number or reference…`}
        selects={[{ name: 'status', label: 'Status', options: STATUS_OPTIONS }]}
      />

      <DataTable
        rows={visible}
        columns={columns}
        getRowKey={(row) => row.id}
        empty={{
          title: `No ${entityLabel}s found`,
          description:
            searchParams.q || searchParams.status
              ? 'No results match the current filters.'
              : `${entityLabel === 'invoice' ? 'Invoices' : 'Bills'} you create will appear here.`,
          action: emptyAction,
        }}
      />

      <Pagination
        basePath={basePath}
        searchParams={searchParams}
        page={page}
        hasMore={hasMore}
      />
    </>
  );
}
