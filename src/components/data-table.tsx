import Link from 'next/link';
import type { ReactNode } from 'react';

import { EmptyState, TableWrap } from './ui';

/**
 * Server-rendered table used by every list screen.
 *
 * Deliberately not interactive: sorting, filtering and paging are query-string
 * driven and handled server-side, because the datasets here can reach hundreds
 * of thousands of rows and must never be shipped to the browser to be filtered
 * (spec §30).
 */
export interface Column<T> {
  key: string;
  header: string;
  align?: 'left' | 'right';
  width?: string;
  render: (row: T) => ReactNode;
}

export function DataTable<T>({
  rows,
  columns,
  getRowKey,
  empty,
}: {
  rows: T[];
  columns: Column<T>[];
  getRowKey: (row: T) => string;
  empty: { title: string; description?: string; action?: ReactNode };
}) {
  if (rows.length === 0) {
    return <EmptyState {...empty} />;
  }

  return (
    <TableWrap>
      <table className="data-table">
        <thead>
          <tr>
            {columns.map((column) => (
              <th
                key={column.key}
                style={column.width ? { width: column.width } : undefined}
                className={column.align === 'right' ? 'text-right' : undefined}
              >
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={getRowKey(row)}>
              {columns.map((column) => (
                <td key={column.key} className={column.align === 'right' ? 'num' : undefined}>
                  {column.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </TableWrap>
  );
}

/** Server-side pagination controls that preserve the current query string. */
export function Pagination({
  basePath,
  searchParams,
  page,
  hasMore,
}: {
  basePath: string;
  searchParams: Record<string, string | undefined>;
  page: number;
  hasMore: boolean;
}) {
  const buildHref = (nextPage: number) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(searchParams)) {
      if (value && key !== 'page') params.set(key, value);
    }
    if (nextPage > 1) params.set('page', String(nextPage));
    const query = params.toString();
    return query ? `${basePath}?${query}` : basePath;
  };

  if (page === 1 && !hasMore) return null;

  return (
    <div className="mt-3 flex items-center justify-between text-sm">
      <span className="text-muted-foreground">Page {page}</span>
      <div className="flex gap-2">
        {page > 1 ? (
          <Link
            href={buildHref(page - 1)}
            className="rounded-md border border-border px-2.5 py-1 hover:bg-surface-muted"
          >
            Previous
          </Link>
        ) : null}
        {hasMore ? (
          <Link
            href={buildHref(page + 1)}
            className="rounded-md border border-border px-2.5 py-1 hover:bg-surface-muted"
          >
            Next
          </Link>
        ) : null}
      </div>
    </div>
  );
}
