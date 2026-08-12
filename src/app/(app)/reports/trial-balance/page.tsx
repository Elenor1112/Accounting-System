import { ReportControls } from '@/components/report-controls';
import { PageHeader, TableWrap } from '@/components/ui';
import * as fmt from '@/lib/format';
import { requireTenantContext } from '@/server/auth/session';
import { getTrialBalance } from '@/server/services/report-service';

export const metadata = { title: 'Trial Balance — LedgerBase' };
export const dynamic = 'force-dynamic';

export default async function TrialBalancePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const params = await searchParams;
  const ctx = await requireTenantContext();

  const defaults = fmt.yearRange();
  const range = { from: params.from ?? defaults.from, to: params.to ?? defaults.to };

  const report = await getTrialBalance(ctx, range);
  const asMoney = (value: string) =>
    fmt.money(value, { currency: ctx.baseCurrencyCode, precision: ctx.currencyPrecision });

  return (
    <>
      <PageHeader
        title="Trial Balance"
        description={`${fmt.date(range.from)} — ${fmt.date(range.to)}`}
      />

      <ReportControls basePath="/reports/trial-balance" from={range.from} to={range.to} />

      <div
        className={`mb-4 rounded-md border px-3 py-2 text-sm ${
          report.isBalanced
            ? 'border-positive/30 bg-positive-subtle text-positive'
            : 'border-negative/30 bg-negative-subtle text-negative'
        }`}
      >
        {report.isBalanced
          ? `In balance — total debits ${asMoney(report.totalDebit)} equal total credits.`
          : `Out of balance: debits ${asMoney(report.totalDebit)} vs credits ${asMoney(report.totalCredit)}.`}
      </div>

      <TableWrap>
        <table className="data-table">
          <thead>
            <tr>
              <th style={{ width: '110px' }}>Code</th>
              <th>Account</th>
              <th style={{ width: '120px' }}>Type</th>
              <th className="text-right">Debit</th>
              <th className="text-right">Credit</th>
            </tr>
          </thead>
          <tbody>
            {report.rows.map((row) => (
              <tr key={row.accountId}>
                <td className="tabular text-muted-foreground">{row.code}</td>
                <td>{row.name}</td>
                <td className="text-muted-foreground">{fmt.humanise(row.type)}</td>
                <td className="num">{Number(row.debit) > 0 ? asMoney(row.debit) : ''}</td>
                <td className="num">{Number(row.credit) > 0 ? asMoney(row.credit) : ''}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-border-strong bg-surface-muted font-semibold">
              <td colSpan={3} className="px-3 py-2 text-right">
                Totals
              </td>
              <td className="num px-3 py-2">{asMoney(report.totalDebit)}</td>
              <td className="num px-3 py-2">{asMoney(report.totalCredit)}</td>
            </tr>
          </tfoot>
        </table>
      </TableWrap>

      {report.rows.length === 0 ? (
        <p className="mt-3 text-center text-sm text-muted-foreground">
          No posted activity in this period.
        </p>
      ) : null}
    </>
  );
}
