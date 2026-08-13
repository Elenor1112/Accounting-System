import { Badge, PageHeader, TableWrap } from '@/components/ui';
import { YearEndClose } from '@/components/year-end-close';
import * as fmt from '@/lib/format';
import { can } from '@/server/auth/context';
import { PERMISSIONS } from '@/server/auth/permissions';
import { requireTenantContext } from '@/server/auth/session';
import { listPeriods } from '@/server/services/period-service';
import { getLastClosedDate } from '@/server/services/year-end-service';

export const metadata = { title: 'Fiscal Periods — LedgerBase' };
export const dynamic = 'force-dynamic';

const STATUS_TONES = {
  open: 'positive',
  closed: 'warning',
  locked: 'negative',
} as const;

export default async function PeriodsPage() {
  const ctx = await requireTenantContext();
  const [periods, lastClosedDate] = await Promise.all([
    listPeriods(ctx),
    getLastClosedDate(ctx),
  ]);
  const canManage = can(ctx, PERMISSIONS.periods.manage);

  const byYear = new Map<number, typeof periods>();
  for (const period of periods) {
    byYear.set(period.fiscalYear, [...(byYear.get(period.fiscalYear) ?? []), period]);
  }

  return (
    <>
      <PageHeader
        title="Fiscal Periods"
        description="Closing a period stops new postings from landing in a month you have already reported"
      />

      {periods.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border-strong px-6 py-12 text-center text-sm text-muted-foreground">
          No fiscal periods have been generated yet.
        </p>
      ) : (
        <div className="space-y-5">
          {[...byYear.entries()]
            .sort(([a], [b]) => b - a)
            .map(([year, rows]) => (
              <div key={year}>
                <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Fiscal year {year}
                </h2>
                <TableWrap>
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th style={{ width: '60px' }}>#</th>
                        <th>Period</th>
                        <th>Start</th>
                        <th>End</th>
                        <th>Status</th>
                        <th>Closed</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((period) => (
                        <tr key={period.id}>
                          <td className="tabular text-muted-foreground">
                            {period.periodNumber}
                          </td>
                          <td className="font-medium">{period.name}</td>
                          <td className="text-muted-foreground">{fmt.date(period.startDate)}</td>
                          <td className="text-muted-foreground">{fmt.date(period.endDate)}</td>
                          <td>
                            <Badge tone={STATUS_TONES[period.status]}>
                              {fmt.humanise(period.status)}
                            </Badge>
                          </td>
                          <td className="text-muted-foreground">
                            {period.closedAt ? fmt.dateTime(period.closedAt) : '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </TableWrap>

                {canManage ? (
                  <div className="mt-3">
                    <YearEndClose
                      fiscalYear={year}
                      // A year is closed once the company's last close reaches
                      // its end; the service is the authority, this only
                      // decides which control to show.
                      isClosed={Boolean(
                        lastClosedDate &&
                          lastClosedDate >= (rows[rows.length - 1]?.endDate ?? ''),
                      )}
                      currency={ctx.baseCurrencyCode}
                      precision={ctx.currencyPrecision}
                    />
                  </div>
                ) : null}
              </div>
            ))}
        </div>
      )}
    </>
  );
}
