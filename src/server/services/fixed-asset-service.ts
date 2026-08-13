import 'server-only';

import { and, asc, desc, eq, sql } from 'drizzle-orm';

import { db, type Tx } from '@/db';
import { depreciationEntries, fixedAssets } from '@/db/schema';
import { requirePermission, type TenantContext } from '@/server/auth/context';
import { PERMISSIONS } from '@/server/auth/permissions';
import { AccountingError, ConflictError, NotFoundError, ValidationError } from '@/server/errors';
import {
  add,
  divide,
  gt,
  gte,
  isZero,
  min,
  money,
  multiply,
  round,
  subtract,
  type Money,
} from '@/lib/money';

import { recordAudit } from './audit-service';
import { resolveAccountByRole } from './account-service';
import { createJournalEntry } from './journal-service';
import { allocateDocumentNumber } from './numbering-service';

export type FixedAssetRow = typeof fixedAssets.$inferSelect;

/**
 * Fixed assets and depreciation (spec §16).
 *
 * Straight-line:
 *
 *     monthlyCharge = (cost − residualValue) / usefulLifeMonths
 *
 * and each run posts:
 *
 *     Dr Depreciation Expense
 *       Cr Accumulated Depreciation
 *
 * The charge is capped so accumulated depreciation can never exceed the
 * depreciable amount — the final month absorbs any rounding remainder, so an
 * asset lands exactly on its residual value rather than a few cents either
 * side of it.
 */

/** Last day of the month containing `date`. */
export function monthEnd(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0))
    .toISOString()
    .slice(0, 10);
}

export async function createAsset(
  ctx: TenantContext,
  input: {
    name: string;
    description?: string | null;
    category?: string | null;
    acquisitionDate: string;
    cost: Money;
    residualValue?: Money;
    usefulLifeMonths: number;
    assetAccountId?: string | null;
    accumulatedAccountId?: string | null;
    expenseAccountId?: string | null;
    branchId?: string | null;
    assetNumber?: string;
  },
): Promise<FixedAssetRow> {
  requirePermission(ctx, PERMISSIONS.fixedAssets.manage);

  if (!input.name?.trim()) throw new ValidationError('An asset needs a name');
  if (!gt(input.cost, '0')) {
    throw new ValidationError('Asset cost must be greater than zero');
  }
  if (input.usefulLifeMonths <= 0) {
    throw new ValidationError('Useful life must be at least one month');
  }
  if (gt(money(input.residualValue ?? '0'), money(input.cost))) {
    throw new ValidationError('Residual value cannot exceed the asset cost');
  }

  return db.transaction(async (tx) => {
    const assetNumber =
      input.assetNumber ??
      (await allocateDocumentNumber(tx, {
        companyId: ctx.companyId,
        documentType: 'fixed_asset',
        date: new Date(input.acquisitionDate),
      }));

    const [created] = await tx
      .insert(fixedAssets)
      .values({
        companyId: ctx.companyId,
        assetNumber,
        name: input.name.trim(),
        description: input.description ?? null,
        category: input.category ?? null,
        acquisitionDate: input.acquisitionDate,
        cost: money(input.cost),
        residualValue: money(input.residualValue ?? '0'),
        usefulLifeMonths: input.usefulLifeMonths,
        assetAccountId: input.assetAccountId ?? null,
        accumulatedAccountId: input.accumulatedAccountId ?? null,
        expenseAccountId: input.expenseAccountId ?? null,
        branchId: input.branchId ?? null,
        createdById: ctx.userId,
      })
      .returning();

    if (!created) throw new ConflictError('Failed to create the asset');

    /**
     * Note the acquisition itself is *not* posted here.
     *
     * An asset normally arrives through a bill, which already debited the
     * fixed-asset account on its own line; posting again would double the
     * asset. The register records what the ledger already holds.
     */
    await recordAudit(tx, ctx, {
      action: 'fixed_asset.created',
      entityType: 'fixed_asset',
      entityId: created.id,
      newValues: {
        assetNumber,
        name: created.name,
        cost: created.cost,
        usefulLifeMonths: created.usefulLifeMonths,
      },
    });

    return created;
  });
}

/** The straight-line charge for one month, before capping. */
function monthlyCharge(asset: FixedAssetRow): Money {
  const depreciable = subtract(asset.cost, asset.residualValue);
  return round(divide(depreciable, String(asset.usefulLifeMonths)), 6);
}

/**
 * The full schedule for an asset: what will be charged, month by month.
 *
 * Computed rather than stored, so changing a useful life re-derives the
 * remaining schedule instead of leaving stale rows behind.
 */
export async function getDepreciationSchedule(
  ctx: TenantContext,
  assetId: string,
): Promise<
  Array<{
    periodEnd: string;
    charge: Money;
    accumulated: Money;
    netBookValue: Money;
    isPosted: boolean;
  }>
> {
  requirePermission(ctx, PERMISSIONS.fixedAssets.view);

  const [asset] = await db
    .select()
    .from(fixedAssets)
    .where(and(eq(fixedAssets.id, assetId), eq(fixedAssets.companyId, ctx.companyId)))
    .limit(1);

  if (!asset) throw new NotFoundError('Fixed asset');

  const posted = await db
    .select({ periodEnd: depreciationEntries.periodEnd })
    .from(depreciationEntries)
    .where(eq(depreciationEntries.assetId, assetId));
  const postedPeriods = new Set(posted.map((p) => p.periodEnd));

  const depreciable = subtract(asset.cost, asset.residualValue);
  const charge = monthlyCharge(asset);

  const rows = [];
  let accumulated: Money = '0';
  const cursor = new Date(`${asset.acquisitionDate}T00:00:00Z`);

  for (let i = 0; i < asset.usefulLifeMonths; i++) {
    const periodEnd = new Date(
      Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + i + 1, 0),
    )
      .toISOString()
      .slice(0, 10);

    // The last month absorbs the rounding remainder, so the asset finishes
    // exactly at its residual value.
    const remaining = subtract(depreciable, accumulated);
    const thisCharge = min(charge, remaining);
    if (isZero(thisCharge)) break;

    accumulated = add(accumulated, thisCharge);
    rows.push({
      periodEnd,
      charge: round(thisCharge, 2),
      accumulated: round(accumulated, 2),
      netBookValue: round(subtract(asset.cost, accumulated), 2),
      isPosted: postedPeriods.has(periodEnd),
    });
  }

  return rows;
}

/**
 * Posts depreciation for every active asset for the period ending `periodEnd`.
 *
 * Idempotent per asset per period: the unique index on
 * `(assetId, periodEnd)` means a second run for the same month adds nothing,
 * so an accidental re-run cannot double the charge. Assets acquired after the
 * period, and assets already fully depreciated, are skipped.
 */
export async function runDepreciation(
  ctx: TenantContext,
  params: { periodEnd: string; assetId?: string },
): Promise<{
  periodEnd: string;
  assetsCharged: number;
  totalCharge: Money;
  journalEntryId: string | null;
  skipped: number;
}> {
  requirePermission(ctx, PERMISSIONS.fixedAssets.depreciate);
  requirePermission(ctx, PERMISSIONS.transactions.post);

  const periodEnd = monthEnd(params.periodEnd);

  return db.transaction(async (tx) => {
    const conditions = [
      eq(fixedAssets.companyId, ctx.companyId),
      eq(fixedAssets.status, 'active'),
      // Nothing is charged before the asset exists.
      sql`${fixedAssets.acquisitionDate} <= ${periodEnd}::date`,
    ];
    if (params.assetId) conditions.push(eq(fixedAssets.id, params.assetId));

    const assets = await tx
      .select()
      .from(fixedAssets)
      .where(and(...conditions))
      .for('update')
      .orderBy(asc(fixedAssets.assetNumber));

    const charges: Array<{ asset: FixedAssetRow; charge: Money }> = [];
    let skipped = 0;

    for (const asset of assets) {
      const [existing] = await tx
        .select({ id: depreciationEntries.id })
        .from(depreciationEntries)
        .where(
          and(
            eq(depreciationEntries.assetId, asset.id),
            eq(depreciationEntries.periodEnd, periodEnd),
          ),
        )
        .limit(1);

      // Already charged for this month — a re-run must not double it.
      if (existing) {
        skipped++;
        continue;
      }

      const depreciable = subtract(asset.cost, asset.residualValue);
      const remaining = subtract(depreciable, asset.accumulatedDepreciation);

      // Fully depreciated: it sits at residual value until disposal.
      if (!gt(remaining, '0')) {
        skipped++;
        continue;
      }

      const charge = min(monthlyCharge(asset), remaining);
      if (isZero(charge)) {
        skipped++;
        continue;
      }

      charges.push({ asset, charge: round(charge, ctx.currencyPrecision) });
    }

    if (charges.length === 0) {
      return {
        periodEnd,
        assetsCharged: 0,
        totalCharge: '0' as Money,
        journalEntryId: null,
        skipped,
      };
    }

    /**
     * One journal entry for the whole run, with a line pair per asset.
     *
     * A single entry per month is what an accountant expects to see in the
     * ledger — twenty separate entries for twenty laptops is noise — while the
     * per-asset `depreciation_entries` rows keep the detail.
     */
    const expenseAccount = await resolveAccountByRole(
      tx,
      ctx.companyId,
      'depreciation_expense',
    );
    const accumulatedAccount = await resolveAccountByRole(
      tx,
      ctx.companyId,
      'accumulated_depreciation',
    );

    const lines: Array<Record<string, unknown>> = [];
    let totalCharge: Money = '0';

    for (const { asset, charge } of charges) {
      lines.push({
        accountId: asset.expenseAccountId ?? expenseAccount.id,
        debit: charge,
        description: `Depreciation ${asset.assetNumber} ${asset.name}`,
        branchId: asset.branchId,
      });
      lines.push({
        accountId: asset.accumulatedAccountId ?? accumulatedAccount.id,
        credit: charge,
        description: `Depreciation ${asset.assetNumber} ${asset.name}`,
        branchId: asset.branchId,
      });
      totalCharge = add(totalCharge, charge);
    }

    const entry = await createJournalEntry(
      ctx,
      {
        entryDate: periodEnd,
        description: `Depreciation for the period ending ${periodEnd}`,
        reference: `DEP-${periodEnd}`,
        sourceType: 'depreciation',
        lines: lines as never,
        post: true,
      },
      { tx },
    );

    for (const { asset, charge } of charges) {
      const accumulatedAfter = add(asset.accumulatedDepreciation, charge);

      await tx.insert(depreciationEntries).values({
        companyId: ctx.companyId,
        assetId: asset.id,
        periodEnd,
        amount: charge,
        accumulatedAfter,
        netBookValueAfter: subtract(asset.cost, accumulatedAfter),
        journalEntryId: entry.id,
        createdById: ctx.userId,
      });

      await tx
        .update(fixedAssets)
        .set({
          accumulatedDepreciation: accumulatedAfter,
          depreciatedTo: periodEnd,
          updatedAt: sql`now()`,
        })
        .where(eq(fixedAssets.id, asset.id));
    }

    await recordAudit(tx, ctx, {
      action: 'fixed_asset.depreciation_run',
      entityType: 'fixed_asset',
      entityId: entry.id,
      newValues: {
        periodEnd,
        assetsCharged: charges.length,
        totalCharge,
        journalEntryId: entry.id,
      },
    });

    return {
      periodEnd,
      assetsCharged: charges.length,
      totalCharge,
      journalEntryId: entry.id,
      skipped,
    };
  });
}

/**
 * Disposes of an asset, derecognising cost and accumulated depreciation and
 * posting the gain or loss.
 *
 *     Dr Bank / Receivable          proceeds
 *     Dr Accumulated Depreciation   everything charged to date
 *       Cr Fixed Asset                   original cost
 *       Cr/Dr Gain or Loss on disposal   the difference
 *
 * The gain or loss is the balancing figure, which is exactly what it is
 * economically: what the asset actually fetched against what the books said it
 * was still worth.
 */
export async function disposeAsset(
  ctx: TenantContext,
  assetId: string,
  params: {
    disposalDate: string;
    proceeds: Money;
    /** Where the proceeds landed. Omit for a scrapped asset. */
    proceedsAccountId?: string | null;
    reason: string;
  },
): Promise<{ journalEntryId: string; gainOrLoss: Money; isGain: boolean }> {
  requirePermission(ctx, PERMISSIONS.fixedAssets.manage);
  requirePermission(ctx, PERMISSIONS.transactions.post);

  if (!params.reason?.trim()) {
    throw new ValidationError('A disposal needs a reason');
  }

  return db.transaction(async (tx) => {
    const [asset] = await tx
      .select()
      .from(fixedAssets)
      .where(and(eq(fixedAssets.id, assetId), eq(fixedAssets.companyId, ctx.companyId)))
      .for('update')
      .limit(1);

    if (!asset) throw new NotFoundError('Fixed asset');
    if (asset.status !== 'active') {
      throw new ConflictError(`This asset has already been ${asset.status}.`);
    }

    const proceeds = money(params.proceeds ?? '0');
    if (proceeds.startsWith('-')) {
      throw new ValidationError('Disposal proceeds cannot be negative');
    }
    // ISO dates compare correctly as strings; `gt` is money arithmetic and
    // would try to parse "2026-03-01" as a decimal.
    if (params.disposalDate < asset.acquisitionDate) {
      throw new AccountingError(
        `A disposal cannot be dated before the asset was acquired (${asset.acquisitionDate}).`,
      );
    }

    const netBookValue = subtract(asset.cost, asset.accumulatedDepreciation);
    const gainOrLoss = subtract(proceeds, netBookValue);
    const isGain = !gainOrLoss.startsWith('-');
    const magnitude = isGain ? gainOrLoss : gainOrLoss.slice(1);

    const assetAccount =
      asset.assetAccountId ??
      (await resolveAccountByRole(tx, ctx.companyId, 'fixed_assets')).id;
    const accumulatedAccount =
      asset.accumulatedAccountId ??
      (await resolveAccountByRole(tx, ctx.companyId, 'accumulated_depreciation')).id;
    // Reuses the FX gain/loss role's sibling: disposals are other income or
    // expense, and the template's Other Income account carries that role.
    const gainLossAccount = await resolveAccountByRole(tx, ctx.companyId, 'fx_gain_loss');

    const lines: Array<Record<string, unknown>> = [];

    if (gt(proceeds, '0')) {
      const proceedsAccountId =
        params.proceedsAccountId ??
        (await resolveAccountByRole(tx, ctx.companyId, 'default_bank')).id;
      lines.push({
        accountId: proceedsAccountId,
        debit: proceeds,
        description: `Proceeds on disposal of ${asset.assetNumber}`,
        branchId: asset.branchId,
      });
    }

    if (gt(asset.accumulatedDepreciation, '0')) {
      lines.push({
        accountId: accumulatedAccount,
        debit: asset.accumulatedDepreciation,
        description: `Remove accumulated depreciation, ${asset.assetNumber}`,
        branchId: asset.branchId,
      });
    }

    lines.push({
      accountId: assetAccount,
      credit: asset.cost,
      description: `Derecognise ${asset.assetNumber} ${asset.name}`,
      branchId: asset.branchId,
    });

    if (!isZero(magnitude)) {
      lines.push({
        accountId: gainLossAccount.id,
        // A gain is income (credit); a loss is an expense (debit).
        [isGain ? 'credit' : 'debit']: magnitude,
        description: `${isGain ? 'Gain' : 'Loss'} on disposal of ${asset.assetNumber}`,
        branchId: asset.branchId,
      });
    }

    const entry = await createJournalEntry(
      ctx,
      {
        entryDate: params.disposalDate,
        description: `Disposal of ${asset.assetNumber} ${asset.name}: ${params.reason}`,
        reference: asset.assetNumber,
        sourceType: 'asset_disposal',
        sourceId: asset.id,
        branchId: asset.branchId,
        lines: lines as never,
        post: true,
      },
      { tx },
    );

    await tx
      .update(fixedAssets)
      .set({
        status: 'disposed',
        disposalDate: params.disposalDate,
        disposalProceeds: proceeds,
        updatedAt: sql`now()`,
      })
      .where(eq(fixedAssets.id, assetId));

    await recordAudit(tx, ctx, {
      action: 'fixed_asset.disposed',
      entityType: 'fixed_asset',
      entityId: assetId,
      previousValues: { status: 'active', netBookValue },
      newValues: {
        status: 'disposed',
        proceeds,
        gainOrLoss,
        journalEntryId: entry.id,
      },
      reason: params.reason,
    });

    return { journalEntryId: entry.id, gainOrLoss, isGain };
  });
}

export async function listAssets(
  ctx: TenantContext,
  filters: {
    status?: 'active' | 'disposed' | 'written_off';
    category?: string;
    search?: string;
    limit?: number;
    offset?: number;
  } = {},
) {
  requirePermission(ctx, PERMISSIONS.fixedAssets.view);

  const conditions = [eq(fixedAssets.companyId, ctx.companyId)];
  if (filters.status) conditions.push(eq(fixedAssets.status, filters.status));
  if (filters.category) conditions.push(eq(fixedAssets.category, filters.category));
  if (filters.search) {
    const term = `%${filters.search.toLowerCase()}%`;
    conditions.push(
      sql`(lower(${fixedAssets.name}) like ${term}
        or lower(${fixedAssets.assetNumber}) like ${term})`,
    );
  }

  const rows = await db
    .select()
    .from(fixedAssets)
    .where(and(...conditions))
    .orderBy(asc(fixedAssets.assetNumber))
    .limit(filters.limit ?? 50)
    .offset(filters.offset ?? 0);

  return rows.map((row) => ({
    ...row,
    netBookValue: round(
      subtract(row.cost, row.accumulatedDepreciation),
      ctx.currencyPrecision,
    ),
  }));
}

export async function getAsset(ctx: TenantContext, assetId: string) {
  requirePermission(ctx, PERMISSIONS.fixedAssets.view);

  const [asset] = await db
    .select()
    .from(fixedAssets)
    .where(and(eq(fixedAssets.id, assetId), eq(fixedAssets.companyId, ctx.companyId)))
    .limit(1);

  if (!asset) throw new NotFoundError('Fixed asset');

  const charges = await db
    .select()
    .from(depreciationEntries)
    .where(eq(depreciationEntries.assetId, assetId))
    .orderBy(desc(depreciationEntries.periodEnd));

  return {
    asset,
    charges,
    netBookValue: round(
      subtract(asset.cost, asset.accumulatedDepreciation),
      ctx.currencyPrecision,
    ),
  };
}

/**
 * The asset register report: cost, accumulated depreciation and net book value
 * by asset, which is the note every set of statutory accounts carries.
 */
export async function getAssetRegister(ctx: TenantContext) {
  requirePermission(ctx, PERMISSIONS.fixedAssets.view);

  const rows = await listAssets(ctx, { limit: 1000 });
  const active = rows.filter((r) => r.status === 'active');

  const totalCost = active.reduce<Money>((acc, r) => add(acc, r.cost), '0');
  const totalAccumulated = active.reduce<Money>(
    (acc, r) => add(acc, r.accumulatedDepreciation),
    '0',
  );

  return {
    assets: rows,
    totalCost: round(totalCost, ctx.currencyPrecision),
    totalAccumulatedDepreciation: round(totalAccumulated, ctx.currencyPrecision),
    totalNetBookValue: round(subtract(totalCost, totalAccumulated), ctx.currencyPrecision),
  };
}
