/**
 * Backfills accounts introduced after a company was first seeded.
 *
 * Adding a role to a COA template only affects companies created afterwards.
 * An existing company keeps the chart it was seeded with, so any code path that
 * calls `resolveAccountByRole` for one of the newer roles — customer advances,
 * inventory, cost of goods sold, bad debt, drawings, the fixed-asset trio —
 * throws at runtime rather than at deploy time.
 *
 * This walks every company, works out which of the template's role-bearing
 * accounts it is missing, and inserts just those. It is idempotent: an account
 * whose code or role already exists is skipped, so running it twice is safe and
 * running it after a fresh seed does nothing.
 *
 *   npx tsx --conditions=react-server scripts/backfill-account-roles.ts
 *
 * Nothing is deleted or renumbered. Existing accounts, balances and history are
 * untouched; only genuinely absent accounts are added.
 */
import { config } from 'dotenv';

config({ path: '.env.local' });

import { and, eq, isNotNull } from 'drizzle-orm';

import { closeDb, db } from '@/db';
import { accounts, companies } from '@/db/schema';
import { getTemplate } from '@/server/services/coa-templates';

async function main() {
  const template = getTemplate('general');

  // Only the accounts that carry a role matter here: everything else is
  // presentation, and a client may legitimately have renumbered it.
  const roleAccounts = template.accounts.filter((a) => a.role);

  const allCompanies = await db
    .select({ id: companies.id, name: companies.name })
    .from(companies);

  console.log(`Checking ${allCompanies.length} company/companies…\n`);

  let totalAdded = 0;

  for (const company of allCompanies) {
    const existing = await db
      .select({
        id: accounts.id,
        code: accounts.code,
        role: accounts.role,
        path: accounts.path,
        depth: accounts.depth,
      })
      .from(accounts)
      .where(eq(accounts.companyId, company.id));

    const byCode = new Map(existing.map((a) => [a.code, a]));
    const rolesHeld = new Set(
      existing.filter((a) => a.role).map((a) => a.role as string),
    );

    /**
     * Two distinct cases:
     *
     *  - the account is absent entirely → insert it;
     *  - the account exists at the right code but carries no role, because the
     *    role was added to the template later (Equipment, Accumulated
     *    Depreciation, Depreciation Expense and Cost of Goods Sold were all
     *    shipped before they were role-tagged) → tag the existing account
     *    rather than inserting a duplicate alongside it.
     */
    const missing = roleAccounts.filter(
      (a) => !rolesHeld.has(a.role!) && !byCode.has(a.code),
    );

    const needsRoleTag = roleAccounts.filter(
      (a) => !rolesHeld.has(a.role!) && byCode.has(a.code) && !byCode.get(a.code)!.role,
    );

    for (const account of needsRoleTag) {
      const existingAccount = byCode.get(account.code)!;
      await db
        .update(accounts)
        .set({ role: account.role })
        .where(eq(accounts.id, existingAccount.id));

      rolesHeld.add(account.role!);
      totalAdded++;
      console.log(
        `  ~ ${company.name}: tagged existing ${account.code} ${account.name} ` +
          `as "${account.role}"`,
      );
    }

    if (missing.length === 0) {
      if (needsRoleTag.length === 0) console.log(`✓ ${company.name}: nothing missing`);
      continue;
    }

    for (const account of missing) {
      // Resolve the parent that is already in this company's chart so the
      // materialized path stays consistent with its siblings.
      const parent = account.parent ? byCode.get(account.parent) : undefined;

      if (account.parent && !parent) {
        console.log(
          `  ! ${company.name}: skipping ${account.code} ${account.name} — ` +
            `its parent ${account.parent} is not in this chart`,
        );
        continue;
      }

      const [created] = await db
        .insert(accounts)
        .values({
          companyId: company.id,
          code: account.code,
          name: account.name,
          description: account.description ?? null,
          type: account.type,
          subtype: account.subtype,
          parentId: parent?.id ?? null,
          path: parent ? `${parent.path}.${account.code}` : account.code,
          depth: parent ? parent.depth + 1 : 0,
          isControlAccount: account.isControlAccount ?? false,
          isPostable: account.isPostable ?? true,
          role: account.role ?? null,
        })
        .onConflictDoNothing()
        .returning({ id: accounts.id });

      if (created) {
        byCode.set(account.code, {
          id: created.id,
          code: account.code,
          role: account.role ?? null,
          path: parent ? `${parent.path}.${account.code}` : account.code,
          depth: parent ? parent.depth + 1 : 0,
        });
        totalAdded++;
        console.log(
          `  + ${company.name}: ${account.code} ${account.name} (${account.role})`,
        );
      }
    }
  }

  // Report what each company can now resolve, so the outcome is verifiable
  // rather than assumed.
  console.log('\nRoles per company after backfill:');
  for (const company of allCompanies) {
    const held = await db
      .select({ role: accounts.role })
      .from(accounts)
      .where(and(eq(accounts.companyId, company.id), isNotNull(accounts.role)));
    console.log(`  ${company.name}: ${held.length} roles`);
  }

  console.log(`\nDone. ${totalAdded} account(s) added.`);
  await closeDb();
}

main().catch(async (err) => {
  console.error('Backfill failed:', err);
  await closeDb();
  process.exit(1);
});
