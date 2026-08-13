import 'server-only';

import { and, desc, eq, sql } from 'drizzle-orm';

import { db, type Executor } from '@/db';
import { auditLogs, users } from '@/db/schema';
import { requirePermission, type TenantContext } from '@/server/auth/context';
import { PERMISSIONS } from '@/server/auth/permissions';

/**
 * Writes an audit record (spec §23).
 *
 * Always called with the transaction handle of the change it describes, so the
 * action and its audit trail commit together. If the posting rolls back, the
 * log entry rolls back with it — there is no state where the ledger and the
 * audit trail disagree about what happened.
 */
export async function recordAudit(
  tx: Executor,
  ctx: TenantContext,
  params: {
    action: string;
    entityType: string;
    entityId?: string | null;
    previousValues?: unknown;
    newValues?: unknown;
    reason?: string | null;
  },
): Promise<void> {
  await tx.insert(auditLogs).values({
    companyId: ctx.companyId,
    actorId: ctx.userId,
    action: params.action,
    entityType: params.entityType,
    entityId: params.entityId ?? null,
    previousValues: params.previousValues ?? null,
    newValues: params.newValues ?? null,
    reason: params.reason ?? null,
    ipAddress: ctx.ipAddress ?? null,
    userAgent: ctx.userAgent ?? null,
  });
}

/**
 * Queries the audit log with filters (spec §23, audit finding: no filtering by
 * actor, date or entity).
 *
 * An audit trail nobody can search is not usable as evidence: the specific
 * question an auditor asks is "show me everything this user did in June", and
 * before this there was no way to answer it without reading every page.
 */
export async function listAuditLogs(
  ctx: TenantContext,
  filters: {
    actorId?: string;
    entityType?: string;
    entityId?: string;
    action?: string;
    from?: string;
    to?: string;
    search?: string;
    limit?: number;
    offset?: number;
  } = {},
) {
  requirePermission(ctx, PERMISSIONS.audit.view);

  const conditions = [eq(auditLogs.companyId, ctx.companyId)];

  if (filters.actorId) conditions.push(eq(auditLogs.actorId, filters.actorId));
  if (filters.entityType) conditions.push(eq(auditLogs.entityType, filters.entityType));
  if (filters.entityId) conditions.push(eq(auditLogs.entityId, filters.entityId));
  // Prefix match, so "document" finds document.created, document.posted, etc.
  if (filters.action) {
    conditions.push(sql`${auditLogs.action} like ${`${filters.action}%`}`);
  }
  if (filters.from) conditions.push(sql`${auditLogs.createdAt} >= ${filters.from}::date`);
  // Inclusive of the whole end day, not just midnight on it.
  if (filters.to) {
    conditions.push(sql`${auditLogs.createdAt} < (${filters.to}::date + 1)`);
  }
  if (filters.search) {
    const term = `%${filters.search.toLowerCase()}%`;
    conditions.push(
      sql`(lower(${auditLogs.action}) like ${term}
        or lower(${auditLogs.entityType}) like ${term}
        or lower(coalesce(${auditLogs.reason}, '')) like ${term})`,
    );
  }

  return db
    .select({
      id: auditLogs.id,
      action: auditLogs.action,
      entityType: auditLogs.entityType,
      entityId: auditLogs.entityId,
      previousValues: auditLogs.previousValues,
      newValues: auditLogs.newValues,
      reason: auditLogs.reason,
      ipAddress: auditLogs.ipAddress,
      userAgent: auditLogs.userAgent,
      createdAt: auditLogs.createdAt,
      actorId: auditLogs.actorId,
      actorName: users.name,
      actorEmail: users.email,
    })
    .from(auditLogs)
    .leftJoin(users, eq(users.id, auditLogs.actorId))
    .where(and(...conditions))
    .orderBy(desc(auditLogs.createdAt))
    .limit(filters.limit ?? 50)
    .offset(filters.offset ?? 0);
}

/** Distinct actors and entity types present in the log, for filter dropdowns. */
export async function getAuditFilterOptions(ctx: TenantContext) {
  requirePermission(ctx, PERMISSIONS.audit.view);

  const [actors, entityTypes] = await Promise.all([
    db
      .selectDistinct({ id: users.id, name: users.name })
      .from(auditLogs)
      .innerJoin(users, eq(users.id, auditLogs.actorId))
      .where(eq(auditLogs.companyId, ctx.companyId)),
    db
      .selectDistinct({ entityType: auditLogs.entityType })
      .from(auditLogs)
      .where(eq(auditLogs.companyId, ctx.companyId)),
  ]);

  return {
    actors: actors.sort((a, b) => a.name.localeCompare(b.name)),
    entityTypes: entityTypes.map((r) => r.entityType).sort(),
  };
}

/**
 * Returns only the fields that changed, so an audit row records a diff rather
 * than two full copies of the entity. Keeps the log readable and small.
 */
export function diffValues<T extends Record<string, unknown>>(
  before: T,
  after: Partial<T>,
): { previousValues: Partial<T>; newValues: Partial<T> } | null {
  const previousValues: Partial<T> = {};
  const newValues: Partial<T> = {};
  let changed = false;

  for (const key of Object.keys(after) as (keyof T)[]) {
    const from = before[key];
    const to = after[key];
    if (String(from ?? '') !== String(to ?? '')) {
      previousValues[key] = from;
      newValues[key] = to as T[keyof T];
      changed = true;
    }
  }

  return changed ? { previousValues, newValues } : null;
}
