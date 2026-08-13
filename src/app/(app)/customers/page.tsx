import Link from 'next/link';

import { ContactList } from '@/components/contact-list';
import { Button, PageHeader } from '@/components/ui';
import { can } from '@/server/auth/context';
import { PERMISSIONS } from '@/server/auth/permissions';
import { requireTenantContext } from '@/server/auth/session';
import { listContactsWithBalances } from '@/server/services/contact-service';

export const metadata = { title: 'Customers — LedgerBase' };
export const dynamic = 'force-dynamic';

const PAGE_SIZE = 25;

export default async function CustomersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const params = await searchParams;
  const ctx = await requireTenantContext();
  const page = Math.max(1, Number(params.page ?? '1'));

  const rows = await listContactsWithBalances(ctx, {
    kind: 'customer',
    search: params.q,
    includeInactive: params.status === 'all',
    sort: (params.sort as 'name' | 'code' | 'balance') || 'name',
    limit: PAGE_SIZE + 1,
    offset: (page - 1) * PAGE_SIZE,
  });

  return (
    <>
      <PageHeader
        title="Customers"
        description="People and companies you invoice, with what they currently owe"
        actions={
          can(ctx, PERMISSIONS.contacts.manage) ? (
            <Link href="/customers/new">
              <Button variant="primary">New customer</Button>
            </Link>
          ) : null
        }
      />
      <ContactList
        rows={rows}
        page={page}
        pageSize={PAGE_SIZE}
        basePath="/customers"
        searchParams={params}
        kind="customer"
        baseCurrencyCode={ctx.baseCurrencyCode}
        currencyPrecision={ctx.currencyPrecision}
      />
    </>
  );
}
