import { ReportControls } from '@/components/report-controls';
import { Card, PageHeader, TableWrap } from '@/components/ui';
import * as fmt from '@/lib/format';
import { isNegative } from '@/lib/money';
import { requireTenantContext } from '@/server/auth/session';
import { getProfitAndLoss } from '@/server/services/report-service';

export const metadata = { title: 'Profit & Loss — LedgerBase' };
export const dynamic = 'force-dynamic';

export default async function ProfitLossPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const params = await searchParams;
  const ctx = await requireTenantContext();

  const defaults = fmt.yearRange();
  const range = { from: params.from ?? defaults.from, to: params.to ?? defaults.to };

  const report = await getProfitAndLoss(ctx, range);
  const asMoney = (value: string) =>
    fmt.money(value, { currency: ctx.baseCurrencyCode, precision: ctx.currencyPrecision });

  return (
    <>
      <PageHeader
        title="Profit & Loss"
        description={`${fmt.date(range.from)} — ${fmt.date(range.to)}`}
      />

      <ReportControls basePath="/reports/profit-loss" from={range.from} to={range.to} />

      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        <Card>
          <p className="text-xs font-medium text-muted-foreground">Revenue</p>
          <p className="mt-1 text-xl font-semibold tabular">{asMoney(report.totalRevenue)}</p>
        </Card>
        <Card>
          <p className="text-xs font-medium text-muted-foreground">Expenses</p>
          <p className="mt-1 text-xl font-semibold tabular">{asMoney(report.totalExpenses)}</p>
        </Card>
        <Card>
          <p className="text-xs font-medium text-muted-foreground">Net profit</p>
          <p
            className={`mt-1 text-xl font-semibold tabular ${
              isNegative(report.netProfit) ? 'text-negative' : 'text-positive'
            }`}
          >
            {asMoney(report.netProfit)}
          </p>
        </Card>
      </div>

      <TableWrap>
        <table className="data-table">
          <thead>
            <tr>
              <th style={{ width: '110px' }}>Code</th>
              <th>Account</th>
              <th className="text-right">Amount</th>
            </tr>
          </thead>
          <tbody>
            {report.sections.map((section) => (
              <SectionRows
                key={section.title}
                title={section.title}
                accounts={section.accounts}
                total={section.total}
                asMoney={asMoney}
              />
            ))}

            <tr className="bg-surface-muted font-semibold">
              <td colSpan={2} className="px-3 py-2">
                Gross profit
              </td>
              <td className="num px-3 py-2">{asMoney(report.grossProfit)}</td>
            </tr>
            <tr className="border-t-2 border-border-strong bg-surface-muted font-semibold">
              <td colSpan={2} className="px-3 py-2">
                Net profit
              </td>
              <td
                className={`num px-3 py-2 ${
                  isNegative(report.netProfit) ? 'text-negative' : 'text-positive'
                }`}
              >
                {asMoney(report.netProfit)}
              </td>
            </tr>
          </tbody>
        </table>
      </TableWrap>

      {report.sections.every((s) => s.accounts.length === 0) ? (
        <p className="mt-3 text-center text-sm text-muted-foreground">
          No posted revenue or expenses in this period.
        </p>
      ) : null}
    </>
  );
}

function SectionRows({
  title,
  accounts,
  total,
  asMoney,
}: {
  title: string;
  accounts: Array<{ accountId: string; code: string; name: string; balance: string }>;
  total: string;
  asMoney: (value: string) => string;
}) {
  if (accounts.length === 0) return null;

  return (
    <>
      <tr className="bg-surface-muted">
        <td colSpan={3} className="px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {title}
        </td>
      </tr>
      {accounts.map((account) => (
        <tr key={account.accountId}>
          <td className="tabular text-muted-foreground">{account.code}</td>
          <td>{account.name}</td>
          <td className="num">{asMoney(account.balance)}</td>
        </tr>
      ))}
      <tr className="font-medium">
        <td colSpan={2} className="px-3 py-1.5 text-right text-muted-foreground">
          Total {title.toLowerCase()}
        </td>
        <td className="num px-3 py-1.5">{asMoney(total)}</td>
      </tr>
    </>
  );
}
