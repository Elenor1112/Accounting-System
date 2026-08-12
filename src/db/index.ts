import 'server-only';

import { neonConfig, Pool } from '@neondatabase/serverless';
import { drizzle, type NeonDatabase } from 'drizzle-orm/neon-serverless';
import ws from 'ws';

import * as schema from './schema';

/**
 * The accounting engine posts journal entries inside interactive transactions:
 * header, lines and the balance assertion must commit together or not at all.
 * Neon's HTTP driver cannot hold a transaction open across statements, so this
 * app uses the WebSocket-backed Pool driver throughout. Node needs a `ws`
 * implementation supplied; browsers and edge runtimes have one natively.
 */
if (typeof WebSocket === 'undefined') {
  neonConfig.webSocketConstructor = ws;
}

export type Database = NeonDatabase<typeof schema>;
/** What a service receives inside `withTransaction` — same query API. */
export type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
/** Accept either in a service signature so callers can compose transactions. */
export type Executor = Database | Tx;

let pool: Pool | null = null;
let instance: Database | null = null;

function createDb(): Database {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      'DATABASE_URL is not set. Copy .env.example to .env.local and add your Neon connection string.',
    );
  }
  pool = new Pool({ connectionString: url });
  return drizzle(pool, { schema, casing: 'snake_case' });
}

/**
 * Lazy proxy so importing this module never opens a connection. `next build`
 * evaluates modules for routes that may never run a query, and a missing
 * DATABASE_URL should surface at query time with a clear message rather than
 * crashing the build.
 */
export const db: Database = new Proxy({} as Database, {
  get(_target, prop) {
    instance ??= createDb();
    return Reflect.get(instance, prop);
  },
});

/** For scripts and tests that need the process to exit cleanly. */
export async function closeDb(): Promise<void> {
  await pool?.end();
  pool = null;
  instance = null;
}

export { schema };
