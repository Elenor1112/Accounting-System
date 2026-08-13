'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

import {
  createContactAction,
  updateContactAction,
  type ContactFormInput,
} from '@/app/(app)/customers/actions';

import { Button, Card, ErrorBanner, Field, Input, SectionTitle, Select } from './ui';

export interface ContactFormValues extends ContactFormInput {
  id?: string;
  city?: string | null;
  country?: string | null;
  addressLine?: string | null;
}

/**
 * Create/edit form for a customer or vendor.
 *
 * The `kind` field is editable on purpose: a supplier you also sell to is one
 * record marked `both`, not two records that drift apart. Address lines are
 * held in the existing `billingAddress` jsonb column rather than as new
 * columns — nothing queries or constrains them, so they do not warrant one.
 */
export function ContactForm({
  mode,
  kind,
  initial,
  currencies,
  backHref,
}: {
  mode: 'create' | 'edit';
  kind: 'customer' | 'vendor';
  initial?: ContactFormValues;
  currencies: Array<{ code: string; name: string }>;
  backHref: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const [values, setValues] = useState<ContactFormValues>(
    initial ?? {
      kind,
      displayName: '',
      legalName: '',
      contactPerson: '',
      email: '',
      phone: '',
      mobile: '',
      website: '',
      taxIdentifier: '',
      category: '',
      currencyCode: '',
      paymentTermsDays: 30,
      creditLimit: '',
      notes: '',
      addressLine: '',
      city: '',
      country: '',
    },
  );

  const set = <K extends keyof ContactFormValues>(key: K, value: ContactFormValues[K]) =>
    setValues((current) => ({ ...current, [key]: value }));

  const label = kind === 'customer' ? 'Customer' : 'Vendor';
  const canSubmit = values.displayName.trim() !== '' && !pending;

  const submit = () => {
    setError(null);
    startTransition(async () => {
      const payload: ContactFormInput = {
        kind: values.kind,
        displayName: values.displayName.trim(),
        legalName: values.legalName?.trim() || null,
        contactPerson: values.contactPerson?.trim() || null,
        email: values.email?.trim() || null,
        phone: values.phone?.trim() || null,
        mobile: values.mobile?.trim() || null,
        website: values.website?.trim() || null,
        taxIdentifier: values.taxIdentifier?.trim() || null,
        category: values.category?.trim() || null,
        currencyCode: values.currencyCode || null,
        paymentTermsDays: Number(values.paymentTermsDays) || 0,
        creditLimit: values.creditLimit?.toString().trim() || null,
        billingAddress: {
          line1: values.addressLine?.trim() || '',
          city: values.city?.trim() || '',
          country: values.country?.trim() || '',
        },
        notes: values.notes?.trim() || null,
      };

      const result =
        mode === 'create'
          ? await createContactAction(payload)
          : await updateContactAction(initial!.id!, payload);

      if (result.ok && result.id) {
        router.push(`${backHref}/${result.id}`);
      } else {
        setError(result.error ?? `Could not save the ${kind}`);
      }
    });
  };

  return (
    <>
      <div className="mb-4">
        <Link href={backHref} className="text-xs text-muted-foreground hover:text-foreground">
          ← Back to {kind}s
        </Link>
      </div>

      {error ? (
        <div className="mb-4">
          <ErrorBanner message={error} />
        </div>
      ) : null}

      <div className="flex flex-col gap-4">
        <Card>
          <SectionTitle>Identity</SectionTitle>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <Field label={`${label} name`} htmlFor="displayName">
              <Input
                id="displayName"
                value={values.displayName}
                onChange={(e) => set('displayName', e.target.value)}
                autoFocus
              />
            </Field>

            <Field
              label="Legal / business name"
              htmlFor="legalName"
              hint="If it differs from the trading name"
            >
              <Input
                id="legalName"
                value={values.legalName ?? ''}
                onChange={(e) => set('legalName', e.target.value)}
              />
            </Field>

            <Field
              label="Relationship"
              htmlFor="kind"
              hint="A counterparty can be both"
            >
              <Select
                id="kind"
                value={values.kind}
                onChange={(e) => set('kind', e.target.value as ContactFormInput['kind'])}
              >
                <option value="customer">Customer</option>
                <option value="vendor">Vendor</option>
                <option value="both">Both</option>
              </Select>
            </Field>

            <Field label="Tax / VAT number" htmlFor="taxIdentifier">
              <Input
                id="taxIdentifier"
                value={values.taxIdentifier ?? ''}
                onChange={(e) => set('taxIdentifier', e.target.value)}
              />
            </Field>

            <Field label="Category" htmlFor="category" hint="Your own grouping">
              <Input
                id="category"
                value={values.category ?? ''}
                onChange={(e) => set('category', e.target.value)}
                placeholder="e.g. Wholesale"
              />
            </Field>
          </div>
        </Card>

        <Card>
          <SectionTitle>Contact</SectionTitle>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <Field label="Contact person" htmlFor="contactPerson">
              <Input
                id="contactPerson"
                value={values.contactPerson ?? ''}
                onChange={(e) => set('contactPerson', e.target.value)}
              />
            </Field>
            <Field label="Email" htmlFor="email">
              <Input
                id="email"
                type="email"
                value={values.email ?? ''}
                onChange={(e) => set('email', e.target.value)}
              />
            </Field>
            <Field label="Phone" htmlFor="phone">
              <Input
                id="phone"
                value={values.phone ?? ''}
                onChange={(e) => set('phone', e.target.value)}
              />
            </Field>
            <Field label="Mobile" htmlFor="mobile">
              <Input
                id="mobile"
                value={values.mobile ?? ''}
                onChange={(e) => set('mobile', e.target.value)}
              />
            </Field>
            <Field label="Website" htmlFor="website">
              <Input
                id="website"
                value={values.website ?? ''}
                onChange={(e) => set('website', e.target.value)}
              />
            </Field>
          </div>

          <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <Field label="Address" htmlFor="addressLine">
              <Input
                id="addressLine"
                value={values.addressLine ?? ''}
                onChange={(e) => set('addressLine', e.target.value)}
              />
            </Field>
            <Field label="City" htmlFor="city">
              <Input
                id="city"
                value={values.city ?? ''}
                onChange={(e) => set('city', e.target.value)}
              />
            </Field>
            <Field label="Country" htmlFor="country">
              <Input
                id="country"
                value={values.country ?? ''}
                onChange={(e) => set('country', e.target.value)}
              />
            </Field>
          </div>
        </Card>

        <Card>
          <SectionTitle>Trading terms</SectionTitle>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <Field
              label="Currency"
              htmlFor="currencyCode"
              hint="Defaults to the company's base currency"
            >
              <Select
                id="currencyCode"
                value={values.currencyCode ?? ''}
                onChange={(e) => set('currencyCode', e.target.value)}
              >
                <option value="">Base currency</option>
                {currencies.map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.code} — {c.name}
                  </option>
                ))}
              </Select>
            </Field>

            <Field
              label="Payment terms (days)"
              htmlFor="paymentTermsDays"
              hint="Drives the default due date on new documents"
            >
              <Input
                id="paymentTermsDays"
                inputMode="numeric"
                value={String(values.paymentTermsDays ?? 30)}
                onChange={(e) => set('paymentTermsDays', Number(e.target.value) || 0)}
              />
            </Field>

            {kind === 'customer' ? (
              <Field
                label="Credit limit"
                htmlFor="creditLimit"
                hint="Leave blank for no limit"
              >
                <Input
                  id="creditLimit"
                  inputMode="decimal"
                  value={values.creditLimit ?? ''}
                  onChange={(e) => set('creditLimit', e.target.value)}
                />
              </Field>
            ) : null}
          </div>

          <div className="mt-4">
            <Field label="Notes" htmlFor="notes">
              <Input
                id="notes"
                value={values.notes ?? ''}
                onChange={(e) => set('notes', e.target.value)}
              />
            </Field>
          </div>
        </Card>

        <div className="flex items-center gap-2">
          <Button variant="primary" onClick={submit} disabled={!canSubmit}>
            {pending ? 'Saving…' : mode === 'create' ? `Create ${kind}` : 'Save changes'}
          </Button>
          <Link
            href={backHref}
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            Cancel
          </Link>
        </div>
      </div>
    </>
  );
}
