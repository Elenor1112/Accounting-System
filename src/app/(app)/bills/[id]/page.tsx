import { notFound } from 'next/navigation';

import { DocumentDetail } from '@/components/document-detail';
import { NotFoundError } from '@/server/errors';
import { requireTenantContext } from '@/server/auth/session';
import { getDocument } from '@/server/services/document-service';

export const dynamic = 'force-dynamic';

export default async function BillDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const ctx = await requireTenantContext();

  try {
    const { document, lines, contact } = await getDocument(ctx, id);
    return (
      <DocumentDetail
        document={document}
        lines={lines}
        contact={contact}
        ctx={{
          baseCurrencyCode: ctx.baseCurrencyCode,
          currencyPrecision: ctx.currencyPrecision,
          companyName: ctx.companyName,
          permissions: [...ctx.permissions],
        }}
        backHref="/bills"
        backLabel="Bills"
      />
    );
  } catch (err) {
    if (err instanceof NotFoundError) notFound();
    throw err;
  }
}
