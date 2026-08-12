/**
 * Proves the ledger's database-level invariants are real: each case below tries
 * to write data that violates double-entry rules and must be rejected by
 * Postgres, not merely by application code.
 */
import { config } from 'dotenv';
import { neon } from '@neondatabase/serverless';

import { firstId, firstRow } from './_helpers';

config({ path: '.env.local' });

const sql = neon(process.env.DATABASE_URL!);

async function mustFail(label: string, fn: () => Promise<unknown>) {
  try {
    await fn();
    console.log(`FAIL  ${label} — was accepted but should have been rejected`);
    return false;
  } catch (err) {
    const msg = (err as Error).message.split('\n')[0];
    console.log(`ok    ${label}\n        rejected: ${msg}`);
    return true;
  }
}

async function main() {
  const tables = firstRow<{ count: number }>(
    await sql`
      select count(*)::int as count from information_schema.tables
      where table_schema = 'public'`,
    'table count',
  ).count;
  console.log(`Tables in public schema: ${tables}\n`);

  const checks = await sql`
    select conname from pg_constraint
    where contype = 'c' and conname like '%_ck'
    order by conname`;
  console.log('Check constraints present:');
  for (const c of checks) console.log(`  - ${c.conname}`);
  console.log('');

  // Scaffolding: a company + account to hang test rows on.
  const org = firstId(
    await sql`
      insert into organizations (name, slug) values ('Constraint Probe', ${'probe-' + Date.now()})
      returning id`,
    'insert organization',
  );
  const co = firstId(
    await sql`
      insert into companies (organization_id, name, slug, base_currency_code)
      values (${org}, 'Probe Co', 'probe', 'USD') returning id`,
    'insert company',
  );
  const acct = firstId(
    await sql`
      insert into accounts (company_id, code, name, type, subtype, path)
      values (${co}, '1000', 'Cash', 'asset', 'cash', '1000') returning id`,
    'insert account',
  );
  const entry = firstId(
    await sql`
      insert into journal_entries (company_id, entry_number, entry_date, currency_code, status)
      values (${co}, 'JE-PROBE-1', '2026-01-15', 'USD', 'draft') returning id`,
    'insert journal entry',
  );

  let passed = 0;
  const total = 4;

  passed += (await mustFail('line with BOTH debit and credit', () =>
    sql`insert into journal_lines
        (company_id, entry_id, account_id, line_number, debit, credit, currency_code, base_debit, base_credit)
        values (${co}, ${entry}, ${acct}, 1, 50, 50, 'USD', 50, 50)`,
  ))
    ? 1
    : 0;

  passed += (await mustFail('line with NEITHER debit nor credit', () =>
    sql`insert into journal_lines
        (company_id, entry_id, account_id, line_number, debit, credit, currency_code, base_debit, base_credit)
        values (${co}, ${entry}, ${acct}, 2, 0, 0, 'USD', 0, 0)`,
  ))
    ? 1
    : 0;

  passed += (await mustFail('line with NEGATIVE debit', () =>
    sql`insert into journal_lines
        (company_id, entry_id, account_id, line_number, debit, credit, currency_code, base_debit, base_credit)
        values (${co}, ${entry}, ${acct}, 3, -10, 0, 'USD', -10, 0)`,
  ))
    ? 1
    : 0;

  passed += (await mustFail('POSTED entry where debits <> credits', () =>
    sql`insert into journal_entries
        (company_id, entry_number, entry_date, currency_code, status, total_debit, total_credit)
        values (${co}, 'JE-PROBE-2', '2026-01-15', 'USD', 'posted', 100, 90)`,
  ))
    ? 1
    : 0;

  // Cross-tenant probe: an account from another company must not be attachable.
  const org2 = firstId(
    await sql`
      insert into organizations (name, slug) values ('Other Org', ${'other-' + Date.now()})
      returning id`,
    'insert second organization',
  );
  const co2 = firstId(
    await sql`
      insert into companies (organization_id, name, slug) values (${org2}, 'Other Co', 'other')
      returning id`,
    'insert second company',
  );
  const acct2 = firstId(
    await sql`
      insert into accounts (company_id, code, name, type, subtype, path)
      values (${co2}, '1000', 'Their Cash', 'asset', 'cash', '1000') returning id`,
    'insert second account',
  );

  const crossOk = await mustFail(
    "TENANT LEAK: line referencing another company's account",
    () =>
      sql`insert into journal_lines
          (company_id, entry_id, account_id, line_number, debit, credit, currency_code, base_debit, base_credit)
          values (${co}, ${entry}, ${acct2}, 4, 25, 0, 'USD', 25, 0)`,
  );

  // Clean up in dependency order. The FKs between these tables are RESTRICT
  // on purpose — financial parents must never cascade away beneath their
  // children — so the probe data has to be removed child-first.
  await sql`delete from journal_lines where company_id in (${co}, ${co2})`;
  await sql`delete from journal_entries where company_id in (${co}, ${co2})`;
  await sql`delete from accounts where company_id in (${co}, ${co2})`;
  await sql`delete from companies where id in (${co}, ${co2})`;
  await sql`delete from organizations where id in (${org}, ${org2})`;

  const score = passed + (crossOk ? 1 : 0);
  console.log(`\n${score}/${total + 1} invariants enforced by the database.`);
  if (score !== total + 1) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
