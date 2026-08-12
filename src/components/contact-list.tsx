import Link from 'next/link';

import * as fmt from '@/lib/format';

import { DataTable, Pagination, type Column } from './data-table';
import { FilterBar } from './filter-bar';
import { Badge } from './ui';

interface ContactRow {
  id: string;
  code: string;
  displayName: string;
  email: string | null;
  phone: string | null;
  currencyCode: string | null;
  paymentTermsDays: number;
  isActive: boolean;
}

export function ContactList({
  rows,
  page,
  pageSize,
  basePath,
  searchParams,
  kind,
}: {
  rows: ContactRow[];
  page: number;
  pageSize: number;
  basePath: string;
  searchParams: Record<string, string | undefined>;
  kind: 'customer' | 'vendor';
}) {
  const hasMore = rows.length > pageSize;
  const visible = hasMore ? rows.slice(0, pageSize) : rows;

  const columns: Column<ContactRow>[] = [
    {
      key: 'code',
      header: 'Code',
      width: '110px',
      render: (row) => <span className="tabular text-muted-foreground">{row.code}</span>,
    },
    {
      key: 'name',
      header: 'Name',
      render: (row) => (
        <Link
          href={`${basePath}/${row.id}`}
          className="font-medium text-accent hover:underline"
        >
          {row.displayName}
        </Link>
      ),
    },
    {
      key: 'email',
      header: 'Email',
      render: (row) => <span className="text-muted-foreground">{row.email ?? '—'}</span>,
    },
    {
      key: 'phone',
      header: 'Phone',
      render: (row) => <span className="text-muted-foreground">{row.phone ?? '—'}</span>,
    },
    {
      key: 'terms',
      header: 'Terms',
      render: (row) => (
        <span className="text-muted-foreground">Net {row.paymentTermsDays}</span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      render: (row) =>
        row.isActive ? (
          <Badge tone="positive">Active</Badge>
        ) : (
          <Badge tone="neutral">Inactive</Badge>
        ),
    },
  ];

  return (
    <>
      <FilterBar
        basePath={basePath}
        searchParams={searchParams}
        searchPlaceholder={`Search ${kind}s by name, code or email…`}
      />

      <DataTable
        rows={visible}
        columns={columns}
        getRowKey={(row) => row.id}
        empty={{
          title: `No ${kind}s yet`,
          description: searchParams.q
            ? 'No results match your search.'
            : `${kind === 'customer' ? 'Customers' : 'Vendors'} are created automatically when you raise their first document, or you can add them here.`,
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
