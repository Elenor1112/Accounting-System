import Link from 'next/link';

import { ContactList } from '@/components/contact-list';
import { PageHeader } from '@/components/ui';
import { requireTenantContext } from '@/server/auth/session';
import { listContacts } from '@/server/services/contact-service';

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

  const rows = await listContacts(ctx, {
    kind: 'customer',
    search: params.q,
    limit: PAGE_SIZE + 1,
    offset: (page - 1) * PAGE_SIZE,
  });

  return (
    <>
      <PageHeader title="Customers" description="People and companies you invoice" />
      <ContactList
        rows={rows}
        page={page}
        pageSize={PAGE_SIZE}
        basePath="/customers"
        searchParams={params}
        kind="customer"
      />
    </>
  );
}
