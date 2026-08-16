import { neon } from '@neondatabase/serverless';
import fs from 'fs';
const url = fs.readFileSync('.env.local','utf8').match(/DATABASE_URL="([^"]+)"/)[1];
const sql = neon(url);
console.log('CUSTOMERS:', JSON.stringify(await sql`
  select id, display_name, kind, currency_code, payment_terms_days from contacts where kind in ('customer','both') and is_active=true limit 5`,null,2));
console.log('REVENUE:', JSON.stringify(await sql`
  select id, code, name, is_postable from accounts where type='revenue' and is_postable=true and is_archived=false limit 5`,null,2));
console.log('TAXES:', JSON.stringify(await sql`select id, code, name, rate_percent, is_inclusive from taxes where is_active=true limit 5`,null,2));
console.log('ROLES:', JSON.stringify(await sql`select id, key, name from roles`,null,2));
