import { config } from 'dotenv';
import { defineConfig } from 'drizzle-kit';

// drizzle-kit runs outside Next, so load .env.local explicitly (Next-style).
config({ path: '.env.local' });

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema/index.ts',
  out: './drizzle',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? '',
  },
  strict: true,
  verbose: true,
});
