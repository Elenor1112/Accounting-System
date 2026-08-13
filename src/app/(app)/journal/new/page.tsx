import { JournalEntryForm } from '@/components/journal-entry-form';
import { PageHeader } from '@/components/ui';
import { can } from '@/server/auth/context';
import { PERMISSIONS } from '@/server/auth/permissions';
import { requireTenantContext } from '@/server/auth/session';
import { listAccounts } from '@/server/services/account-service';
import { listCurrencies } from '@/server/services/currency-service';

export const metadata = { title: 'New journal entry — LedgerBase' };
export const dynamic = 'force-dynamic';

export default async function NewJournalEntryPage() {
  const ctx = await requireTenantContext();

  const [accounts, currencies] = await Promise.all([
    listAccounts(ctx),
    listCurrencies(ctx),
  ]);

  return (
    <>
      <PageHeader
        title="New journal entry"
        description="Accruals, prepayments, depreciation and corrections — save a draft, or post straight to the ledger"
      />
      <JournalEntryForm
        accounts={accounts.map((account) => ({
          id: account.id,
          code: account.code,
          name: account.name,
          type: account.type,
          isPostable: account.isPostable,
          isControlAccount: account.isControlAccount,
          isArchived: account.isArchived,
        }))}
        currencies={currencies.map((currency) => ({
          code: currency.code,
          name: currency.name,
        }))}
        baseCurrencyCode={ctx.baseCurrencyCode}
        currencyPrecision={ctx.currencyPrecision}
        // Hiding the button is a courtesy; `createJournalEntry` re-checks the
        // permission server-side regardless of what the client sends.
        canPost={can(ctx, PERMISSIONS.transactions.post)}
      />
    </>
  );
}
