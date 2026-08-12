/**
 * Drops and recreates the `public` and `drizzle` schemas.
 *
 * Development only: this destroys all data. It exists because a failed
 * migration can leave the database half-built, and re-running migrations
 * against a partial schema fails in confusing ways. Refuses to run unless
 * ALLOW_DB_RESET=1 is set, so it cannot be triggered by reflex.
 */
import { config } from 'dotenv';
import { neon } from '@neondatabase/serverless';

config({ path: '.env.local' });

async function main() {
  if (process.env.ALLOW_DB_RESET !== '1') {
    console.error(
      'Refusing to reset. Re-run with ALLOW_DB_RESET=1 if you intend to destroy all data.',
    );
    process.exit(1);
  }

  const sql = neon(process.env.DATABASE_URL!);

  const [{ count }] = await sql`
    select count(*)::int as count from information_schema.tables
    where table_schema = 'public'`;
  console.log(`Dropping public schema (${count} tables) and drizzle metadata …`);

  await sql`drop schema if exists public cascade`;
  await sql`drop schema if exists drizzle cascade`;
  await sql`create schema public`;
  console.log('Reset complete. Run scripts/migrate.ts next.');
}

main().catch((e) => {
  console.error('Reset failed:', e.message);
  process.exit(1);
});
