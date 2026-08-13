import 'server-only';

import type { TenantContext } from '@/server/auth/context';

import {
  getContact,
  getContactAging,
  getContactBalance,
  getContactStatement,
  getContactTransactions,
  getCreditPosition,
} from './contact-service';

/**
 * Everything the customer/vendor detail screen needs, in one pass.
 *
 * Gathered here rather than in the page so the customer and vendor routes
 * stay identical — they are the same record viewed from two sides, and any
 * divergence between the two screens would be a bug waiting to happen.
 */
export async function loadContactDetail(
  ctx: TenantContext,
  contactId: string,
  options: { statementFrom?: string; statementTo?: string } = {},
) {
  const contact = await getContact(ctx, contactId);

  // Statement defaults to the last twelve months, which is the window a
  // customer actually queries when they ring up about their account.
  const to = options.statementTo ?? new Date().toISOString().slice(0, 10);
  const fromDate = new Date(`${to}T00:00:00Z`);
  fromDate.setUTCFullYear(fromDate.getUTCFullYear() - 1);
  const from = options.statementFrom ?? fromDate.toISOString().slice(0, 10);

  const [balance, credit, aging, statement, transactions] = await Promise.all([
    getContactBalance(ctx, contactId),
    getCreditPosition(ctx, contactId),
    getContactAging(ctx, contactId),
    getContactStatement(ctx, contactId, { from, to }),
    getContactTransactions(ctx, contactId),
  ]);

  return { contact, balance, credit, aging, statement, transactions };
}
