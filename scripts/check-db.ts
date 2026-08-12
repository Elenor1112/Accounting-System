import { config } from 'dotenv';
import { neon } from '@neondatabase/serverless';

config({ path: '.env.local' });

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL missing from .env.local');

  const sql = neon(url);
  const rows = await sql`select version(), current_database(), now()`;
  console.log('Connected.');
  console.log(rows[0]);
}

main().catch((err) => {
  console.error('Connection failed:', err.message);
  process.exit(1);
});
