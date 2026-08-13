'use server';

import { revalidatePath } from 'next/cache';

import { requireTenantContext } from '@/server/auth/session';
import { isAppError } from '@/server/errors';
import {
  createJournalEntry,
  deleteDraftEntry,
  postJournalEntry,
  reverseJournalEntry,
  type JournalLineInput,
} from '@/server/services/journal-service';

export interface JournalActionResult {
  ok: boolean;
  error?: string;
  id?: string;
}

export interface JournalEntryFormInput {
  entryDate: string;
  description?: string | null;
  reference?: string | null;
  currencyCode?: string;
  exchangeRate?: string;
  lines: JournalLineInput[];
  post: boolean;
}

/**
 * Server actions for manual journal entries.
 *
 * The accountant's primary tool: accruals, prepayments, depreciation, opening
 * balances, reclassifications and every year-end adjustment are manual entries,
 * and none of them had a route into the system before this. `createJournalEntry`
 * was already complete and correct in the service layer — these actions expose
 * it, and add nothing to the accounting rules.
 *
 * As everywhere else, the tenant context is re-resolved from the session and
 * the service re-checks permissions; the client cannot assert either.
 */
export async function createJournalEntryAction(
  input: JournalEntryFormInput,
): Promise<JournalActionResult> {
  try {
    const ctx = await requireTenantContext();

    const entry = await createJournalEntry(ctx, {
      entryDate: input.entryDate,
      description: input.description?.trim() || null,
      reference: input.reference?.trim() || null,
      currencyCode: input.currencyCode,
      exchangeRate: input.exchangeRate,
      lines: input.lines,
      post: input.post,
      // `allowControlAccounts` is deliberately not passed: a hand-written entry
      // must never touch AR/AP, or the subledger and the ledger would disagree.
    });

    revalidatePath('/journal');
    return { ok: true, id: entry.id };
  } catch (err) {
    return { ok: false, error: toMessage(err) };
  }
}

export async function postJournalEntryAction(
  entryId: string,
): Promise<JournalActionResult> {
  try {
    const ctx = await requireTenantContext();
    await postJournalEntry(ctx, entryId);
    revalidatePath('/journal');
    revalidatePath(`/journal/${entryId}`);
    return { ok: true, id: entryId };
  } catch (err) {
    return { ok: false, error: toMessage(err) };
  }
}

export async function reverseJournalEntryAction(
  entryId: string,
  reason: string,
  reversalDate?: string,
): Promise<JournalActionResult> {
  try {
    const ctx = await requireTenantContext();
    const reversal = await reverseJournalEntry(ctx, entryId, {
      reason,
      // Omitted means "today", which is what a correction actually is. The
      // field exists so a user with period authority can date it deliberately.
      reversalDate: reversalDate || undefined,
    });
    revalidatePath('/journal');
    revalidatePath(`/journal/${entryId}`);
    return { ok: true, id: reversal.id };
  } catch (err) {
    return { ok: false, error: toMessage(err) };
  }
}

export async function deleteDraftEntryAction(
  entryId: string,
): Promise<JournalActionResult> {
  try {
    const ctx = await requireTenantContext();
    await deleteDraftEntry(ctx, entryId);
    revalidatePath('/journal');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: toMessage(err) };
  }
}

/**
 * Domain errors are written for the user ("Entry does not balance: debits
 * 900 vs credits 1000"), so they are surfaced as-is. Anything else is logged
 * and replaced rather than leaking internals into the UI.
 */
function toMessage(err: unknown): string {
  if (isAppError(err)) return err.message;
  console.error('Journal action failed:', err);
  return 'Something went wrong. Please try again.';
}
