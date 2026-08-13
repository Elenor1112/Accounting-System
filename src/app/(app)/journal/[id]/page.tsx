import Link from 'next/link';
import { notFound } from 'next/navigation';

import { JournalActions } from '@/components/journal-actions';
import { Badge, Card, PageHeader, SectionTitle, statusTone, TableWrap } from '@/components/ui';
import * as fmt from '@/lib/format';
import { NotFoundError } from '@/server/errors';
import { can } from '@/server/auth/context';
import { PERMISSIONS } from '@/server/auth/permissions';
import { requireTenantContext } from '@/server/auth/session';
import { getJournalEntry } from '@/server/services/journal-service';

export const dynamic = 'force-dynamic';

export default async function JournalEntryPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const ctx = await requireTenantContext();

  let data: Awaited<ReturnType<typeof getJournalEntry>>;
  try {
    data = await getJournalEntry(ctx, id);
  } catch (err) {
    if (err instanceof NotFoundError) notFound();
    throw err;
  }

  const { entry, lines } = data;
  const precision = ctx.currencyPrecision;
  const isForeign = entry.currencyCode !== ctx.baseCurrencyCode;

  const baseMoney = (value: string) =>
    fmt.money(value, { currency: ctx.baseCurrencyCode, precision });

  return (
    <>
      <div className="mb-4">
        <Link href="/journal" className="text-xs text-muted-foreground hover:text-foreground">
          ← Journal entries
        </Link>
      </div>

      <PageHeader
        title={entry.entryNumber}
        description={entry.description ?? undefined}
        actions={
          <>
            <Badge tone={statusTone(entry.status)}>{fmt.humanise(entry.status)}</Badge>
            <JournalActions
              entryId={entry.id}
              status={entry.status}
              isReversed={Boolean(entry.reversedByEntryId)}
              canPost={can(ctx, PERMISSIONS.transactions.post)}
              canReverse={can(ctx, PERMISSIONS.transactions.reverse)}
              canCreate={can(ctx, PERMISSIONS.transactions.create)}
            />
          </>
        }
      />

      {entry.reversesEntryId || entry.reversedByEntryId ? (
        <div className="mb-4 rounded-md border border-warning/30 bg-warning-subtle px-3 py-2 text-sm text-warning">
          {entry.reversesEntryId ? (
            <>
              This entry reverses{' '}
              <Link href={`/journal/${entry.reversesEntryId}`} className="underline">
                the original entry
              </Link>
              .
            </>
          ) : (
            <>
              This entry was reversed by{' '}
              <Link href={`/journal/${entry.reversedByEntryId}`} className="underline">
                a later correction
              </Link>
              . Both remain in the ledger.
            </>
          )}
        </div>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <TableWrap>
            <table className="data-table">
              <thead>
                <tr>
                  <th style={{ width: '90px' }}>Code</th>
                  <th>Account</th>
                  <th>Description</th>
                  {isForeign ? (
                    <>
                      <th className="text-right">Debit ({entry.currencyCode})</th>
                      <th className="text-right">Credit ({entry.currencyCode})</th>
                    </>
                  ) : null}
                  <th className="text-right">Debit</th>
                  <th className="text-right">Credit</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((line) => (
                  <tr key={line.id}>
                    <td className="tabular text-muted-foreground">{line.accountCode}</td>
                    <td>{line.accountName}</td>
                    <td className="text-muted-foreground">{line.description ?? '—'}</td>
                    {isForeign ? (
                      <>
                        <td className="num text-muted-foreground">
                          {Number(line.debit) > 0
                            ? fmt.money(line.debit, { precision })
                            : ''}
                        </td>
                        <td className="num text-muted-foreground">
                          {Number(line.credit) > 0
                            ? fmt.money(line.credit, { precision })
                            : ''}
                        </td>
                      </>
                    ) : null}
                    <td className="num">
                      {Number(line.baseDebit) > 0 ? fmt.money(line.baseDebit, { precision }) : ''}
                    </td>
                    <td className="num">
                      {Number(line.baseCredit) > 0
                        ? fmt.money(line.baseCredit, { precision })
                        : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-border-strong font-semibold">
                  <td colSpan={isForeign ? 5 : 3} className="px-3 py-2 text-right">
                    Totals
                  </td>
                  <td className="num px-3 py-2">{baseMoney(entry.totalDebit)}</td>
                  <td className="num px-3 py-2">{baseMoney(entry.totalCredit)}</td>
                </tr>
              </tfoot>
            </table>
          </TableWrap>

          {/* The invariant, stated plainly — a posted entry always satisfies it. */}
          <p className="mt-2 text-xs text-subtle-foreground">
            {entry.totalDebit === entry.totalCredit
              ? 'Debits equal credits.'
              : 'This entry does not balance.'}
          </p>
        </div>

        <Card>
          <SectionTitle>Details</SectionTitle>
          <dl className="space-y-1.5 text-sm">
            <Row label="Date" value={fmt.date(entry.entryDate)} />
            <Row label="Source" value={fmt.humanise(entry.sourceType)} />
            <Row label="Currency" value={entry.currencyCode} />
            {isForeign ? (
              <Row label="Exchange rate" value={String(Number(entry.exchangeRate))} />
            ) : null}
            {entry.reference ? <Row label="Reference" value={entry.reference} /> : null}
            <Row label="Posted" value={fmt.dateTime(entry.postedAt)} />
          </dl>

          {entry.sourceId && entry.sourceType !== 'manual' ? (
            <Link
              href={
                entry.sourceType === 'bill'
                  ? `/bills/${entry.sourceId}`
                  : entry.sourceType === 'payment'
                    ? `/payments`
                    : entry.sourceType === 'expense'
                      ? `/expenses`
                      : `/invoices/${entry.sourceId}`
              }
              className="mt-3 block border-t border-border pt-2 text-xs font-medium text-accent hover:underline"
            >
              View source {fmt.humanise(entry.sourceType).toLowerCase()} →
            </Link>
          ) : null}
        </Card>
      </div>
    </>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="tabular text-foreground">{value}</dd>
    </div>
  );
}
