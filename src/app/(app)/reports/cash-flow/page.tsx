import { ReportControls } from '@/components/report-controls';
import { Card, PageHeader, TableWrap } from '@/components/ui';
import * as fmt from '@/lib/format';
import { isNegative } from '@/lib/money';
import { requireTenantContext } from '@/server/auth/session';
import { getCashFlow } from '@/server/services/report-service';

export const metadata = { title: 'Cash Flow — LedgerBase' };
export const dynamic = 'force-dynamic';

export default async function CashFlowPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const params = await searchParams;
  const ctx = await requireTenantContext();

  const defaults = fmt.yearRange();
  const range = { from: params.from ?? defaults.from, to: params.to ?? defaults.to };

  const report = await getCashFlow(ctx, range);
  const asMoney = (value: string) =>
    fmt.money(value, { currency: ctx.baseCurrencyCode, precision: ctx.currencyPrecision });

  const rows = [
    { label: 'Operating activities', value: report.operating },
    { label: 'Investing activities', value: report.investing },
    { label: 'Financing activities', value: report.financing },
  ];

  return (
    <>
      <PageHeader
        title="Cash Flow"
        description={`${fmt.date(range.from)} — ${fmt.date(range.to)}`}
      />

      <ReportControls basePath="/reports/cash-flow" from={range.from} to={range.to} />

      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        <Card>
          <p className="text-xs font-medium text-muted-foreground">Opening cash</p>
          <p className="mt-1 text-xl font-semibold tabular">{asMoney(report.openingCash)}</p>
        </Card>
        <Card>
          <p className="text-xs font-medium text-muted-foreground">Net movement</p>
          <p
            className={`mt-1 text-xl font-semibold tabular ${
              isNegative(report.netChange) ? 'text-negative' : 'text-positive'
            }`}
          >
            {asMoney(report.netChange)}
          </p>
        </Card>
        <Card>
          <p className="text-xs font-medium text-muted-foreground">Closing cash</p>
          <p className="mt-1 text-xl font-semibold tabular">{asMoney(report.closingCash)}</p>
        </Card>
      </div>

      <TableWrap>
        <table className="data-table">
          <thead>
            <tr>
              <th>Activity</th>
              <th className="text-right">Net cash movement</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.label}>
                <td>{row.label}</td>
                <td className={`num ${isNegative(row.value) ? 'text-negative' : ''}`}>
                  {asMoney(row.value)}
                </td>
              </tr>
            ))}
            <tr className="border-t-2 border-border-strong bg-surface-muted font-semibold">
              <td className="px-3 py-2">Net change in cash</td>
              <td className="num px-3 py-2">{asMoney(report.netChange)}</td>
            </tr>
          </tbody>
        </table>
      </TableWrap>

      {/* Stating the method's limits rather than implying more precision than
          an indirect classification can give. */}
      <p className="mt-3 text-xs text-subtle-foreground">
        Activities are classified indirectly, from the counterpart account each cash entry
        touches. Entries spanning several categories are attributed to the most specific one
        present.
      </p>
    </>
  );
}
