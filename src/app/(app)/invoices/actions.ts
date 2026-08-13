'use server';

import { revalidatePath } from 'next/cache';

import { isAppError } from '@/server/errors';
import { requireTenantContext } from '@/server/auth/session';
import {
  createDocument,
  markDocumentSent,
  postDocument,
  voidDocument,
  type CreateDocumentInput,
} from '@/server/services/document-service';

export interface ActionResult {
  ok: boolean;
  error?: string;
  id?: string;
  /** Set when the document entered an approval chain instead of posting. */
  message?: string;
}

/**
 * Server actions for document lifecycle.
 *
 * Each re-resolves the tenant context from the session rather than trusting
 * anything the client sent, and each service call re-checks the caller's
 * permission — so a hidden button is a convenience, not the control.
 */
export async function postDocumentAction(documentId: string): Promise<ActionResult> {
  try {
    const ctx = await requireTenantContext();
    const result = await postDocument(ctx, documentId);
    revalidatePath('/invoices');
    revalidatePath('/bills');
    revalidatePath(`/invoices/${documentId}`);
    revalidatePath(`/bills/${documentId}`);

    // An amount above a configured threshold does not post on this click: it
    // now waits for the signatures the workflow requires. Say so, rather than
    // reporting a success the ledger did not receive.
    if ('pendingApproval' in result) {
      return {
        ok: true,
        message:
          `Submitted for approval: ${result.stepsRequired} ` +
          `${result.stepsRequired === 1 ? 'approval is' : 'approvals are'} required ` +
          'before this document can post to the ledger.',
      };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: toMessage(err) };
  }
}

export async function sendDocumentAction(documentId: string): Promise<ActionResult> {
  try {
    const ctx = await requireTenantContext();
    await markDocumentSent(ctx, documentId);
    revalidatePath(`/invoices/${documentId}`);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: toMessage(err) };
  }
}

export async function voidDocumentAction(
  documentId: string,
  reason: string,
): Promise<ActionResult> {
  try {
    const ctx = await requireTenantContext();
    await voidDocument(ctx, documentId, reason);
    revalidatePath('/invoices');
    revalidatePath('/bills');
    revalidatePath(`/invoices/${documentId}`);
    revalidatePath(`/bills/${documentId}`);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: toMessage(err) };
  }
}

export async function createDocumentAction(
  input: CreateDocumentInput,
): Promise<ActionResult> {
  try {
    const ctx = await requireTenantContext();
    const document = await createDocument(ctx, input);
    revalidatePath(input.direction === 'outbound' ? '/invoices' : '/bills');
    return { ok: true, id: document.id };
  } catch (err) {
    return { ok: false, error: toMessage(err) };
  }
}

/**
 * Domain errors carry messages written for the user ("only 250 is
 * outstanding"), so they are surfaced as-is. Anything else is logged and
 * replaced, to avoid leaking internals into the UI.
 */
function toMessage(err: unknown): string {
  if (isAppError(err)) return err.message;
  console.error('Document action failed:', err);
  return 'Something went wrong. Please try again.';
}
