'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

import {
  deleteDraftEntryAction,
  postJournalEntryAction,
  reverseJournalEntryAction,
} from '@/app/(app)/journal/actions';
import * as fmt from '@/lib/format';

import { Button, ErrorBanner, Field, Input } from './ui';

/**
 * Lifecycle controls for a manual journal entry.
 *
 * A draft can be posted or deleted; a posted entry can only be reversed, never
 * edited or removed — financial history is superseded by a linked correction
 * rather than rewritten. The reversal asks for a reason (the service requires
 * one) and offers a date, defaulting to today so an August correction does not
 * silently reopen June.
 */
export function JournalActions({
  entryId,
  status,
  isReversed,
  canPost,
  canReverse,
  canCreate,
}: {
  entryId: string;
  status: string;
  isReversed: boolean;
  canPost: boolean;
  canReverse: boolean;
  canCreate: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [reversing, setReversing] = useState(false);
  const [reason, setReason] = useState('');
  const [reversalDate, setReversalDate] = useState(fmt.todayISO());

  const isDraft = status === 'draft' || status === 'pending_approval';
  const isPosted = status === 'posted';

  const run = (action: () => Promise<{ ok: boolean; error?: string; id?: string }>) => {
    setError(null);
    startTransition(async () => {
      const result = await action();
      if (result.ok) {
        setReversing(false);
        setReason('');
        router.refresh();
      } else {
        setError(result.error ?? 'Action failed');
      }
    });
  };

  return (
    <div className="flex flex-col items-end gap-2">
      {error ? (
        <div className="w-full max-w-md">
          <ErrorBanner message={error} />
        </div>
      ) : null}

      {reversing ? (
        <div className="flex w-full max-w-md flex-col gap-3 rounded-md border border-border bg-surface p-3">
          <p className="text-sm text-foreground">
            Reversing posts an equal and opposite entry, linked to this one. The
            original stays in the ledger.
          </p>

          <Field
            label="Reversal date"
            htmlFor="reversal-date"
            hint="Defaults to today, so a correction lands in the current period"
          >
            <Input
              id="reversal-date"
              type="date"
              value={reversalDate}
              onChange={(event) => setReversalDate(event.target.value)}
            />
          </Field>

          <Input
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Reason (recorded in the audit log)"
            aria-label="Reversal reason"
            autoFocus
          />

          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setReversing(false)} disabled={pending}>
              Cancel
            </Button>
            <Button
              variant="danger"
              disabled={pending || reason.trim().length === 0}
              onClick={() =>
                run(() => reverseJournalEntryAction(entryId, reason, reversalDate))
              }
            >
              {pending ? 'Reversing…' : 'Post reversal'}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          {isDraft && canPost ? (
            <Button
              variant="primary"
              disabled={pending}
              onClick={() => run(() => postJournalEntryAction(entryId))}
            >
              {pending ? 'Posting…' : 'Post to ledger'}
            </Button>
          ) : null}

          {isPosted && !isReversed && canReverse ? (
            <Button variant="ghost" onClick={() => setReversing(true)}>
              Reverse
            </Button>
          ) : null}

          {isDraft && canCreate ? (
            <Button
              variant="ghost"
              disabled={pending}
              onClick={() => {
                run(async () => {
                  const result = await deleteDraftEntryAction(entryId);
                  if (result.ok) router.push('/journal');
                  return result;
                });
              }}
            >
              Delete draft
            </Button>
          ) : null}
        </div>
      )}
    </div>
  );
}
