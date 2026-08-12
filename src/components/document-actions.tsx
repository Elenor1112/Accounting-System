'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

import {
  postDocumentAction,
  sendDocumentAction,
  voidDocumentAction,
} from '@/app/(app)/invoices/actions';

import { Button, ErrorBanner, Input } from './ui';

/**
 * Lifecycle controls for a document.
 *
 * Which buttons appear follows the document's actual state: a draft can be
 * posted, a posted sales document can be sent, and anything unpaid can be
 * voided. Destructive actions ask for a reason, which is recorded in the audit
 * trail alongside the reversal.
 */
export function DocumentActions({
  documentId,
  status,
  isPosted,
  documentType,
  isSale,
  canApprove,
  canSend,
  hasPayments,
}: {
  documentId: string;
  status: string;
  isPosted: boolean;
  documentType: string;
  isSale: boolean;
  canApprove: boolean;
  canSend: boolean;
  hasPayments: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [voiding, setVoiding] = useState(false);
  const [reason, setReason] = useState('');

  const isTerminal = status === 'void' || status === 'cancelled';
  // Quotes and purchase orders are commercial offers, not financial documents.
  const isPostable = documentType !== 'quote' && documentType !== 'purchase_order';

  const run = (action: () => Promise<{ ok: boolean; error?: string }>) => {
    setError(null);
    startTransition(async () => {
      const result = await action();
      if (result.ok) {
        setVoiding(false);
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

      {voiding ? (
        <div className="flex w-full max-w-md flex-col gap-2 rounded-md border border-border bg-surface p-3">
          <p className="text-sm text-foreground">
            Voiding reverses this document&rsquo;s journal entry. The document and its
            history are kept.
          </p>
          <Input
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Reason (recorded in the audit log)"
            autoFocus
          />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setVoiding(false)} disabled={pending}>
              Cancel
            </Button>
            <Button
              variant="danger"
              disabled={pending || reason.trim().length === 0}
              onClick={() => run(() => voidDocumentAction(documentId, reason))}
            >
              {pending ? 'Voiding…' : 'Void document'}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          {!isPosted && isPostable && canApprove && !isTerminal ? (
            <Button
              variant="primary"
              disabled={pending}
              onClick={() => run(() => postDocumentAction(documentId))}
            >
              {pending ? 'Posting…' : 'Approve & post'}
            </Button>
          ) : null}

          {isPosted && isSale && status !== 'sent' && status !== 'paid' && canSend ? (
            <Button
              disabled={pending}
              onClick={() => run(() => sendDocumentAction(documentId))}
            >
              Mark as sent
            </Button>
          ) : null}

          {isPosted && !hasPayments && !isTerminal && canApprove ? (
            <Button variant="ghost" onClick={() => setVoiding(true)}>
              Void
            </Button>
          ) : null}
        </div>
      )}
    </div>
  );
}
