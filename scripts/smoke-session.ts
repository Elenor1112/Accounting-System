/**
 * Mints a session for the seeded owner and prints the cookie header.
 *
 * The smoke test uses this instead of driving the login form, because a
 * Next.js server action requires an action id that only the rendered client
 * bundle knows. Authentication itself is covered by the service-level tests;
 * what the smoke test needs to prove is that every *page* renders real data.
 */
import { config } from 'dotenv';

config({ path: '.env.local' });

import { createHash, randomBytes } from 'node:crypto';

import { eq } from 'drizzle-orm';

import { closeDb, db } from '@/db';
import { memberships, sessions, users } from '@/db/schema';

async function main() {
  const email = process.argv[2] ?? 'owner@demo.test';

  const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  if (!user) throw new Error(`No user ${email}. Run: npm run db:seed`);

  const [membership] = await db
    .select()
    .from(memberships)
    .where(eq(memberships.userId, user.id))
    .limit(1);
  if (!membership) throw new Error(`${email} has no company membership`);

  const token = randomBytes(32).toString('base64url');
  await db.insert(sessions).values({
    userId: user.id,
    tokenHash: createHash('sha256').update(token).digest('hex'),
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });

  console.log(`ledgerbase_session=${token}; ledgerbase_company=${membership.companyId}`);
}

main()
  .then(() => closeDb())
  .catch(async (err) => {
    console.error(err.message);
    await closeDb();
    process.exit(1);
  });
