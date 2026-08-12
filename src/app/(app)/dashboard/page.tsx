import Link from 'next/link';

import { Badge, Card, PageHeader, SectionTitle, Stat, statusTone, TableWrap } from '@/components/ui';
import { TrendChart } from '@/components/trend-chart';
import * as fmt from '@/lib/format';
import { isNegative } from '@/lib/money';
import { requireTenantContext } from '@/server/auth/session';
import { listDocuments } from '@/server/services/document-service';
import {
  getDashboardMetrics,
  getMonthlyTrend,
} from '@/server/services/report-service';
import { listPendingApprovals } from '@/server/services/workflow-service';

export const metadata = { title: 'Dashboard — LedgerBase' };
export const dynamic = 'force-dynamic';

/**
 * Every figure here is computed from the ledger at request time. Nothing is
 * cached, hardcoded or estimated — spec §27, "everything must use real
 * database data".
 */
export default async function DashboardPage() {
  const ctx = await requireTenantContext();
  const year = new Date().getUTCFullYear();
  const range = fmt.yearRange(year);

  const [metrics, trend, recentInvoices, approvals] = await Promise.all([
    getDashboardMetrics(ctx, range),
    getMonthlyTrend(ctx, range),
    listDocuments(ctx, { direction: 'outbound', limit: 8 }),
    listPendingApprovals(ctx),
  ]);

  const currency = ctx.baseCurrencyCode;
  const precision = ctx.currencyPrecision;
  const asMoney = (v: string) => fmt.money(v, { currency, precision });

  return (
    <>
      <PageHeader
        title={`Welcome back, ${ctx.userName.split(' ')[0]}`}
        description={`${ctx.companyName} · financial year ${year}`}
      />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="Revenue (YTD)" value={asMoney(metrics.revenue)} />
        <Stat label="Expenses (YTD)" value={asMoney(metrics.expenses)} />
        <Stat
          label="Net profit (YTD)"
          value={asMoney(metrics.netProfit)}
          tone={isNegative(metrics.netProfit) ? 'negative' : 'positive'}
        />
        <Stat label="Cash on hand" value={asMoney(metrics.cash)} />
      </div>

      <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Stat
          label="Accounts receivable"
          value={asMoney(metrics.accountsReceivable)}
          hint="Owed to you"
        />
        <Stat
          label="Accounts payable"
          value={asMoney(metrics.accountsPayable)}
          hint="You owe"
        />
        <Stat
          label="Overdue invoices"
          value={asMoney(metrics.overdueInvoices.total)}
          hint={`${metrics.overdueInvoices.count} invoice${metrics.overdueInvoices.count === 1 ? '' : 's'} past due`}
          tone={metrics.overdueInvoices.count > 0 ? 'negative' : 'neutral'}
        />
        <Stat
          label="Outstanding bills"
          value={asMoney(metrics.upcomingBills.total)}
          hint={`${metrics.upcomingBills.count} bill${metrics.upcomingBills.count === 1 ? '' : 's'} unpaid`}
        />
      </div>

      <div className="mt-6 grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <SectionTitle>Revenue and expenses</SectionTitle>
          {trend.length > 0 ? (
            <TrendChart
              data={trend.map((point) => ({
                label: point.month,
                revenue: Number(point.revenue),
                expenses: Number(point.expenses),
              }))}
              currency={currency}
            />
          ) : (
            <p className="py-8 text-center text-sm text-muted-foreground">
              No posted activity yet this year.
            </p>
          )}
        </Card>

        <Card>
          <SectionTitle>Awaiting approval</SectionTitle>
          {approvals.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              Nothing is waiting on you.
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {approvals.slice(0, 6).map((approval) => (
                <li key={approval.id} className="py-2">
                  <p className="text-sm font-medium text-foreground">
                    {fmt.humanise(approval.entityType)}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {approval.stepName ?? `Step ${approval.stepOrder}`} ·{' '}
                    {fmt.date(approval.createdAt)}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <div className="mt-6">
        <div className="mb-2 flex items-center justify-between">
          <SectionTitle>Recent invoices</SectionTitle>
          <Link href="/invoices" className="text-xs font-medium text-accent hover:underline">
            View all
          </Link>
        </div>

        {recentInvoices.length === 0 ? (
          <Card>
            <p className="py-8 text-center text-sm text-muted-foreground">
              No invoices yet.{' '}
              <Link href="/invoices/new" className="text-accent hover:underline">
                Create the first one
              </Link>
              .
            </p>
          </Card>
        ) : (
          <TableWrap>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Number</th>
                  <th>Customer</th>
                  <th>Issued</th>
                  <th>Due</th>
                  <th className="text-right">Total</th>
                  <th className="text-right">Balance</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {recentInvoices.map((invoice) => {
                  const due = fmt.relativeDue(invoice.dueDate);
                  return (
                    <tr key={invoice.id}>
                      <td>
                        <Link
                          href={`/invoices/${invoice.id}`}
                          className="font-medium text-accent hover:underline"
                        >
                          {invoice.documentNumber}
                        </Link>
                      </td>
                      <td className="text-muted-foreground">{invoice.contactName}</td>
                      <td className="text-muted-foreground">{fmt.date(invoice.issueDate)}</td>
                      <td>
                        <span
                          className={
                            due.tone === 'negative'
                              ? 'text-negative'
                              : due.tone === 'warning'
                                ? 'text-warning'
                                : 'text-muted-foreground'
                          }
                        >
                          {due.label}
                        </span>
                      </td>
                      <td className="num">
                        {fmt.money(invoice.total, { currency: invoice.currencyCode, precision })}
                      </td>
                      <td className="num">
                        {fmt.money(invoice.balanceDue, {
                          currency: invoice.currencyCode,
                          precision,
                        })}
                      </td>
                      <td>
                        <Badge tone={statusTone(invoice.status)}>
                          {fmt.humanise(invoice.status)}
                        </Badge>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </TableWrap>
        )}
      </div>
    </>
  );
}
