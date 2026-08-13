'use client';

import { useState, useTransition } from 'react';

import {
  closeFiscalYearAction,
  previewYearEndAction,
} from '@/app/(app)/periods/actions';
import * as fmt from '@/lib/format';

import { Button, Card, ErrorBanner, SectionTitle } from './ui';

type Preview = NonNullable<
  Awaited<ReturnType<typeof previewYearEndAction>>['preview']
>;

/**
 * Year-end close.
 *
 * Deliberately a two-step flow: preview, then commit. The close posts a real
 * journal entry that zeroes every revenue and expense account and moves the
 * result to retained earnings, and while it can be reversed like any other
 * entry, it is not something to trigger from a single unlabelled button. The
 * preview exists so the accountant can tie the net income to the P&L they have
 * already reviewed before committing.
 */
export function YearEndClose({
  fiscalYear,
  isClosed,
  currency,
  precision,
}: {
  fiscalYear: number;
  isClosed: boolean;
  currency: string;
  precision: number;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [lockPeriods, setLockPeriods] = useState(false);

  const asMoney = (value: string) => fmt.money(value, { currency, precision });

  if (isClosed) {
    return (
      <p className="text-xs text-muted-foreground">
        This year has been closed to retained earnings.
      </p>
    );
  }

  const loadPreview = () => {
    setError(null);
    startTransition(async () => {
      const result = await previewYearEndAction(fiscalYear);
      if (result.ok && result.preview) setPreview(result.preview);
      else setError(result.error ?? 'Could not calculate the year-end position');
    });
  };

  const commit = () => {
    setError(null);
    startTransition(async () => {
      const result = await closeFiscalYearAction(fiscalYear, lockPeriods);
      if (result.ok) {
        setPreview(null);
        setMessage(result.message ?? 'Year closed.');
      } else {
        setError(result.error ?? 'Could not close the year');
      }
    });
  };

  if (message) {
    return (
      <div className="rounded-md border border-positive/30 bg-positive-subtle px-3 py-2 text-sm text-positive">
        {message}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {error ? <ErrorBanner message={error} /> : null}

      {!preview ? (
        <div>
          <Button onClick={loadPreview} disabled={pending}>
            {pending ? 'Calculating…' : `Close ${fiscalYear}…`}
          </Button>
        </div>
      ) : (
        <Card>
          <SectionTitle>Closing {preview.fiscalYear}</SectionTitle>

          <dl className="mt-2 space-y-1.5 text-sm">
            <div className="flex justify-between">
              <dt className="text-muted-foreground">Period</dt>
              <dd>
                {fmt.date(preview.startDate)} — {fmt.date(preview.endDate)}
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted-foreground">Revenue</dt>
              <dd className="num">{asMoney(preview.revenue)}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted-foreground">Expenses</dt>
              <dd className="num">{asMoney(preview.expenses)}</dd>
            </div>
            <div className="flex justify-between border-t border-border pt-1.5 font-medium">
              <dt>Net {preview.isLoss ? 'loss' : 'profit'}</dt>
              <dd className={`num ${preview.isLoss ? 'text-negative' : 'text-positive'}`}>
                {asMoney(preview.netIncome.replace('-', ''))}
              </dd>
            </div>
          </dl>

          <p className="mt-3 text-xs text-muted-foreground">
            {preview.accountsToClose} revenue and expense account
            {preview.accountsToClose === 1 ? '' : 's'} will be brought to nil, and the
            net {preview.isLoss ? 'loss debited to' : 'profit credited to'} retained
            earnings. The entry is dated {fmt.date(preview.endDate)}.
          </p>

          {preview.unpostedCount > 0 ? (
            <div className="mt-3">
              <ErrorBanner
                message={`${preview.unpostedCount} entry/entries dated in ${preview.fiscalYear} are still unposted. Post or delete them first — otherwise their results are excluded from retained earnings.`}
              />
            </div>
          ) : null}

          <label className="mt-3 flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={lockPeriods}
              onChange={(e) => setLockPeriods(e.target.checked)}
            />
            <span>
              Lock this year&rsquo;s periods afterwards
              <span className="block text-xs text-muted-foreground">
                Permanent. Leave unchecked if the audit has not signed off yet.
              </span>
            </span>
          </label>

          <div className="mt-4 flex gap-2">
            <Button variant="ghost" onClick={() => setPreview(null)} disabled={pending}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={commit}
              disabled={pending || preview.alreadyClosed || preview.unpostedCount > 0}
            >
              {pending ? 'Closing…' : `Post closing entry`}
            </Button>
          </div>
        </Card>
      )}
    </div>
  );
}
