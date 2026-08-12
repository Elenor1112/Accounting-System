/**
 * Applies pending migrations.
 *
 * Used instead of `drizzle-kit migrate` because that command drives a
 * WebSocket connection it does not always drain before the process exits,
 * which can leave the migration table written but the DDL unapplied. Running
 * the migrator directly against a pool we close ourselves makes completion
 * observable and the exit code trustworthy.
 */
import { config } from 'dotenv';
import { Pool, neonConfig } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-serverless';
import { migrate } from 'drizzle-orm/neon-serverless/migrator';
import ws from 'ws';

config({ path: '.env.local' });
neonConfig.webSocketConstructor = ws;

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL missing from .env.local');

  const pool = new Pool({ connectionString: url });
  const db = drizzle(pool);

  console.log('Applying migrations from ./drizzle …');
  await migrate(db, { migrationsFolder: './drizzle' });
  console.log('Migrations applied.');

  await pool.end();
}

main().catch((err) => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
