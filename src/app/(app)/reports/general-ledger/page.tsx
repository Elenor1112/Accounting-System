import Link from 'next/link';

import { ReportControls } from '@/components/report-controls';
import { PageHeader, Select, TableWrap } from '@/components/ui';
import { AccountPicker } from '@/components/account-picker';
import * as fmt from '@/lib/format';
import { requireTenantContext } from '@/server/auth/session';
import { listAccounts } from '@/server/services/account-service';
import { getGeneralLedger } from '@/server/services/report-service';

export const metadata = { title: 'General Ledger — LedgerBase' };
export const dynamic = 'force-dynamic';

export default async function GeneralLedgerPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const params = await searchParams;
  const ctx = await requireTenantContext();

  const defaults = fmt.yearRange();
  const range = { from: params.from ?? defaults.from, to: params.to ?? defaults.to };

  const [accounts, ledger] = await Promise.all([
    listAccounts(ctx),
    getGeneralLedger(ctx, {
      accountId: params.accountId,
      from: range.from,
      to: range.to,
      limit: 500,
    }),
  ]);

  const asMoney = (value: string) =>
    fmt.money(value, { currency: ctx.baseCurrencyCode, precision: ctx.currencyPrecision });

  const selectedAccount = accounts.find((a) => a.id === params.accountId);

  return (
    <>
      <PageHeader
        title="General Ledger"
        description={
          selectedAccount
            ? `${selectedAccount.code} · ${selectedAccount.name}`
            : 'All accounts — pick one to see a running balance'
        }
      />

      <div className="mb-3">
        <AccountPicker
          accounts={accounts.map((a) => ({
            id: a.id,
            code: a.code,
            name: a.name,
            isPostable: a.isPostable,
          }))}
          selectedId={params.accountId}
          basePath="/reports/general-ledger"
          extra={{ from: range.from, to: range.to }}
        />
      </div>

      <ReportControls
        basePath="/reports/general-ledger"
        from={range.from}
        to={range.to}
        extra={{ accountId: params.accountId }}
      />

      {selectedAccount ? (
        <div className="mb-3 flex gap-6 text-sm">
          <span>
            <span className="text-muted-foreground">Opening balance: </span>
            <span className="tabular font-medium">{asMoney(ledger.openingBalance)}</span>
          </span>
          <span>
            <span className="text-muted-foreground">Closing balance: </span>
            <span className="tabular font-medium">{asMoney(ledger.closingBalance)}</span>
          </span>
        </div>
      ) : null}

      <TableWrap>
        <table className="data-table">
          <thead>
            <tr>
              <th style={{ width: '100px' }}>Date</th>
              <th style={{ width: '130px' }}>Entry</th>
              {!selectedAccount ? <th>Account</th> : null}
              <th>Description</th>
              <th className="text-right">Debit</th>
              <th className="text-right">Credit</th>
              {selectedAccount ? <th className="text-right">Balance</th> : null}
            </tr>
          </thead>
          <tbody>
            {ledger.rows.map((row) => (
              <tr key={row.lineId}>
                <td className="text-muted-foreground">{fmt.date(row.entryDate)}</td>
                <td>
                  <Link
                    href={`/journal/${row.entryId}`}
                    className="text-accent hover:underline"
                  >
                    {row.entryNumber}
                  </Link>
                </td>
                {!selectedAccount ? (
                  <td className="text-muted-foreground">
                    <span className="tabular">{row.accountCode}</span> {row.accountName}
                  </td>
                ) : null}
                <td>{row.description ?? row.entryDescription ?? '—'}</td>
                <td className="num">{Number(row.debit) > 0 ? asMoney(row.debit) : ''}</td>
                <td className="num">{Number(row.credit) > 0 ? asMoney(row.credit) : ''}</td>
                {selectedAccount ? (
                  <td className="num font-medium">{asMoney(row.balance)}</td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      </TableWrap>

      {ledger.rows.length === 0 ? (
        <p className="mt-3 text-center text-sm text-muted-foreground">
          No ledger activity in this period.
        </p>
      ) : ledger.rows.length >= 500 ? (
        <p className="mt-3 text-center text-xs text-subtle-foreground">
          Showing the first 500 lines. Narrow the date range or pick an account to see more.
        </p>
      ) : null}
    </>
  );
}
