import 'server-only';

import { and, desc, eq, lte } from 'drizzle-orm';

import { db, type Executor } from '@/db';
import { currencies, exchangeRates } from '@/db/schema';
import { requirePermission, type TenantContext } from '@/server/auth/context';
import { PERMISSIONS } from '@/server/auth/permissions';
import { AccountingError } from '@/server/errors';
import { divideRate, isZero, lte as lteMoney } from '@/lib/money';

/** Minor-unit counts for currencies that are not the usual 2 decimals. */
const NON_STANDARD_PRECISION: Record<string, number> = {
  JPY: 0,
  KRW: 0,
  VND: 0,
  CLP: 0,
  ISK: 0,
  BHD: 3,
  KWD: 3,
  OMR: 3,
  TND: 3,
  JOD: 3,
};

export function currencyPrecision(code: string): number {
  return NON_STANDARD_PRECISION[code.toUpperCase()] ?? 2;
}

/**
 * Resolves the rate to convert `from` into `to` on `date`.
 *
 * Uses the most recent rate effective *on or before* the date, so a document
 * dated last March converts at March's rate rather than today's. Returns '1'
 * for same-currency conversion.
 */
export async function resolveExchangeRate(
  tx: Executor,
  params: { companyId: string; from: string; to: string; date: string },
): Promise<string> {
  const { companyId, from, to, date } = params;
  if (from === to) return '1';

  const [direct] = await tx
    .select()
    .from(exchangeRates)
    .where(
      and(
        eq(exchangeRates.companyId, companyId),
        eq(exchangeRates.fromCurrency, from),
        eq(exchangeRates.toCurrency, to),
        lte(exchangeRates.effectiveDate, date),
      ),
    )
    .orderBy(desc(exchangeRates.effectiveDate))
    .limit(1);

  if (direct) return direct.rate;

  // Fall back to the inverse pair: storing USD→EGP should be enough to
  // convert EGP→USD without duplicating every rate in both directions.
  const [inverse] = await tx
    .select()
    .from(exchangeRates)
    .where(
      and(
        eq(exchangeRates.companyId, companyId),
        eq(exchangeRates.fromCurrency, to),
        eq(exchangeRates.toCurrency, from),
        lte(exchangeRates.effectiveDate, date),
      ),
    )
    .orderBy(desc(exchangeRates.effectiveDate))
    .limit(1);

  // Exact reciprocal at rate scale. `1 / Number(rate)` produced a 17-digit
  // float string that the numeric(20,10) column then truncated, so every
  // inverse-rate conversion was computed from a rate that was not the true
  // reciprocal and could not be reconciled to any published figure.
  if (inverse && !isZero(inverse.rate)) {
    return divideRate('1', inverse.rate);
  }

  throw new AccountingError(
    `No exchange rate found for ${from} → ${to} on or before ${date}. ` +
      'Add one in Settings → Currencies before posting this document.',
  );
}

export async function listCurrencies(ctx: TenantContext) {
  return db
    .select()
    .from(currencies)
    .where(and(eq(currencies.companyId, ctx.companyId), eq(currencies.isActive, true)));
}

export async function upsertExchangeRate(
  ctx: TenantContext,
  params: { from: string; to: string; rate: string; effectiveDate: string },
): Promise<void> {
  requirePermission(ctx, PERMISSIONS.settings.manage);

  if (lteMoney(params.rate, '0')) {
    throw new AccountingError('Exchange rate must be greater than zero');
  }

  await db
    .insert(exchangeRates)
    .values({
      companyId: ctx.companyId,
      fromCurrency: params.from,
      toCurrency: params.to,
      rate: params.rate,
      effectiveDate: params.effectiveDate,
    })
    .onConflictDoUpdate({
      target: [
        exchangeRates.companyId,
        exchangeRates.fromCurrency,
        exchangeRates.toCurrency,
        exchangeRates.effectiveDate,
      ],
      set: { rate: params.rate },
    });
}

export async function addCurrency(
  ctx: TenantContext,
  params: { code: string; name: string; symbol?: string },
): Promise<void> {
  requirePermission(ctx, PERMISSIONS.settings.manage);

  await db
    .insert(currencies)
    .values({
      companyId: ctx.companyId,
      code: params.code.toUpperCase(),
      name: params.name,
      symbol: params.symbol ?? null,
      decimalPlaces: currencyPrecision(params.code),
    })
    .onConflictDoNothing();
}
