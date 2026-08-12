import { DataTable, type Column } from '@/components/data-table';
import { Badge, PageHeader, Stat } from '@/components/ui';
import * as fmt from '@/lib/format';
import { requireTenantContext } from '@/server/auth/session';
import { listBankAccounts } from '@/server/services/banking-service';

export const metadata = { title: 'Banking — LedgerBase' };
export const dynamic = 'force-dynamic';

type Row = Awaited<ReturnType<typeof listBankAccounts>>[number];

export default async function BankingPage() {
  const ctx = await requireTenantContext();
  const accounts = await listBankAccounts(ctx);

  const precision = ctx.currencyPrecision;
  const total = accounts.reduce((acc, account) => acc + Number(account.balance), 0);

  const columns: Column<Row>[] = [
    {
      key: 'name',
      header: 'Account',
      render: (row) => (
        <div>
          <p className="font-medium text-foreground">{row.name}</p>
          {row.bankName ? (
            <p className="text-xs text-muted-foreground">
              {row.bankName}
              {row.accountNumber ? ` · ${row.accountNumber}` : ''}
            </p>
          ) : null}
        </div>
      ),
    },
    {
      key: 'kind',
      header: 'Type',
      render: (row) => <Badge tone="neutral">{fmt.humanise(row.accountKind)}</Badge>,
    },
    {
      key: 'ledger',
      header: 'Ledger account',
      render: (row) => (
        <span className="tabular text-muted-foreground">{row.ledgerAccountCode}</span>
      ),
    },
    {
      key: 'currency',
      header: 'Currency',
      render: (row) => <span className="text-muted-foreground">{row.currencyCode}</span>,
    },
    {
      key: 'balance',
      header: 'Balance',
      align: 'right',
      render: (row) => (
        <span className="font-medium">
          {fmt.money(row.balance, { currency: row.currencyCode, precision })}
        </span>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title="Bank & Cash Accounts"
        description="Balances are summed from the ledger, never stored"
      />

      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        <Stat
          label="Total cash"
          value={fmt.money(String(total), {
            currency: ctx.baseCurrencyCode,
            precision,
          })}
          hint={`Across ${accounts.length} account${accounts.length === 1 ? '' : 's'}`}
        />
      </div>

      <DataTable
        rows={accounts}
        columns={columns}
        getRowKey={(row) => row.id}
        empty={{
          title: 'No bank accounts',
          description:
            'Add a bank or cash account and map it to a ledger account to start recording payments.',
        }}
      />
    </>
  );
}
