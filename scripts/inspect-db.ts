import { config } from 'dotenv';
import { neon } from '@neondatabase/serverless';

config({ path: '.env.local' });

async function main() {
  const sql = neon(process.env.DATABASE_URL!);
  const schemas = await sql`
    select table_schema, count(*)::int as c
    from information_schema.tables
    where table_schema not in ('pg_catalog', 'information_schema')
    group by 1 order by 1`;
  console.log('Schemas with tables:', JSON.stringify(schemas));

  const drizzleSchema = await sql`
    select schema_name from information_schema.schemata where schema_name = 'drizzle'`;
  console.log('drizzle meta schema exists:', drizzleSchema.length > 0);

  if (drizzleSchema.length > 0) {
    const applied = await sql`select id, hash, created_at from drizzle.__drizzle_migrations`;
    console.log('Applied migrations:', JSON.stringify(applied));
  }
}

main().catch((e) => {
  console.error('ERR', e.message);
  process.exit(1);
});
