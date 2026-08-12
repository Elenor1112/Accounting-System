import 'server-only';

import type { Executor } from '@/db';
import { auditLogs } from '@/db/schema';
import type { TenantContext } from '@/server/auth/context';

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
