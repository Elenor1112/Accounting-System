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

import { eq, inArray, sql } from 'drizzle-orm';

import { db } from '@/db';
import {
  accounts,
  approvals,
  auditLogs,
  bankAccounts,
  budgets,
  companies,
  contacts,
  currencies,
  depreciationEntries,
  customFieldDefinitions,
  customFieldValues,
  documents,
  expenseCategories,
  expenses,
  fiscalPeriods,
  fixedAssets,
  journalEntries,
  journalLines,
  memberships,
  numberSequences,
  organizations,
  paymentAllocations,
  payments,
  products,
  roles,
  stockMovements,
  taxes,
  users,
  workflowSteps,
  workflows,
} from '@/db/schema';
import type { TenantContext } from '@/server/auth/context';
import { ALL_PERMISSIONS } from '@/server/auth/permissions';
import { applyCoaTemplate } from '@/server/services/account-service';
import { generateFiscalYear } from '@/server/services/period-service';

export interface TestCompany {
  ctx: TenantContext;
  organizationId: string;
  companyId: string;
  userId: string;
  /** Account code → id, from the installed template. */
  accountIds: Map<string, string>;
  accountId: (code: string) => string;
  /**
   * A second user in the same company, for maker-checker scenarios: approval
   * and segregation-of-duties cannot be tested with a single identity.
   */
  approver: TenantContext;
  approverUserId: string;
  /** Same company, arbitrary permissions and role key — for negative tests. */
  userWith: (permissions: string[], roleKey?: string) => TenantContext;
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

    // A second identity so approval can be exercised by someone other than the
    // person who raised the document.
    const [approverUser] = await tx
      .insert(users)
      .values({
        email: `approver-${unique}@example.test`,
        name: 'Test Approver',
        passwordHash: 'not-a-real-hash',
      })
      .returning();

    const [approverRole] = await tx
      .insert(roles)
      .values({
        organizationId: org!.id,
        key: 'financial_controller',
        name: 'Financial Controller',
        permissions: options.permissions ?? ALL_PERMISSIONS,
      })
      .returning();

    await tx.insert(memberships).values({
      userId: approverUser!.id,
      companyId: company!.id,
      roleId: approverRole!.id,
    });

    const accountIds = await applyCoaTemplate(
      tx,
      company!.id,
      options.template ?? 'general',
    );

    /**
     * A fiscal calendar, as any real company has.
     *
     * Posting now fails closed when no period covers the date, so a test
     * company without a calendar could not post at all. Generating the
     * surrounding years keeps tests free to use dates on either side of today
     * while still exercising the period control rather than opting out of it —
     * the tests that need a *closed* period close one explicitly.
     */
    const thisYear = new Date().getUTCFullYear();
    for (const year of [thisYear - 1, thisYear, thisYear + 1]) {
      await generateFiscalYear(tx, {
        companyId: company!.id,
        fiscalYear: year,
        startMonth: company!.fiscalYearStartMonth,
      });
    }

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
      approverUserId: approverUser!.id,
      approver: {
        ...ctx,
        userId: approverUser!.id,
        userName: approverUser!.name,
        userEmail: approverUser!.email,
        roleKey: approverRole!.key,
      },
      userWith: (permissions: string[], roleKey = 'custom') => ({
        ...ctx,
        userId: approverUser!.id,
        userName: approverUser!.name,
        userEmail: approverUser!.email,
        roleKey,
        permissions,
      }),
    };
  });
}

/**
 * Removes a test company and everything under it, child-first: the schema's
 * foreign keys are RESTRICT by design so financial parents never cascade away.
 */
export async function destroyTestCompany(company: TestCompany): Promise<void> {
  const { companyId, organizationId, userId, approverUserId } = company;

  await db.transaction(async (tx) => {
    await tx.delete(approvals).where(eq(approvals.companyId, companyId));
    await tx.delete(workflowSteps).where(eq(workflowSteps.companyId, companyId));
    await tx.delete(workflows).where(eq(workflows.companyId, companyId));
    await tx
      .delete(depreciationEntries)
      .where(eq(depreciationEntries.companyId, companyId));
    await tx.delete(fixedAssets).where(eq(fixedAssets.companyId, companyId));
    await tx.delete(stockMovements).where(eq(stockMovements.companyId, companyId));
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
    await tx.delete(products).where(eq(products.companyId, companyId));
    await tx.delete(accounts).where(eq(accounts.companyId, companyId));
    await tx.delete(numberSequences).where(eq(numberSequences.companyId, companyId));
    await tx.delete(currencies).where(eq(currencies.companyId, companyId));
    /**
     * The audit log is append-only in the database, so teardown must lift the
     * trigger to remove a test company's rows and put it straight back.
     *
     * This is confined to the test harness on purpose: the fact that deleting
     * audit rows requires deliberately disabling a database trigger is exactly
     * the property the control is meant to have. Production code has no such
     * path, and `controls.test.ts` asserts that UPDATE and DELETE are refused.
     */
    await tx.execute(sql`ALTER TABLE audit_logs DISABLE TRIGGER audit_logs_no_delete`);
    await tx.delete(auditLogs).where(eq(auditLogs.companyId, companyId));
    await tx.execute(sql`ALTER TABLE audit_logs ENABLE TRIGGER audit_logs_no_delete`);
    await tx.delete(memberships).where(eq(memberships.companyId, companyId));
    await tx.delete(companies).where(eq(companies.id, companyId));
    await tx.delete(roles).where(eq(roles.organizationId, organizationId));
    await tx.delete(organizations).where(eq(organizations.id, organizationId));
    await tx.delete(users).where(inArray(users.id, [userId, approverUserId]));
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
