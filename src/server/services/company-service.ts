import 'server-only';

import { and, eq, sql } from 'drizzle-orm';
import bcrypt from 'bcryptjs';

import { db } from '@/db';
import {
  branches,
  companies,
  currencies,
  memberships,
  organizations,
  roles,
  users,
} from '@/db/schema';
import { requirePermission, type TenantContext } from '@/server/auth/context';
import { ALL_PERMISSIONS, SYSTEM_ROLE_TEMPLATES, PERMISSIONS } from '@/server/auth/permissions';
import { ConflictError, NotFoundError, ValidationError } from '@/server/errors';

import { recordAudit, diffValues } from './audit-service';
import { applyCoaTemplate } from './account-service';
import { currencyPrecision } from './currency-service';
import { generateFiscalYear } from './period-service';

export type CompanyRow = typeof companies.$inferSelect;

/**
 * Provisions a complete, usable tenant in one transaction (spec §43: "A
 * company can be created… a chart of accounts can be configured… users/roles
 * can be configured").
 *
 * Everything a company needs to accept its first invoice is created here:
 * organization, company, roles, owner membership, chart of accounts, fiscal
 * calendar and base currency. Partial provisioning would leave a tenant that
 * looks set up but cannot post, so it all commits together or not at all.
 */
export async function provisionCompany(input: {
  organizationName: string;
  companyName: string;
  legalName?: string;
  baseCurrencyCode?: string;
  countryCode?: string;
  timezone?: string;
  fiscalYearStartMonth?: number;
  coaTemplate?: string;
  owner: { name: string; email: string; password: string };
  branches?: Array<{ code: string; name: string }>;
}): Promise<{
  organizationId: string;
  companyId: string;
  userId: string;
  accountsCreated: number;
}> {
  const email = input.owner.email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw new ValidationError('A valid owner email address is required');
  }
  if (input.owner.password.length < 8) {
    throw new ValidationError('Owner password must be at least 8 characters');
  }

  const baseCurrency = (input.baseCurrencyCode ?? 'USD').toUpperCase();
  const startMonth = input.fiscalYearStartMonth ?? 1;
  const slugify = (value: string) =>
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 48);

  return db.transaction(async (tx) => {
    const [organization] = await tx
      .insert(organizations)
      .values({
        name: input.organizationName,
        slug: `${slugify(input.organizationName)}-${Date.now().toString(36)}`,
      })
      .returning();

    if (!organization) throw new ConflictError('Failed to create organization');

    const [company] = await tx
      .insert(companies)
      .values({
        organizationId: organization.id,
        name: input.companyName,
        legalName: input.legalName ?? null,
        slug: slugify(input.companyName),
        baseCurrencyCode: baseCurrency,
        countryCode: input.countryCode ?? null,
        timezone: input.timezone ?? 'UTC',
        fiscalYearStartMonth: startMonth,
        currencyPrecision: currencyPrecision(baseCurrency),
      })
      .returning();

    if (!company) throw new ConflictError('Failed to create company');

    // Seed the role templates so the client has something to edit rather than
    // a blank permissions screen.
    const roleRows = await tx
      .insert(roles)
      .values(
        SYSTEM_ROLE_TEMPLATES.map((template) => ({
          organizationId: organization.id,
          key: template.key,
          name: template.name,
          description: template.description,
          permissions: [...template.permissions],
          isSystem: true,
        })),
      )
      .returning();

    const ownerRole = roleRows.find((r) => r.key === 'owner');
    if (!ownerRole) throw new ConflictError('Failed to create owner role');

    // An existing user (an accountant serving several clients) gains a
    // membership rather than a duplicate account.
    const [existingUser] = await tx.select().from(users).where(eq(users.email, email)).limit(1);

    let userId: string;
    if (existingUser) {
      userId = existingUser.id;
    } else {
      const [created] = await tx
        .insert(users)
        .values({
          email,
          name: input.owner.name,
          passwordHash: await bcrypt.hash(input.owner.password, 12),
        })
        .returning();
      if (!created) throw new ConflictError('Failed to create owner user');
      userId = created.id;
    }

    await tx.insert(memberships).values({
      userId,
      companyId: company.id,
      roleId: ownerRole.id,
    });

    if (input.branches?.length) {
      await tx.insert(branches).values(
        input.branches.map((branch) => ({
          companyId: company.id,
          code: branch.code,
          name: branch.name,
        })),
      );
    }

    await tx.insert(currencies).values({
      companyId: company.id,
      code: baseCurrency,
      name: baseCurrency,
      decimalPlaces: currencyPrecision(baseCurrency),
    });

    const accountIds = await applyCoaTemplate(
      tx,
      company.id,
      input.coaTemplate ?? 'general',
    );

    const currentYear = new Date().getUTCFullYear();
    await generateFiscalYear(tx, {
      companyId: company.id,
      fiscalYear: currentYear,
      startMonth,
    });

    return {
      organizationId: organization.id,
      companyId: company.id,
      userId,
      accountsCreated: accountIds.size,
    };
  });
}

export async function getCompany(ctx: TenantContext): Promise<CompanyRow> {
  const [company] = await db
    .select()
    .from(companies)
    .where(eq(companies.id, ctx.companyId))
    .limit(1);

  if (!company) throw new NotFoundError('Company');
  return company;
}

/**
 * Updates company settings.
 *
 * `baseCurrencyCode` is deliberately absent: changing it would silently
 * reinterpret every historical base amount in the ledger. Migrating currency
 * is a controlled data operation, not a settings toggle.
 */
export async function updateCompany(
  ctx: TenantContext,
  updates: Partial<
    Pick<
      CompanyRow,
      | 'name'
      | 'legalName'
      | 'logoUrl'
      | 'email'
      | 'phone'
      | 'addressLine1'
      | 'addressLine2'
      | 'city'
      | 'state'
      | 'postalCode'
      | 'countryCode'
      | 'taxIdentifier'
      | 'timezone'
      | 'dateFormat'
      | 'settings'
    >
  >,
): Promise<CompanyRow> {
  requirePermission(ctx, PERMISSIONS.settings.manage);

  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(companies)
      .where(eq(companies.id, ctx.companyId))
      .limit(1);

    if (!existing) throw new NotFoundError('Company');

    const diff = diffValues(existing as Record<string, unknown>, updates);

    const [updated] = await tx
      .update(companies)
      .set({ ...updates, updatedAt: sql`now()` })
      .where(eq(companies.id, ctx.companyId))
      .returning();

    if (!updated) throw new ConflictError('Failed to update company');

    if (diff) {
      await recordAudit(tx, ctx, {
        action: 'company.updated',
        entityType: 'company',
        entityId: ctx.companyId,
        ...diff,
      });
    }
    return updated;
  });
}

export async function listBranches(ctx: TenantContext) {
  return db
    .select()
    .from(branches)
    .where(and(eq(branches.companyId, ctx.companyId), eq(branches.isActive, true)));
}

export async function createBranch(
  ctx: TenantContext,
  input: { code: string; name: string },
) {
  requirePermission(ctx, PERMISSIONS.settings.manage);

  const [created] = await db
    .insert(branches)
    .values({ companyId: ctx.companyId, code: input.code, name: input.name })
    .returning();

  if (!created) throw new ConflictError(`Branch code ${input.code} is already in use`);
  return created;
}

export async function listRoles(ctx: TenantContext) {
  requirePermission(ctx, PERMISSIONS.settings.manage);

  return db.select().from(roles).where(eq(roles.organizationId, ctx.organizationId));
}

export async function createRole(
  ctx: TenantContext,
  input: { key: string; name: string; description?: string; permissions: string[] },
) {
  requirePermission(ctx, PERMISSIONS.settings.manage);

  const unknown = input.permissions.filter(
    (p) => p !== '*' && !ALL_PERMISSIONS.includes(p as never),
  );
  if (unknown.length > 0) {
    throw new ValidationError(`Unknown permissions: ${unknown.join(', ')}`);
  }

  const [created] = await db
    .insert(roles)
    .values({
      organizationId: ctx.organizationId,
      key: input.key,
      name: input.name,
      description: input.description ?? null,
      permissions: input.permissions,
    })
    .returning();

  if (!created) throw new ConflictError(`Role key ${input.key} already exists`);
  return created;
}

export async function updateRolePermissions(
  ctx: TenantContext,
  roleId: string,
  permissions: string[],
): Promise<void> {
  requirePermission(ctx, PERMISSIONS.settings.manage);

  await db.transaction(async (tx) => {
    const [role] = await tx
      .select()
      .from(roles)
      .where(and(eq(roles.id, roleId), eq(roles.organizationId, ctx.organizationId)))
      .limit(1);

    if (!role) throw new NotFoundError('Role');
    if (role.key === 'owner') {
      throw new ConflictError(
        'The Owner role cannot be restricted — it is the recovery path if other roles are misconfigured.',
      );
    }

    await tx
      .update(roles)
      .set({ permissions, updatedAt: sql`now()` })
      .where(eq(roles.id, roleId));

    await recordAudit(tx, ctx, {
      action: 'role.permissions_updated',
      entityType: 'role',
      entityId: roleId,
      previousValues: { permissions: role.permissions },
      newValues: { permissions },
    });
  });
}

/** Adds a user to the company, creating the account if they are new. */
export async function inviteUser(
  ctx: TenantContext,
  input: {
    email: string;
    name: string;
    password: string;
    roleId: string;
    branchIds?: string[];
  },
) {
  requirePermission(ctx, PERMISSIONS.settings.manage);

  const email = input.email.trim().toLowerCase();

  return db.transaction(async (tx) => {
    const [existing] = await tx.select().from(users).where(eq(users.email, email)).limit(1);

    let userId: string;
    if (existing) {
      userId = existing.id;
    } else {
      if (input.password.length < 8) {
        throw new ValidationError('Password must be at least 8 characters');
      }
      const [created] = await tx
        .insert(users)
        .values({
          email,
          name: input.name,
          passwordHash: await bcrypt.hash(input.password, 12),
        })
        .returning();
      if (!created) throw new ConflictError('Failed to create user');
      userId = created.id;
    }

    const [membership] = await tx
      .insert(memberships)
      .values({
        userId,
        companyId: ctx.companyId,
        roleId: input.roleId,
        branchIds: input.branchIds ?? [],
      })
      .onConflictDoNothing()
      .returning();

    if (!membership) {
      throw new ConflictError('This user already has access to the company');
    }

    await recordAudit(tx, ctx, {
      action: 'user.invited',
      entityType: 'user',
      entityId: userId,
      newValues: { email, roleId: input.roleId },
    });

    return { userId, membershipId: membership.id };
  });
}

export async function listCompanyUsers(ctx: TenantContext) {
  requirePermission(ctx, PERMISSIONS.settings.manage);

  return db
    .select({
      userId: users.id,
      name: users.name,
      email: users.email,
      isActive: users.isActive,
      lastLoginAt: users.lastLoginAt,
      membershipId: memberships.id,
      roleId: roles.id,
      roleName: roles.name,
      branchIds: memberships.branchIds,
    })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .innerJoin(roles, eq(roles.id, memberships.roleId))
    .where(and(eq(memberships.companyId, ctx.companyId), eq(memberships.isActive, true)));
}
