import 'server-only';

import { and, asc, eq } from 'drizzle-orm';

import { db } from '@/db';
import { taxes } from '@/db/schema';
import type { TenantContext } from '@/server/auth/context';

import { listAccounts } from './account-service';
import { listContacts } from './contact-service';
import { listCurrencies } from './currency-service';

/**
 * Accounts a document line may be coded to.
 *
 * Sales land in revenue, purchases in expenses — but cost accounts on an
 * invoice (a rebilled expense) and revenue on a bill (a vendor credit) are
 * both legitimate, so both types are offered with the likely one first.
 */
const LINE_ACCOUNT_TYPES = ['revenue', 'expense'] as const;

export interface DocumentFormOptions {
  contacts: Array<{
    id: string;
    code: string;
    displayName: string;
    currencyCode: string | null;
    paymentTermsDays: number;
  }>;
  accounts: Array<{ id: string; code: string; name: string }>;
  taxes: Array<{
    id: string;
    code: string;
    name: string;
    ratePercent: string;
    isInclusive: boolean;
  }>;
  currencies: Array<{ code: string; name: string }>;
  /** Pre-selected on new lines so the common case needs no picking. */
  defaultAccountId: string;
}

/**
 * Everything the new-document form needs to render, in one pass.
 *
 * Each underlying list already checks the caller's permission, so a user
 * without contact or account visibility gets an empty picker rather than a
 * leak.
 */
export async function loadDocumentFormOptions(
  ctx: TenantContext,
  direction: 'outbound' | 'inbound',
): Promise<DocumentFormOptions> {
  const isSale = direction === 'outbound';

  const [contactRows, accountRows, currencyRows, taxRows] = await Promise.all([
    listContacts(ctx, { kind: isSale ? 'customer' : 'vendor', limit: 500 }),
    listAccounts(ctx),
    listCurrencies(ctx),
    db
      .select()
      .from(taxes)
      .where(and(eq(taxes.companyId, ctx.companyId), eq(taxes.isActive, true)))
      .orderBy(asc(taxes.code)),
  ]);

  const preferredType = isSale ? 'revenue' : 'expense';
  const postable = accountRows.filter(
    (account) =>
      account.isPostable &&
      LINE_ACCOUNT_TYPES.includes(account.type as (typeof LINE_ACCOUNT_TYPES)[number]),
  );

  // Preferred type first, each group still in code order.
  const ordered = [
    ...postable.filter((a) => a.type === preferredType),
    ...postable.filter((a) => a.type !== preferredType),
  ];

  return {
    contacts: contactRows.map((contact) => ({
      id: contact.id,
      code: contact.code,
      displayName: contact.displayName,
      currencyCode: contact.currencyCode,
      paymentTermsDays: contact.paymentTermsDays,
    })),
    accounts: ordered.map((account) => ({
      id: account.id,
      code: account.code,
      name: account.name,
    })),
    taxes: taxRows.map((tax) => ({
      id: tax.id,
      code: tax.code,
      name: tax.name,
      ratePercent: tax.ratePercent,
      isInclusive: tax.isInclusive,
    })),
    currencies: currencyRows.map((currency) => ({
      code: currency.code,
      name: currency.name,
    })),
    defaultAccountId: ordered[0]?.id ?? '',
  };
}
