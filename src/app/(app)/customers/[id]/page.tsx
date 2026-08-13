import { notFound } from 'next/navigation';

import { ContactDetail } from '@/components/contact-detail';
import { can } from '@/server/auth/context';
import { PERMISSIONS } from '@/server/auth/permissions';
import { requireTenantContext } from '@/server/auth/session';
import { NotFoundError } from '@/server/errors';
import { loadContactDetail } from '@/server/services/contact-detail-service';

export const dynamic = 'force-dynamic';

export default async function CustomerDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { id } = await params;
  const query = await searchParams;
  const ctx = await requireTenantContext();

  let data: Awaited<ReturnType<typeof loadContactDetail>>;
  try {
    data = await loadContactDetail(ctx, id, {
      statementFrom: query.from,
      statementTo: query.to,
    });
  } catch (err) {
    if (err instanceof NotFoundError) notFound();
    throw err;
  }

  return (
    <ContactDetail
      contact={data.contact}
      kind="customer"
      basePath="/customers"
      balance={data.balance}
      credit={data.credit}
      aging={data.aging}
      statement={data.statement}
      transactions={data.transactions}
      baseCurrencyCode={ctx.baseCurrencyCode}
      currencyPrecision={ctx.currencyPrecision}
      canManage={can(ctx, PERMISSIONS.contacts.manage)}
      canInvoice={can(ctx, PERMISSIONS.invoices.create)}
    />
  );
}
