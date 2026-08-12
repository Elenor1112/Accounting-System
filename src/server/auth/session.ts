import 'server-only';

import { createHash, randomBytes } from 'node:crypto';

import bcrypt from 'bcryptjs';
import { and, eq, gt, sql } from 'drizzle-orm';
import { cookies } from 'next/headers';

import { db } from '@/db';
import { memberships, sessions, users } from '@/db/schema';
import { UnauthorizedError, ValidationError } from '@/server/errors';

import { resolveTenantContext, type TenantContext } from './context';

const SESSION_COOKIE = 'ledgerbase_session';
const COMPANY_COOKIE = 'ledgerbase_company';
const SESSION_DAYS = 14;

/**
 * Sessions are opaque random tokens stored as SHA-256 hashes.
 *
 * The raw token exists only in the user's cookie; a database leak therefore
 * yields no usable sessions. Hashing is SHA-256 rather than bcrypt because the
 * token is already 256 bits of entropy — there is nothing to brute-force, and
 * session lookup happens on every request.
 */
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export async function login(params: {
  email: string;
  password: string;
  ipAddress?: string;
  userAgent?: string;
}): Promise<{ userId: string; token: string; companyId: string | null }> {
  const email = params.email.trim().toLowerCase();

  const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);

  // Hash even when the user does not exist, so response time does not reveal
  // which addresses are registered.
  const passwordHash = user?.passwordHash ?? '$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinv';
  const valid = await bcrypt.compare(params.password, passwordHash);

  if (!user || !valid) {
    throw new UnauthorizedError('Incorrect email or password');
  }
  if (!user.isActive) {
    throw new UnauthorizedError('This account has been disabled');
  }

  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);

  await db.insert(sessions).values({
    userId: user.id,
    tokenHash: hashToken(token),
    expiresAt,
    ipAddress: params.ipAddress ?? null,
    userAgent: params.userAgent ?? null,
  });

  await db
    .update(users)
    .set({ lastLoginAt: sql`now()` })
    .where(eq(users.id, user.id));

  // Land the user in a company they can actually use.
  const [firstMembership] = await db
    .select({ companyId: memberships.companyId })
    .from(memberships)
    .where(and(eq(memberships.userId, user.id), eq(memberships.isActive, true)))
    .limit(1);

  return { userId: user.id, token, companyId: firstMembership?.companyId ?? null };
}

export async function createSessionCookies(token: string, companyId: string | null) {
  const store = await cookies();

  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_DAYS * 24 * 60 * 60,
  });

  if (companyId) {
    // Readable by the client so the company switcher can show the current
    // selection; it grants nothing on its own — access is re-checked server
    // side against the membership table on every request.
    store.set(COMPANY_COOKIE, companyId, {
      httpOnly: false,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: SESSION_DAYS * 24 * 60 * 60,
    });
  }
}

export async function logout(): Promise<void> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;

  if (token) {
    await db.delete(sessions).where(eq(sessions.tokenHash, hashToken(token)));
  }
  store.delete(SESSION_COOKIE);
  store.delete(COMPANY_COOKIE);
}

/** The signed-in user, or null. Does not resolve a company. */
export async function getCurrentUser(): Promise<{
  id: string;
  name: string;
  email: string;
} | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return null;

  const [row] = await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      isActive: users.isActive,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.tokenHash, hashToken(token)), gt(sessions.expiresAt, new Date())))
    .limit(1);

  if (!row || !row.isActive) return null;
  return { id: row.id, name: row.name, email: row.email };
}

/**
 * The tenant context for the current request, or null when not signed in.
 *
 * The company id arrives from a cookie the user could edit, which is exactly
 * why `resolveTenantContext` re-derives every permission from the membership
 * row rather than trusting anything in the request.
 */
export async function getTenantContext(): Promise<TenantContext | null> {
  const user = await getCurrentUser();
  if (!user) return null;

  const store = await cookies();
  let companyId = store.get(COMPANY_COOKIE)?.value;

  if (!companyId) {
    const [membership] = await db
      .select({ companyId: memberships.companyId })
      .from(memberships)
      .where(and(eq(memberships.userId, user.id), eq(memberships.isActive, true)))
      .limit(1);
    companyId = membership?.companyId;
  }

  if (!companyId) return null;

  try {
    return await resolveTenantContext({ userId: user.id, companyId });
  } catch {
    // The cookie names a company the user has lost access to; treat it as
    // signed-out-of-that-company rather than an error page.
    return null;
  }
}

/** For server actions and route handlers that must have a context. */
export async function requireTenantContext(): Promise<TenantContext> {
  const ctx = await getTenantContext();
  if (!ctx) throw new UnauthorizedError('Please sign in to continue');
  return ctx;
}

export async function switchCompany(companyId: string): Promise<void> {
  const user = await getCurrentUser();
  if (!user) throw new UnauthorizedError();

  // Verified before the cookie is set: switching is an authorization decision.
  await resolveTenantContext({ userId: user.id, companyId });

  const store = await cookies();
  store.set(COMPANY_COOKIE, companyId, {
    httpOnly: false,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_DAYS * 24 * 60 * 60,
  });
}

export async function changePassword(
  userId: string,
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  if (newPassword.length < 8) {
    throw new ValidationError('New password must be at least 8 characters');
  }

  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user) throw new UnauthorizedError();

  if (!(await bcrypt.compare(currentPassword, user.passwordHash))) {
    throw new UnauthorizedError('Current password is incorrect');
  }

  await db.transaction(async (tx) => {
    await tx
      .update(users)
      .set({ passwordHash: await bcrypt.hash(newPassword, 12), updatedAt: sql`now()` })
      .where(eq(users.id, userId));

    // Every other session is invalidated: a password change should log out
    // whoever might have been using the old one.
    await tx.delete(sessions).where(eq(sessions.userId, userId));
  });
}

/** Removes expired sessions. Safe to call from a cron route. */
export async function pruneExpiredSessions(): Promise<number> {
  const deleted = await db
    .delete(sessions)
    .where(sql`${sessions.expiresAt} < now()`)
    .returning({ id: sessions.id });
  return deleted.length;
}
