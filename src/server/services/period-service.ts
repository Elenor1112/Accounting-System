import 'server-only';

import { and, asc, eq, sql } from 'drizzle-orm';

import { db, type Executor } from '@/db';
import { fiscalPeriods, journalEntries } from '@/db/schema';
import { requirePermission, type TenantContext } from '@/server/auth/context';
import { PERMISSIONS } from '@/server/auth/permissions';
import { ConflictError, NotFoundError, ValidationError } from '@/server/errors';

import { recordAudit } from './audit-service';

export type FiscalPeriodRow = typeof fiscalPeriods.$inferSelect;

/**
 * Generates the twelve monthly periods of a fiscal year.
 *
 * The year is identified by the calendar year it *starts* in, and honours the
 * company's `fiscalYearStartMonth` — a July start means FY2026 runs
 * July 2026 to June 2027.
 */
export async function generateFiscalYear(
  tx: Executor,
  params: { companyId: string; fiscalYear: number; startMonth: number },
): Promise<void> {
  const rows = [];

  for (let index = 0; index < 12; index++) {
    const monthOffset = params.startMonth - 1 + index;
    const year = params.fiscalYear + Math.floor(monthOffset / 12);
    const month = (monthOffset % 12) + 1;

    const start = new Date(Date.UTC(year, month - 1, 1));
    // Day 0 of the next month is the last day of this one — no leap-year table.
    const end = new Date(Date.UTC(year, month, 0));

    rows.push({
      companyId: params.companyId,
      fiscalYear: params.fiscalYear,
      periodNumber: index + 1,
      name: start.toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }),
      startDate: start.toISOString().slice(0, 10),
      endDate: end.toISOString().slice(0, 10),
      status: 'open' as const,
    });
  }

  await tx.insert(fiscalPeriods).values(rows).onConflictDoNothing();
}

export async function listPeriods(ctx: TenantContext, fiscalYear?: number) {
  const conditions = [eq(fiscalPeriods.companyId, ctx.companyId)];
  if (fiscalYear) conditions.push(eq(fiscalPeriods.fiscalYear, fiscalYear));

  return db
    .select()
    .from(fiscalPeriods)
    .where(and(...conditions))
    .orderBy(asc(fiscalPeriods.fiscalYear), asc(fiscalPeriods.periodNumber));
}

/**
 * Closes or locks a period.
 *
 * `closed` can be reopened by someone holding `periods.manage`; `locked` is
 * permanent and is the state auditors rely on. Draft entries dated inside the
 * period are left alone — they carry no ledger effect, and blocking them would
 * strand work in progress.
 */
export async function setPeriodStatus(
  ctx: TenantContext,
  periodId: string,
  status: 'open' | 'closed' | 'locked',
  reason?: string,
): Promise<void> {
  requirePermission(ctx, PERMISSIONS.periods.manage);

  await db.transaction(async (tx) => {
    const [period] = await tx
      .select()
      .from(fiscalPeriods)
      .where(and(eq(fiscalPeriods.id, periodId), eq(fiscalPeriods.companyId, ctx.companyId)))
      .for('update')
      .limit(1);

    if (!period) throw new NotFoundError('Fiscal period');

    if (period.status === 'locked') {
      throw new ConflictError(
        `${period.name} is locked. Locked periods cannot be reopened — post an adjusting ` +
          'entry in an open period instead.',
      );
    }
    if (status === 'open' && period.status === 'open') return;

    await tx
      .update(fiscalPeriods)
      .set({
        status,
        closedAt: status === 'open' ? null : sql`now()`,
        closedById: status === 'open' ? null : ctx.userId,
        updatedAt: sql`now()`,
      })
      .where(eq(fiscalPeriods.id, periodId));

    await recordAudit(tx, ctx, {
      action: `period.${status}`,
      entityType: 'fiscal_period',
      entityId: periodId,
      previousValues: { status: period.status },
      newValues: { status },
      reason: reason ?? null,
    });
  });
}

/** Draft entries dated in a period — what a close would leave unposted. */
export async function getPeriodReadiness(ctx: TenantContext, periodId: string) {
  const [period] = await db
    .select()
    .from(fiscalPeriods)
    .where(and(eq(fiscalPeriods.id, periodId), eq(fiscalPeriods.companyId, ctx.companyId)))
    .limit(1);

  if (!period) throw new NotFoundError('Fiscal period');

  const [drafts] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(journalEntries)
    .where(
      and(
        eq(journalEntries.companyId, ctx.companyId),
        sql`${journalEntries.entryDate} between ${period.startDate} and ${period.endDate}`,
        sql`${journalEntries.status} in ('draft', 'pending_approval', 'approved')`,
      ),
    );

  return { period, unpostedCount: drafts?.count ?? 0 };
}

export async function createFiscalYear(
  ctx: TenantContext,
  fiscalYear: number,
  startMonth = 1,
): Promise<void> {
  requirePermission(ctx, PERMISSIONS.settings.manage);

  if (startMonth < 1 || startMonth > 12) {
    throw new ValidationError('Fiscal year start month must be between 1 and 12');
  }

  await db.transaction(async (tx) => {
    await generateFiscalYear(tx, { companyId: ctx.companyId, fiscalYear, startMonth });
    await recordAudit(tx, ctx, {
      action: 'fiscal_year.created',
      entityType: 'fiscal_period',
      newValues: { fiscalYear, startMonth },
    });
  });
}
