import { ContactForm } from '@/components/contact-form';
import { PageHeader } from '@/components/ui';
import { requirePermission } from '@/server/auth/context';
import { PERMISSIONS } from '@/server/auth/permissions';
import { requireTenantContext } from '@/server/auth/session';
import { listCurrencies } from '@/server/services/currency-service';

export const metadata = { title: 'New customer — LedgerBase' };
export const dynamic = 'force-dynamic';

export default async function NewCustomerPage() {
  const ctx = await requireTenantContext();
  requirePermission(ctx, PERMISSIONS.contacts.manage);

  const currencies = await listCurrencies(ctx);

  return (
    <>
      <PageHeader
        title="New customer"
        description="Terms set here become the defaults on every invoice you raise for them"
      />
      <ContactForm
        mode="create"
        kind="customer"
        currencies={currencies.map((c) => ({ code: c.code, name: c.name }))}
        backHref="/customers"
      />
    </>
  );
}
