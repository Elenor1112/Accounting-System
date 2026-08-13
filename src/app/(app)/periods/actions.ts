'use server';

import { revalidatePath } from 'next/cache';

import { requireTenantContext } from '@/server/auth/session';
import { isAppError } from '@/server/errors';
import { setPeriodStatus } from '@/server/services/period-service';
import { closeFiscalYear, previewYearEndClose } from '@/server/services/year-end-service';

export interface PeriodActionResult {
  ok: boolean;
  error?: string;
  message?: string;
}

export async function setPeriodStatusAction(
  periodId: string,
  status: 'open' | 'closed' | 'locked',
  reason?: string,
): Promise<PeriodActionResult> {
  try {
    const ctx = await requireTenantContext();
    await setPeriodStatus(ctx, periodId, status, reason);
    revalidatePath('/periods');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: toMessage(err) };
  }
}

/**
 * What closing a year would post, without posting it.
 *
 * Year-end close is irreversible in practice — the entry can be reversed, but
 * only by someone who understands what it did — so the figures are shown for
 * review first and can be tied back to the P&L before anyone commits.
 */
export async function previewYearEndAction(
  fiscalYear: number,
): Promise<
  PeriodActionResult & {
    preview?: Awaited<ReturnType<typeof previewYearEndClose>>;
  }
> {
  try {
    const ctx = await requireTenantContext();
    const preview = await previewYearEndClose(ctx, fiscalYear);
    return { ok: true, preview };
  } catch (err) {
    return { ok: false, error: toMessage(err) };
  }
}

export async function closeFiscalYearAction(
  fiscalYear: number,
  lockPeriods: boolean,
): Promise<PeriodActionResult> {
  try {
    const ctx = await requireTenantContext();
    const result = await closeFiscalYear(ctx, fiscalYear, { lockPeriods });

    revalidatePath('/periods');
    revalidatePath('/reports/balance-sheet');
    revalidatePath('/reports/profit-loss');
    revalidatePath('/journal');

    const isProfit = !result.netIncome.startsWith('-');
    return {
      ok: true,
      message:
        `${fiscalYear} closed. Net ${isProfit ? 'profit' : 'loss'} of ` +
        `${result.netIncome.replace('-', '')} transferred to retained earnings.`,
    };
  } catch (err) {
    return { ok: false, error: toMessage(err) };
  }
}

function toMessage(err: unknown): string {
  if (isAppError(err)) return err.message;
  console.error('Period action failed:', err);
  return 'Something went wrong. Please try again.';
}
