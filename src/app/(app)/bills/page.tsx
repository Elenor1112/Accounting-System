import Link from 'next/link';

import { DocumentList } from '@/components/document-list';
import { Button, PageHeader } from '@/components/ui';
import { requireTenantContext } from '@/server/auth/session';
import { listDocuments } from '@/server/services/document-service';

export const metadata = { title: 'Bills — LedgerBase' };
export const dynamic = 'force-dynamic';

const PAGE_SIZE = 25;

export default async function BillsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const params = await searchParams;
  const ctx = await requireTenantContext();
  const page = Math.max(1, Number(params.page ?? '1'));

  const rows = await listDocuments(ctx, {
    direction: 'inbound',
    status: params.status as never,
    search: params.q,
    limit: PAGE_SIZE + 1,
    offset: (page - 1) * PAGE_SIZE,
  });

  return (
    <>
      <PageHeader
        title="Bills"
        description="Purchase documents owed to your vendors"
        actions={
          <Link href="/bills/new">
            <Button variant="primary">New bill</Button>
          </Link>
        }
      />

      <DocumentList
        rows={rows}
        page={page}
        pageSize={PAGE_SIZE}
        basePath="/bills"
        searchParams={params}
        currencyPrecision={ctx.currencyPrecision}
        entityLabel="bill"
        emptyAction={
          <Link href="/bills/new">
            <Button variant="primary">New bill</Button>
          </Link>
        }
      />
    </>
  );
}
