import { ReportControls } from '@/components/report-controls';
import { PageHeader, SectionTitle, Stat, TableWrap } from '@/components/ui';
import * as fmt from '@/lib/format';
import { requireTenantContext } from '@/server/auth/session';
import { getTaxReport } from '@/server/services/report-service';

export const metadata = { title: 'Tax Report — LedgerBase' };
export const dynamic = 'force-dynamic';

export default async function TaxReportPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const params = await searchParams;
  const ctx = await requireTenantContext();

  const defaults = fmt.yearRange();
  const range = { from: params.from ?? defaults.from, to: params.to ?? defaults.to };

  const report = await getTaxReport(ctx, range);
  const asMoney = (value: string) =>
    fmt.money(value, { currency: ctx.baseCurrencyCode, precision: ctx.currencyPrecision });

  const isPayable = !report.netTaxPayable.startsWith('-');

  return (
    <>
      <PageHeader
        title="Tax Report"
        description={`${fmt.date(range.from)} — ${fmt.date(range.to)}`}
      />

      <ReportControls basePath="/reports/tax" from={range.from} to={range.to} />

      {/*
        The tie-out to the ledger. A tax return assembled from documents that
        does not agree with the tax control accounts means something moved
        those accounts outside the invoice/bill subledger — the filer needs to
        know before submitting, not after an assessment.
      */}
      <div
        className={`mb-4 rounded-md border px-3 py-2 text-sm ${
          report.reconciliation.isReconciled
            ? 'border-positive/30 bg-positive-subtle text-positive'
            : 'border-warning/30 bg-warning-subtle text-warning'
        }`}
      >
        {report.reconciliation.isReconciled ? (
          <>Reconciled to the ledger: the tax control accounts agree with this return.</>
        ) : (
          <>
            This return does not tie to the tax control accounts — output differs by{' '}
            {asMoney(report.reconciliation.outputDifference)}, input by{' '}
            {asMoney(report.reconciliation.inputDifference)}. Journal entries posted
            directly to a tax account are the usual cause. Investigate before filing.
          </>
        )}
      </div>

      <div className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Taxable sales" value={asMoney(report.totalTaxableSales)} />
        <Stat label="Output tax" value={asMoney(report.totalOutputTax)} />
        <Stat label="Taxable purchases" value={asMoney(report.totalTaxablePurchases)} />
        <Stat label="Input tax" value={asMoney(report.totalInputTax)} />
      </div>

      <div className="mb-5">
        <Stat
          label={isPayable ? 'Net tax payable' : 'Net tax reclaimable'}
          value={asMoney(
            isPayable ? report.netTaxPayable : report.netTaxPayable.replace('-', ''),
          )}
          tone={isPayable ? 'negative' : 'positive'}
        />
      </div>

      <SectionTitle>By tax rate</SectionTitle>
      <TableWrap>
        <table className="w-full text-sm">
          <thead>
            <tr>
              <th className="th-base">Tax</th>
              <th className="th-base text-right">Rate</th>
              <th className="th-base text-right">Taxable sales</th>
              <th className="th-base text-right">Output tax</th>
              <th className="th-base text-right">Taxable purchases</th>
              <th className="th-base text-right">Input tax</th>
              <th className="th-base text-right">Net</th>
            </tr>
          </thead>
          <tbody>
            {report.rows.length === 0 ? (
              <tr>
                <td className="td-base text-muted-foreground" colSpan={7}>
                  No taxed transactions in this period.
                </td>
              </tr>
            ) : (
              report.rows.map((row) => (
                <tr key={`${row.taxId ?? 'none'}-${row.ratePercent}`}>
                  <td className="td-base">
                    <span className="font-medium">{row.code}</span>{' '}
                    <span className="text-muted-foreground">{row.name}</span>
                  </td>
                  <td className="td-base num text-right">{row.ratePercent}%</td>
                  <td className="td-base num text-right">{asMoney(row.taxableSales)}</td>
                  <td className="td-base num text-right">{asMoney(row.outputTax)}</td>
                  <td className="td-base num text-right">
                    {asMoney(row.taxablePurchases)}
                  </td>
                  <td className="td-base num text-right">{asMoney(row.inputTax)}</td>
                  <td className="td-base num text-right font-medium">
                    {asMoney(row.netTax)}
                  </td>
                </tr>
              ))
            )}
          </tbody>
          <tfoot>
            <tr>
              <td className="td-base font-medium" colSpan={2}>
                Total
              </td>
              <td className="td-base num text-right font-medium">
                {asMoney(report.totalTaxableSales)}
              </td>
              <td className="td-base num text-right font-medium">
                {asMoney(report.totalOutputTax)}
              </td>
              <td className="td-base num text-right font-medium">
                {asMoney(report.totalTaxablePurchases)}
              </td>
              <td className="td-base num text-right font-medium">
                {asMoney(report.totalInputTax)}
              </td>
              <td className="td-base num text-right font-medium">
                {asMoney(report.netTaxPayable)}
              </td>
            </tr>
          </tfoot>
        </table>
      </TableWrap>

      <p className="mt-3 text-xs text-muted-foreground">
        Figures are taken from posted invoices and bills in the period, with credit and
        debit notes netted off the side they correct, then checked against the tax
        control accounts in the general ledger.
      </p>
    </>
  );
}
