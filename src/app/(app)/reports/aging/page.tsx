import Link from 'next/link';

import { PageHeader, TableWrap } from '@/components/ui';
import * as fmt from '@/lib/format';
import { requireTenantContext } from '@/server/auth/session';
import { getAgingReport } from '@/server/services/contact-service';

export const metadata = { title: 'Aging — LedgerBase' };
export const dynamic = 'force-dynamic';

export default async function AgingPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const params = await searchParams;
  const ctx = await requireTenantContext();

  const direction = params.direction === 'inbound' ? 'inbound' : 'outbound';
  const asOf = params.asOf ?? fmt.todayISO();

  const rows = await getAgingReport(ctx, { direction, asOf });
  const asMoney = (value: string) =>
    fmt.money(value, { currency: ctx.baseCurrencyCode, precision: ctx.currencyPrecision });

  const totals = rows.reduce(
    (acc, row) => ({
      current: acc.current + Number(row.current),
      days1to30: acc.days1to30 + Number(row.days1to30),
      days31to60: acc.days31to60 + Number(row.days31to60),
      days61to90: acc.days61to90 + Number(row.days61to90),
      days90plus: acc.days90plus + Number(row.days90plus),
      total: acc.total + Number(row.total),
    }),
    { current: 0, days1to30: 0, days31to60: 0, days61to90: 0, days90plus: 0, total: 0 },
  );

  return (
    <>
      <PageHeader
        title={direction === 'outbound' ? 'Accounts Receivable Aging' : 'Accounts Payable Aging'}
        description={`Outstanding balances as at ${fmt.date(asOf)}`}
      />

      <div className="mb-4 flex gap-1.5">
        <Link
          href="/reports/aging?direction=outbound"
          className={`rounded-md px-3 py-1.5 text-sm font-medium ${
            direction === 'outbound'
              ? 'bg-accent-subtle text-accent'
              : 'text-muted-foreground hover:bg-surface-muted'
          }`}
        >
          Receivable
        </Link>
        <Link
          href="/reports/aging?direction=inbound"
          className={`rounded-md px-3 py-1.5 text-sm font-medium ${
            direction === 'inbound'
              ? 'bg-accent-subtle text-accent'
              : 'text-muted-foreground hover:bg-surface-muted'
          }`}
        >
          Payable
        </Link>
      </div>

      <TableWrap>
        <table className="data-table">
          <thead>
            <tr>
              <th>{direction === 'outbound' ? 'Customer' : 'Vendor'}</th>
              <th className="text-right">Current</th>
              <th className="text-right">1–30 days</th>
              <th className="text-right">31–60 days</th>
              <th className="text-right">61–90 days</th>
              <th className="text-right">90+ days</th>
              <th className="text-right">Total</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.contactId}>
                <td className="font-medium">{row.contactName}</td>
                <td className="num text-muted-foreground">{asMoney(row.current)}</td>
                <td className="num">{asMoney(row.days1to30)}</td>
                <td className="num">{asMoney(row.days31to60)}</td>
                <td className={`num ${Number(row.days61to90) > 0 ? 'text-warning' : ''}`}>
                  {asMoney(row.days61to90)}
                </td>
                <td className={`num ${Number(row.days90plus) > 0 ? 'text-negative' : ''}`}>
                  {asMoney(row.days90plus)}
                </td>
                <td className="num font-semibold">{asMoney(row.total)}</td>
              </tr>
            ))}
          </tbody>
          {rows.length > 0 ? (
            <tfoot>
              <tr className="border-t-2 border-border-strong bg-surface-muted font-semibold">
                <td className="px-3 py-2">Total</td>
                <td className="num px-3 py-2">{asMoney(String(totals.current))}</td>
                <td className="num px-3 py-2">{asMoney(String(totals.days1to30))}</td>
                <td className="num px-3 py-2">{asMoney(String(totals.days31to60))}</td>
                <td className="num px-3 py-2">{asMoney(String(totals.days61to90))}</td>
                <td className="num px-3 py-2">{asMoney(String(totals.days90plus))}</td>
                <td className="num px-3 py-2">{asMoney(String(totals.total))}</td>
              </tr>
            </tfoot>
          ) : null}
        </table>
      </TableWrap>

      {rows.length === 0 ? (
        <p className="mt-3 text-center text-sm text-muted-foreground">
          Nothing outstanding — every {direction === 'outbound' ? 'invoice' : 'bill'} is settled.
        </p>
      ) : null}
    </>
  );
}
