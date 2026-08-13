import { DocumentForm } from '@/components/document-form';
import { PageHeader } from '@/components/ui';
import { requireTenantContext } from '@/server/auth/session';
import { loadDocumentFormOptions } from '@/server/services/document-form-service';

export const metadata = { title: 'New invoice — LedgerBase' };
export const dynamic = 'force-dynamic';

export default async function NewInvoicePage() {
  const ctx = await requireTenantContext();
  const options = await loadDocumentFormOptions(ctx, 'outbound');

  return (
    <>
      <PageHeader
        title="New invoice"
        description="Raise a draft sales document — nothing reaches the ledger until it is posted"
      />
      <DocumentForm
        direction="outbound"
        contacts={options.contacts}
        accounts={options.accounts}
        taxes={options.taxes}
        currencies={options.currencies}
        defaultAccountId={options.defaultAccountId}
        baseCurrencyCode={ctx.baseCurrencyCode}
        currencyPrecision={ctx.currencyPrecision}
        backHref="/invoices"
        backLabel="Invoices"
      />
    </>
  );
}
