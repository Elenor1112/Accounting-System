import { ContactForm } from '@/components/contact-form';
import { PageHeader } from '@/components/ui';
import { requirePermission } from '@/server/auth/context';
import { PERMISSIONS } from '@/server/auth/permissions';
import { requireTenantContext } from '@/server/auth/session';
import { listCurrencies } from '@/server/services/currency-service';

export const metadata = { title: 'New vendor — LedgerBase' };
export const dynamic = 'force-dynamic';

export default async function NewVendorPage() {
  const ctx = await requireTenantContext();
  requirePermission(ctx, PERMISSIONS.contacts.manage);

  const currencies = await listCurrencies(ctx);

  return (
    <>
      <PageHeader
        title="New vendor"
        description="Terms set here become the defaults on every bill you enter for them"
      />
      <ContactForm
        mode="create"
        kind="vendor"
        currencies={currencies.map((c) => ({ code: c.code, name: c.name }))}
        backHref="/vendors"
      />
    </>
  );
}
