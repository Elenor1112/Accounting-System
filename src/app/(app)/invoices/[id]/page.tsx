import Link from 'next/link';
import { notFound } from 'next/navigation';

import { DocumentDetail } from '@/components/document-detail';
import { requireTenantContext } from '@/server/auth/session';
import { getDocument } from '@/server/services/document-service';
import { NotFoundError } from '@/server/errors';

export const dynamic = 'force-dynamic';

export default async function InvoiceDetailPage({
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
        backHref="/invoices"
        backLabel="Invoices"
      />
    );
  } catch (err) {
    if (err instanceof NotFoundError) notFound();
    throw err;
  }
}
