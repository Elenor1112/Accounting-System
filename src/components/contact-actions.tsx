'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

import {
  archiveContactAction,
  restoreContactAction,
} from '@/app/(app)/customers/actions';

import { Button, ErrorBanner } from './ui';

/**
 * Actions on a customer or vendor.
 *
 * Archiving is refused by the service while a balance is outstanding — a party
 * you are still owed by cannot be quietly removed from the list — so the error
 * it returns is shown rather than the button being hidden.
 */
export function ContactActions({
  contactId,
  basePath,
  isActive,
  canManage,
  canInvoice,
  documentHref,
}: {
  contactId: string;
  basePath: string;
  isActive: boolean;
  canManage: boolean;
  canInvoice: boolean;
  documentHref: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const run = (action: () => Promise<{ ok: boolean; error?: string }>) => {
    setError(null);
    startTransition(async () => {
      const result = await action();
      if (result.ok) router.refresh();
      else setError(result.error ?? 'Action failed');
    });
  };

  return (
    <div className="flex flex-col items-end gap-2">
      {error ? (
        <div className="w-full max-w-md">
          <ErrorBanner message={error} />
        </div>
      ) : null}

      <div className="flex items-center gap-2">
        {canInvoice && isActive ? (
          <Link href={`${documentHref}/new`}>
            <Button variant="primary">
              {documentHref === '/invoices' ? 'New invoice' : 'New bill'}
            </Button>
          </Link>
        ) : null}

        {canManage ? (
          <Link href={`${basePath}/${contactId}/edit`}>
            <Button>Edit</Button>
          </Link>
        ) : null}

        {canManage ? (
          isActive ? (
            <Button
              variant="ghost"
              disabled={pending}
              onClick={() => run(() => archiveContactAction(contactId))}
            >
              {pending ? 'Archiving…' : 'Archive'}
            </Button>
          ) : (
            <Button
              variant="ghost"
              disabled={pending}
              onClick={() => run(() => restoreContactAction(contactId))}
            >
              {pending ? 'Restoring…' : 'Restore'}
            </Button>
          )
        ) : null}
      </div>
    </div>
  );
}
