import Link from 'next/link';

import { Card, PageHeader, SectionTitle, TableWrap } from '@/components/ui';
import * as fmt from '@/lib/format';
import { requireTenantContext } from '@/server/auth/session';
import {
  listBankAccounts,
  listReconciliations,
  listUnreconciledLedgerEntries,
  listUnreconciledStatementLines,
} from '@/server/services/banking-service';

export const metadata = { title: 'Reconciliation — LedgerBase' };
export const dynamic = 'force-dynamic';

export default async function ReconcilePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const params = await searchParams;
  const ctx = await requireTenantContext();

  const accounts = await listBankAccounts(ctx);
  const selectedId = params.accountId ?? accounts[0]?.id;

  if (!selectedId) {
    return (
      <>
        <PageHeader title="Bank Reconciliation" />
        <p className="rounded-lg border border-dashed border-border-strong px-6 py-12 text-center text-sm text-muted-foreground">
          Add a bank account first.
        </p>
      </>
    );
  }

  const [ledgerEntries, statementLines, history] = await Promise.all([
    listUnreconciledLedgerEntries(ctx, selectedId),
    listUnreconciledStatementLines(ctx, selectedId),
    listReconciliations(ctx, selectedId),
  ]);

  const precision = ctx.currencyPrecision;
  const asMoney = (value: string) =>
    fmt.money(value, { currency: ctx.baseCurrencyCode, precision });

  return (
    <>
      <PageHeader
        title="Bank Reconciliation"
        description="Match statement lines to ledger entries. Matching records agreement — it never alters either record."
      />

      <div className="mb-4 flex flex-wrap gap-1.5">
        {accounts.map((account) => (
          <Link
            key={account.id}
            href={`/banking/reconcile?accountId=${account.id}`}
            className={`rounded-md px-3 py-1.5 text-sm font-medium ${
              account.id === selectedId
                ? 'bg-accent-subtle text-accent'
                : 'text-muted-foreground hover:bg-surface-muted'
            }`}
          >
            {account.name}
          </Link>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div>
          <SectionTitle>Unmatched statement lines</SectionTitle>
          {statementLines.length === 0 ? (
            <Card>
              <p className="py-6 text-center text-sm text-muted-foreground">
                No imported statement lines awaiting a match.
              </p>
            </Card>
          ) : (
            <TableWrap>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Description</th>
                    <th className="text-right">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {statementLines.map((line) => (
                    <tr key={line.id}>
                      <td className="text-muted-foreground">
                        {fmt.date(line.transactionDate)}
                      </td>
                      <td>{line.description}</td>
                      <td
                        className={`num ${Number(line.amount) < 0 ? 'text-negative' : 'text-positive'}`}
                      >
                        {asMoney(line.amount)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          )}
        </div>

        <div>
          <SectionTitle>Unreconciled ledger entries</SectionTitle>
          {ledgerEntries.length === 0 ? (
            <Card>
              <p className="py-6 text-center text-sm text-muted-foreground">
                Every ledger entry for this account has been reconciled.
              </p>
            </Card>
          ) : (
            <TableWrap>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Entry</th>
                    <th className="text-right">Debit</th>
                    <th className="text-right">Credit</th>
                  </tr>
                </thead>
                <tbody>
                  {ledgerEntries.map((entry) => (
                    <tr key={entry.entryId}>
                      <td className="text-muted-foreground">{fmt.date(entry.entryDate)}</td>
                      <td>
                        <Link
                          href={`/journal/${entry.entryId}`}
                          className="text-accent hover:underline"
                        >
                          {entry.entryNumber}
                        </Link>
                      </td>
                      <td className="num">
                        {Number(entry.debit) > 0 ? asMoney(entry.debit) : ''}
                      </td>
                      <td className="num">
                        {Number(entry.credit) > 0 ? asMoney(entry.credit) : ''}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          )}
        </div>
      </div>

      {history.length > 0 ? (
        <div className="mt-5">
          <SectionTitle>Reconciliation history</SectionTitle>
          <TableWrap>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Statement date</th>
                  <th className="text-right">Statement balance</th>
                  <th className="text-right">Ledger balance</th>
                  <th className="text-right">Difference</th>
                  <th>Completed</th>
                </tr>
              </thead>
              <tbody>
                {history.map((row) => (
                  <tr key={row.id}>
                    <td>{fmt.date(row.statementDate)}</td>
                    <td className="num">{asMoney(row.statementBalance)}</td>
                    <td className="num">{asMoney(row.ledgerBalance)}</td>
                    <td
                      className={`num ${Number(row.difference) !== 0 ? 'text-negative' : 'text-positive'}`}
                    >
                      {asMoney(row.difference)}
                    </td>
                    <td className="text-muted-foreground">{fmt.dateTime(row.completedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        </div>
      ) : null}
    </>
  );
}
