/**
 * Integration-test harness.
 *
 * Tests run against the real Neon database rather than a mock, because the
 * invariants under test (balanced entries, tenant-scoped foreign keys, period
 * locks, `FOR UPDATE` serialisation) live in Postgres. A mock would prove the
 * mock behaves, not the ledger.
 *
 * Each test builds its own organization with a unique slug and tears it down
 * afterwards, so runs are isolated and can safely execute against a shared
 * development database.
 */
import { config } from 'dotenv';

config({ path: '.env.local' });

import { randomUUID } from 'node:crypto';

import { eq, inArray } from 'drizzle-orm';

import { db } from '@/db';
import {
  accounts,
  auditLogs,
  bankAccounts,
  budgets,
  companies,
  contacts,
  currencies,
  customFieldDefinitions,
  customFieldValues,
  documents,
  expenseCategories,
  expenses,
  fiscalPeriods,
  journalEntries,
  journalLines,
  memberships,
  numberSequences,
  organizations,
  paymentAllocations,
  payments,
  roles,
  taxes,
  users,
} from '@/db/schema';
import type { TenantContext } from '@/server/auth/context';
import { ALL_PERMISSIONS } from '@/server/auth/permissions';
import { applyCoaTemplate } from '@/server/services/account-service';

export interface TestCompany {
  ctx: TenantContext;
  organizationId: string;
  companyId: string;
  userId: string;
  /** Account code → id, from the installed template. */
  accountIds: Map<string, string>;
  accountId: (code: string) => string;
}

/**
 * Creates an isolated organization + company with a full chart of accounts and
 * an owner user holding every permission.
 */
export async function createTestCompany(
  options: { template?: string; baseCurrency?: string; permissions?: string[] } = {},
): Promise<TestCompany> {
  const unique = randomUUID().slice(0, 8);

  return db.transaction(async (tx) => {
    const [org] = await tx
      .insert(organizations)
      .values({ name: `Test Org ${unique}`, slug: `test-org-${unique}` })
      .returning();

    const [company] = await tx
      .insert(companies)
      .values({
        organizationId: org!.id,
        name: `Test Co ${unique}`,
        slug: `test-co-${unique}`,
        baseCurrencyCode: options.baseCurrency ?? 'USD',
      })
      .returning();

    const [user] = await tx
      .insert(users)
      .values({
        email: `test-${unique}@example.test`,
        name: 'Test Owner',
        passwordHash: 'not-a-real-hash',
      })
      .returning();

    const [role] = await tx
      .insert(roles)
      .values({
        organizationId: org!.id,
        key: 'owner',
        name: 'Owner',
        permissions: options.permissions ?? ALL_PERMISSIONS,
      })
      .returning();

    await tx.insert(memberships).values({
      userId: user!.id,
      companyId: company!.id,
      roleId: role!.id,
    });

    const accountIds = await applyCoaTemplate(
      tx,
      company!.id,
      options.template ?? 'general',
    );

    const ctx: TenantContext = {
      userId: user!.id,
      userName: user!.name,
      userEmail: user!.email,
      organizationId: org!.id,
      companyId: company!.id,
      companyName: company!.name,
      baseCurrencyCode: company!.baseCurrencyCode,
      currencyPrecision: company!.currencyPrecision,
      roleKey: role!.key,
      permissions: options.permissions ?? ALL_PERMISSIONS,
      branchIds: [],
    };

    return {
      ctx,
      organizationId: org!.id,
      companyId: company!.id,
      userId: user!.id,
      accountIds,
      accountId: (code: string) => {
        const id = accountIds.get(code);
        if (!id) throw new Error(`Test setup: no account with code ${code}`);
        return id;
      },
    };
  });
}

/**
 * Removes a test company and everything under it, child-first: the schema's
 * foreign keys are RESTRICT by design so financial parents never cascade away.
 */
export async function destroyTestCompany(company: TestCompany): Promise<void> {
  const { companyId, organizationId, userId } = company;

  await db.transaction(async (tx) => {
    await tx.delete(paymentAllocations).where(eq(paymentAllocations.companyId, companyId));
    await tx.delete(payments).where(eq(payments.companyId, companyId));
    await tx.delete(expenses).where(eq(expenses.companyId, companyId));
    await tx.delete(documents).where(eq(documents.companyId, companyId));
    await tx.delete(journalLines).where(eq(journalLines.companyId, companyId));
    await tx.delete(journalEntries).where(eq(journalEntries.companyId, companyId));
    await tx.delete(bankAccounts).where(eq(bankAccounts.companyId, companyId));
    await tx.delete(expenseCategories).where(eq(expenseCategories.companyId, companyId));
    await tx.delete(budgets).where(eq(budgets.companyId, companyId));
    await tx.delete(customFieldValues).where(eq(customFieldValues.companyId, companyId));
    await tx
      .delete(customFieldDefinitions)
      .where(eq(customFieldDefinitions.companyId, companyId));
    await tx.delete(taxes).where(eq(taxes.companyId, companyId));
    await tx.delete(contacts).where(eq(contacts.companyId, companyId));
    await tx.delete(fiscalPeriods).where(eq(fiscalPeriods.companyId, companyId));
    await tx.delete(accounts).where(eq(accounts.companyId, companyId));
    await tx.delete(numberSequences).where(eq(numberSequences.companyId, companyId));
    await tx.delete(currencies).where(eq(currencies.companyId, companyId));
    await tx.delete(auditLogs).where(eq(auditLogs.companyId, companyId));
    await tx.delete(memberships).where(eq(memberships.companyId, companyId));
    await tx.delete(companies).where(eq(companies.id, companyId));
    await tx.delete(roles).where(eq(roles.organizationId, organizationId));
    await tx.delete(organizations).where(eq(organizations.id, organizationId));
    await tx.delete(users).where(inArray(users.id, [userId]));
  });
}

/** Sums the posted debits and credits of an entry, straight from the database. */
export async function entryTotals(entryId: string) {
  const lines = await db.select().from(journalLines).where(eq(journalLines.entryId, entryId));
  return {
    lines,
    debit: lines.reduce((acc, l) => acc + Number(l.baseDebit), 0),
    credit: lines.reduce((acc, l) => acc + Number(l.baseCredit), 0),
  };
}
