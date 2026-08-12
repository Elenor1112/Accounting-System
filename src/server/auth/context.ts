import 'server-only';

import { and, eq } from 'drizzle-orm';

import { db } from '@/db';
import { companies, memberships, roles, users } from '@/db/schema';
import { ForbiddenError, UnauthorizedError } from '@/server/errors';

import { hasPermission, type Permission } from './permissions';

/**
 * The authenticated caller, resolved to a single company.
 *
 * Every service function takes one of these rather than a `companyId` argument.
 * That is the difference between "the query filters by company" and "the query
 * *cannot* be issued without a company the user provably belongs to" — a
 * caller can never pass a company id it did not earn through a membership row,
 * because the id is read from the database, not from the request.
 */
export interface TenantContext {
  readonly userId: string;
  readonly userName: string;
  readonly userEmail: string;
  readonly organizationId: string;
  readonly companyId: string;
  readonly companyName: string;
  readonly baseCurrencyCode: string;
  readonly currencyPrecision: number;
  readonly roleKey: string;
  readonly permissions: readonly string[];
  /** Empty means all branches; otherwise the user is limited to these. */
  readonly branchIds: readonly string[];
  readonly ipAddress?: string;
  readonly userAgent?: string;
}

/**
 * Builds the context for `userId` acting on `companyId`.
 *
 * Throws rather than returning null when the membership is missing: a request
 * for a company you do not belong to is not an empty result, it is a
 * forbidden action, and conflating the two would let a caller probe which
 * company ids exist.
 */
export async function resolveTenantContext(params: {
  userId: string;
  companyId: string;
  ipAddress?: string;
  userAgent?: string;
}): Promise<TenantContext> {
  const [row] = await db
    .select({
      userId: users.id,
      userName: users.name,
      userEmail: users.email,
      userActive: users.isActive,
      membershipActive: memberships.isActive,
      branchIds: memberships.branchIds,
      roleKey: roles.key,
      permissions: roles.permissions,
      companyId: companies.id,
      companyName: companies.name,
      companyActive: companies.isActive,
      organizationId: companies.organizationId,
      baseCurrencyCode: companies.baseCurrencyCode,
      currencyPrecision: companies.currencyPrecision,
    })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .innerJoin(roles, eq(roles.id, memberships.roleId))
    .innerJoin(companies, eq(companies.id, memberships.companyId))
    .where(
      and(eq(memberships.userId, params.userId), eq(memberships.companyId, params.companyId)),
    )
    .limit(1);

  if (!row) {
    throw new ForbiddenError('You do not have access to this company');
  }
  if (!row.userActive) throw new UnauthorizedError('This account is disabled');
  if (!row.membershipActive) throw new ForbiddenError('Your access to this company is disabled');
  if (!row.companyActive) throw new ForbiddenError('This company is inactive');

  return {
    userId: row.userId,
    userName: row.userName,
    userEmail: row.userEmail,
    organizationId: row.organizationId,
    companyId: row.companyId,
    companyName: row.companyName,
    baseCurrencyCode: row.baseCurrencyCode,
    currencyPrecision: row.currencyPrecision,
    roleKey: row.roleKey,
    permissions: row.permissions,
    branchIds: row.branchIds,
    ipAddress: params.ipAddress,
    userAgent: params.userAgent,
  };
}

/** Throws unless the caller holds `permission`. Call at the top of mutations. */
export function requirePermission(ctx: TenantContext, permission: Permission): void {
  if (!hasPermission(ctx.permissions, permission)) {
    throw new ForbiddenError(`Missing required permission: ${permission}`);
  }
}

export function can(ctx: TenantContext, permission: Permission): boolean {
  return hasPermission(ctx.permissions, permission);
}

/**
 * Throws unless the caller may act on `branchId`.
 *
 * A membership with an empty `branchIds` sees the whole company; a restricted
 * user must not create or read documents outside their branches.
 */
export function requireBranchAccess(ctx: TenantContext, branchId: string | null): void {
  if (!branchId) return;
  if (ctx.branchIds.length === 0) return;
  if (!ctx.branchIds.includes(branchId)) {
    throw new ForbiddenError('You do not have access to this branch');
  }
}

/** Companies the user can switch between; drives the company picker. */
export async function listAccessibleCompanies(userId: string) {
  return db
    .select({
      companyId: companies.id,
      companyName: companies.name,
      slug: companies.slug,
      organizationId: companies.organizationId,
      baseCurrencyCode: companies.baseCurrencyCode,
      roleKey: roles.key,
    })
    .from(memberships)
    .innerJoin(companies, eq(companies.id, memberships.companyId))
    .innerJoin(roles, eq(roles.id, memberships.roleId))
    .where(and(eq(memberships.userId, userId), eq(memberships.isActive, true)));
}
