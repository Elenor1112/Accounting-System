import Link from 'next/link';

import * as fmt from '@/lib/format';

import { DataTable, Pagination, type Column } from './data-table';
import { FilterBar } from './filter-bar';
import { Badge } from './ui';

export interface ContactListRow {
  id: string;
  code: string;
  displayName: string;
  contactPerson: string | null;
  email: string | null;
  phone: string | null;
  category: string | null;
  currencyCode: string | null;
  paymentTermsDays: number;
  creditLimit: string | null;
  isActive: boolean;
  /** Outstanding as at today, reconstructed from posted allocations. */
  outstanding: string;
  overdue: string;
}

export function ContactList({
  rows,
  page,
  pageSize,
  basePath,
  searchParams,
  kind,
  baseCurrencyCode,
  currencyPrecision,
}: {
  rows: ContactListRow[];
  page: number;
  pageSize: number;
  basePath: string;
  searchParams: Record<string, string | undefined>;
  kind: 'customer' | 'vendor';
  baseCurrencyCode: string;
  currencyPrecision: number;
}) {
  const hasMore = rows.length > pageSize;
  const visible = hasMore ? rows.slice(0, pageSize) : rows;

  const asMoney = (value: string) =>
    fmt.money(value, { currency: baseCurrencyCode, precision: currencyPrecision });

  const columns: Column<ContactListRow>[] = [
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
        <div>
          <Link
            href={`${basePath}/${row.id}`}
            className="font-medium text-accent hover:underline"
          >
            {row.displayName}
          </Link>
          {row.contactPerson ? (
            <span className="block text-xs text-muted-foreground">
              {row.contactPerson}
            </span>
          ) : null}
        </div>
      ),
    },
    {
      key: 'contact',
      header: 'Contact',
      render: (row) => (
        <div className="text-muted-foreground">
          <span className="block">{row.email ?? '—'}</span>
          {row.phone ? <span className="block text-xs">{row.phone}</span> : null}
        </div>
      ),
    },
    {
      key: 'terms',
      header: 'Terms',
      render: (row) => (
        <span className="text-muted-foreground">Net {row.paymentTermsDays}</span>
      ),
    },
    {
      key: 'outstanding',
      header: kind === 'customer' ? 'Outstanding' : 'Owed',
      align: 'right',
      render: (row) => (
        <div>
          <span
            className={
              row.outstanding === '0' ? 'text-muted-foreground' : 'font-medium'
            }
          >
            {asMoney(row.outstanding)}
          </span>
          {row.overdue !== '0' ? (
            <span className="block text-xs text-negative">
              {asMoney(row.overdue)} overdue
            </span>
          ) : null}
        </div>
      ),
    },
    {
      key: 'creditLimit',
      header: 'Credit limit',
      align: 'right',
      render: (row) => (
        <span className="text-muted-foreground">
          {row.creditLimit ? asMoney(row.creditLimit) : '—'}
        </span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      render: (row) =>
        row.isActive ? (
          <Badge tone="positive">Active</Badge>
        ) : (
          <Badge tone="neutral">Archived</Badge>
        ),
    },
  ];

  return (
    <>
      <FilterBar
        basePath={basePath}
        searchParams={searchParams}
        searchPlaceholder={`Search ${kind}s by name, code, contact, email or phone…`}
        selects={[
          {
            name: 'status',
            label: 'Status',
            options: [
              { value: '', label: 'Active only' },
              { value: 'all', label: 'Active and archived' },
            ],
          },
          {
            name: 'sort',
            label: 'Sort by',
            options: [
              { value: '', label: 'Name' },
              { value: 'code', label: 'Code' },
              { value: 'balance', label: 'Outstanding' },
            ],
          },
        ]}
      />

      <DataTable
        rows={visible}
        columns={columns}
        getRowKey={(row) => row.id}
        empty={{
          title: `No ${kind}s yet`,
          description: searchParams.q
            ? 'No results match your search.'
            : `Add your first ${kind} to start raising ${
                kind === 'customer' ? 'invoices' : 'bills'
              }.`,
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
