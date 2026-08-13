import { notFound } from 'next/navigation';

import { ContactForm } from '@/components/contact-form';
import { PageHeader } from '@/components/ui';
import { requirePermission } from '@/server/auth/context';
import { PERMISSIONS } from '@/server/auth/permissions';
import { requireTenantContext } from '@/server/auth/session';
import { NotFoundError } from '@/server/errors';
import { getContact } from '@/server/services/contact-service';
import { listCurrencies } from '@/server/services/currency-service';

export const dynamic = 'force-dynamic';

export default async function EditCustomerPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const ctx = await requireTenantContext();
  requirePermission(ctx, PERMISSIONS.contacts.manage);

  let contact: Awaited<ReturnType<typeof getContact>>;
  try {
    contact = await getContact(ctx, id);
  } catch (err) {
    if (err instanceof NotFoundError) notFound();
    throw err;
  }

  const currencies = await listCurrencies(ctx);
  const address = (contact.billingAddress ?? {}) as Record<string, string>;

  return (
    <>
      <PageHeader title={`Edit ${contact.displayName}`} description={contact.code} />
      <ContactForm
        mode="edit"
        kind="customer"
        initial={{
          id: contact.id,
          kind: contact.kind,
          displayName: contact.displayName,
          legalName: contact.legalName,
          contactPerson: contact.contactPerson,
          email: contact.email,
          phone: contact.phone,
          mobile: contact.mobile,
          website: contact.website,
          taxIdentifier: contact.taxIdentifier,
          category: contact.category,
          currencyCode: contact.currencyCode,
          paymentTermsDays: contact.paymentTermsDays,
          creditLimit: contact.creditLimit,
          notes: contact.notes,
          addressLine: address.line1 ?? '',
          city: address.city ?? '',
          country: address.country ?? '',
        }}
        currencies={currencies.map((c) => ({ code: c.code, name: c.name }))}
        backHref="/customers"
      />
    </>
  );
}
