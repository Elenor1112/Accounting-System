import { DocumentForm } from '@/components/document-form';
import { PageHeader } from '@/components/ui';
import { requireTenantContext } from '@/server/auth/session';
import { loadDocumentFormOptions } from '@/server/services/document-form-service';

export const metadata = { title: 'New bill — LedgerBase' };
export const dynamic = 'force-dynamic';

export default async function NewBillPage() {
  const ctx = await requireTenantContext();
  const options = await loadDocumentFormOptions(ctx, 'inbound');

  return (
    <>
      <PageHeader
        title="New bill"
        description="Enter a draft purchase document — nothing reaches the ledger until it is posted"
      />
      <DocumentForm
        direction="inbound"
        contacts={options.contacts}
        accounts={options.accounts}
        taxes={options.taxes}
        currencies={options.currencies}
        defaultAccountId={options.defaultAccountId}
        baseCurrencyCode={ctx.baseCurrencyCode}
        currencyPrecision={ctx.currencyPrecision}
        backHref="/bills"
        backLabel="Bills"
      />
    </>
  );
}
