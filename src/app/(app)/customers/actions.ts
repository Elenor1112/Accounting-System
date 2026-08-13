'use server';

import { revalidatePath } from 'next/cache';

import { requireTenantContext } from '@/server/auth/session';
import { isAppError } from '@/server/errors';
import {
  archiveContact,
  createContact,
  updateContact,
  type ContactKind,
} from '@/server/services/contact-service';

export interface ContactActionResult {
  ok: boolean;
  error?: string;
  id?: string;
}

export interface ContactFormInput {
  kind: ContactKind;
  displayName: string;
  legalName?: string | null;
  contactPerson?: string | null;
  email?: string | null;
  phone?: string | null;
  mobile?: string | null;
  website?: string | null;
  taxIdentifier?: string | null;
  category?: string | null;
  currencyCode?: string | null;
  paymentTermsDays?: number;
  creditLimit?: string | null;
  billingAddress?: Record<string, unknown>;
  notes?: string | null;
}

/**
 * Server actions for customers and vendors.
 *
 * Both lists are served from one action set because they are one table with a
 * `kind` discriminator — a counterparty you both buy from and sell to is a
 * single record marked `both`, not two records that drift apart.
 */
export async function createContactAction(
  input: ContactFormInput,
): Promise<ContactActionResult> {
  try {
    const ctx = await requireTenantContext();
    const contact = await createContact(ctx, {
      ...input,
      creditLimit: input.creditLimit?.trim() || null,
    });

    revalidatePath('/customers');
    revalidatePath('/vendors');
    return { ok: true, id: contact.id };
  } catch (err) {
    return { ok: false, error: toMessage(err) };
  }
}

export async function updateContactAction(
  contactId: string,
  input: Partial<ContactFormInput>,
): Promise<ContactActionResult> {
  try {
    const ctx = await requireTenantContext();
    await updateContact(ctx, contactId, {
      ...input,
      creditLimit: input.creditLimit?.trim() || null,
    } as never);

    revalidatePath('/customers');
    revalidatePath('/vendors');
    revalidatePath(`/customers/${contactId}`);
    revalidatePath(`/vendors/${contactId}`);
    return { ok: true, id: contactId };
  } catch (err) {
    return { ok: false, error: toMessage(err) };
  }
}

/**
 * Archives rather than deletes. A contact with posted history can never be
 * removed — the documents referencing it are financial records — so the
 * service refuses while a balance is outstanding and deactivates otherwise.
 */
export async function archiveContactAction(
  contactId: string,
): Promise<ContactActionResult> {
  try {
    const ctx = await requireTenantContext();
    await archiveContact(ctx, contactId);

    revalidatePath('/customers');
    revalidatePath('/vendors');
    revalidatePath(`/customers/${contactId}`);
    revalidatePath(`/vendors/${contactId}`);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: toMessage(err) };
  }
}

/** Reactivates an archived contact. */
export async function restoreContactAction(
  contactId: string,
): Promise<ContactActionResult> {
  try {
    const ctx = await requireTenantContext();
    await updateContact(ctx, contactId, { isActive: true });

    revalidatePath('/customers');
    revalidatePath('/vendors');
    revalidatePath(`/customers/${contactId}`);
    revalidatePath(`/vendors/${contactId}`);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: toMessage(err) };
  }
}

function toMessage(err: unknown): string {
  if (isAppError(err)) return err.message;
  console.error('Contact action failed:', err);
  return 'Something went wrong. Please try again.';
}
