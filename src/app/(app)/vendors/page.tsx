import Link from 'next/link';

import { ContactList } from '@/components/contact-list';
import { Button, PageHeader } from '@/components/ui';
import { can } from '@/server/auth/context';
import { PERMISSIONS } from '@/server/auth/permissions';
import { requireTenantContext } from '@/server/auth/session';
import { listContactsWithBalances } from '@/server/services/contact-service';

export const metadata = { title: 'Vendors — LedgerBase' };
export const dynamic = 'force-dynamic';

const PAGE_SIZE = 25;

export default async function VendorsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const params = await searchParams;
  const ctx = await requireTenantContext();
  const page = Math.max(1, Number(params.page ?? '1'));

  const rows = await listContactsWithBalances(ctx, {
    kind: 'vendor',
    search: params.q,
    includeInactive: params.status === 'all',
    sort: (params.sort as 'name' | 'code' | 'balance') || 'name',
    limit: PAGE_SIZE + 1,
    offset: (page - 1) * PAGE_SIZE,
  });

  return (
    <>
      <PageHeader
        title="Vendors"
        description="Suppliers and people you pay, with what you currently owe them"
        actions={
          can(ctx, PERMISSIONS.contacts.manage) ? (
            <Link href="/vendors/new">
              <Button variant="primary">New vendor</Button>
            </Link>
          ) : null
        }
      />
      <ContactList
        rows={rows}
        page={page}
        pageSize={PAGE_SIZE}
        basePath="/vendors"
        searchParams={params}
        kind="vendor"
        baseCurrencyCode={ctx.baseCurrencyCode}
        currencyPrecision={ctx.currencyPrecision}
      />
    </>
  );
}
