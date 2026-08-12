import Link from 'next/link';

import { DocumentList } from '@/components/document-list';
import { Button, PageHeader } from '@/components/ui';
import { requireTenantContext } from '@/server/auth/session';
import { listDocuments } from '@/server/services/document-service';

export const metadata = { title: 'Invoices — LedgerBase' };
export const dynamic = 'force-dynamic';

const PAGE_SIZE = 25;

export default async function InvoicesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const params = await searchParams;
  const ctx = await requireTenantContext();
  const page = Math.max(1, Number(params.page ?? '1'));

  const rows = await listDocuments(ctx, {
    direction: 'outbound',
    status: params.status as never,
    search: params.q,
    // One extra row reveals whether a next page exists without a count query.
    limit: PAGE_SIZE + 1,
    offset: (page - 1) * PAGE_SIZE,
  });

  return (
    <>
      <PageHeader
        title="Invoices"
        description="Sales documents and their outstanding balances"
        actions={
          <Link href="/invoices/new">
            <Button variant="primary">New invoice</Button>
          </Link>
        }
      />

      <DocumentList
        rows={rows}
        page={page}
        pageSize={PAGE_SIZE}
        basePath="/invoices"
        searchParams={params}
        currencyPrecision={ctx.currencyPrecision}
        entityLabel="invoice"
        emptyAction={
          <Link href="/invoices/new">
            <Button variant="primary">New invoice</Button>
          </Link>
        }
      />
    </>
  );
}
