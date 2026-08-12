import { ReportControls } from '@/components/report-controls';
import { Card, PageHeader, TableWrap } from '@/components/ui';
import * as fmt from '@/lib/format';
import { requireTenantContext } from '@/server/auth/session';
import { getBalanceSheet } from '@/server/services/report-service';

export const metadata = { title: 'Balance Sheet — LedgerBase' };
export const dynamic = 'force-dynamic';

export default async function BalanceSheetPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const params = await searchParams;
  const ctx = await requireTenantContext();

  const asOf = params.to ?? fmt.todayISO();
  const report = await getBalanceSheet(ctx, { asOf });

  const asMoney = (value: string) =>
    fmt.money(value, { currency: ctx.baseCurrencyCode, precision: ctx.currencyPrecision });

  const [assets, liabilities, equity] = report.sections;

  return (
    <>
      <PageHeader title="Balance Sheet" description={`As at ${fmt.date(asOf)}`} />

      <ReportControls
        basePath="/reports/balance-sheet"
        from={asOf}
        to={asOf}
        mode="asOf"
      />

      {/* The fundamental check, shown rather than assumed. */}
      <div
        className={`mb-4 rounded-md border px-3 py-2 text-sm ${
          report.isBalanced
            ? 'border-positive/30 bg-positive-subtle text-positive'
            : 'border-negative/30 bg-negative-subtle text-negative'
        }`}
      >
        {report.isBalanced
          ? `Balanced — assets ${asMoney(report.totalAssets)} = liabilities ${asMoney(
              report.totalLiabilities,
            )} + equity ${asMoney(report.totalEquity)}`
          : `Out of balance by ${asMoney(report.difference)}. This indicates data written outside the posting service.`}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div>
          <TableWrap>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Assets</th>
                  <th className="text-right">Amount</th>
                </tr>
              </thead>
              <tbody>
                {assets?.accounts.map((account) => (
                  <tr key={account.accountId}>
                    <td>
                      <span className="tabular text-muted-foreground">{account.code}</span>{' '}
                      {account.name}
                    </td>
                    <td className="num">{asMoney(account.balance)}</td>
                  </tr>
                ))}
                <tr className="border-t-2 border-border-strong bg-surface-muted font-semibold">
                  <td className="px-3 py-2">Total assets</td>
                  <td className="num px-3 py-2">{asMoney(report.totalAssets)}</td>
                </tr>
              </tbody>
            </table>
          </TableWrap>
        </div>

        <div className="space-y-4">
          <TableWrap>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Liabilities</th>
                  <th className="text-right">Amount</th>
                </tr>
              </thead>
              <tbody>
                {liabilities?.accounts.length === 0 ? (
                  <tr>
                    <td colSpan={2} className="text-center text-muted-foreground">
                      None
                    </td>
                  </tr>
                ) : (
                  liabilities?.accounts.map((account) => (
                    <tr key={account.accountId}>
                      <td>
                        <span className="tabular text-muted-foreground">{account.code}</span>{' '}
                        {account.name}
                      </td>
                      <td className="num">{asMoney(account.balance)}</td>
                    </tr>
                  ))
                )}
                <tr className="border-t border-border-strong font-medium">
                  <td className="px-3 py-1.5">Total liabilities</td>
                  <td className="num px-3 py-1.5">{asMoney(report.totalLiabilities)}</td>
                </tr>
              </tbody>
            </table>
          </TableWrap>

          <TableWrap>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Equity</th>
                  <th className="text-right">Amount</th>
                </tr>
              </thead>
              <tbody>
                {equity?.accounts.map((account) => (
                  <tr key={account.accountId}>
                    <td>
                      <span className="tabular text-muted-foreground">{account.code}</span>{' '}
                      {account.name}
                    </td>
                    <td className="num">{asMoney(account.balance)}</td>
                  </tr>
                ))}
                <tr>
                  <td className="text-muted-foreground">
                    Current period earnings
                    <span className="ml-1 text-xs text-subtle-foreground">
                      (not yet closed)
                    </span>
                  </td>
                  <td className="num">{asMoney(report.accumulatedProfit)}</td>
                </tr>
                <tr className="border-t border-border-strong font-medium">
                  <td className="px-3 py-1.5">Total equity</td>
                  <td className="num px-3 py-1.5">{asMoney(report.totalEquity)}</td>
                </tr>
                <tr className="border-t-2 border-border-strong bg-surface-muted font-semibold">
                  <td className="px-3 py-2">Liabilities + equity</td>
                  <td className="num px-3 py-2">
                    {asMoney(
                      String(Number(report.totalLiabilities) + Number(report.totalEquity)),
                    )}
                  </td>
                </tr>
              </tbody>
            </table>
          </TableWrap>
        </div>
      </div>
    </>
  );
}
