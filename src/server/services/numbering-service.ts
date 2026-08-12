import 'server-only';

import { and, eq, sql } from 'drizzle-orm';

import type { Executor } from '@/db';
import { numberSequences } from '@/db/schema';
import { AppError } from '@/server/errors';

const DEFAULT_PATTERNS: Record<string, string> = {
  journal: 'JE-{YYYY}-{####}',
  invoice: 'INV-{YYYY}-{####}',
  credit_note: 'CN-{YYYY}-{####}',
  quote: 'QUO-{YYYY}-{####}',
  bill: 'BILL-{YYYY}-{####}',
  debit_note: 'DN-{YYYY}-{####}',
  purchase_order: 'PO-{YYYY}-{####}',
  payment: 'PAY-{YYYY}-{####}',
  expense: 'EXP-{YYYY}-{####}',
  // Contact codes carry no date and never reset — a customer's identifier
  // should stay stable and unique for the life of the company.
  customer: 'CUST-{####}',
  vendor: 'VEND-{####}',
};

/** Document types whose counters run continuously rather than resetting. */
const NEVER_RESET = new Set(['customer', 'vendor']);

/** The period key a counter resets on, per its policy. */
function resetKeyFor(policy: string, date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  if (policy === 'yearly') return `${year}`;
  if (policy === 'monthly') return `${year}-${month}`;
  return 'never';
}

/** Substitutes `{YYYY}`, `{MM}`, `{####}` … into the pattern. */
function renderPattern(
  pattern: string,
  value: number,
  date: Date,
  branchCode?: string | null,
): string {
  const year = date.getUTCFullYear();
  return pattern
    .replace(/\{YYYY\}/g, String(year))
    .replace(/\{YY\}/g, String(year).slice(-2))
    .replace(/\{MM\}/g, String(date.getUTCMonth() + 1).padStart(2, '0'))
    .replace(/\{DD\}/g, String(date.getUTCDate()).padStart(2, '0'))
    .replace(/\{BRANCH\}/g, branchCode ?? '')
    .replace(/\{(#+)\}/g, (_m, hashes: string) => String(value).padStart(hashes.length, '0'));
}

/**
 * Allocates the next document number for `documentType`.
 *
 * MUST be called inside the same transaction as the document insert. The row
 * is taken with `FOR UPDATE`, so concurrent callers serialise here rather than
 * both reading the same `nextValue` and producing duplicate numbers — the
 * unique index on `(company_id, document_type, document_number)` would reject
 * the second one, but only after the user had filled in a whole form.
 */
export async function allocateDocumentNumber(
  tx: Executor,
  params: {
    companyId: string;
    documentType: string;
    date?: Date;
    branchCode?: string | null;
  },
): Promise<string> {
  const { companyId, documentType } = params;
  const date = params.date ?? new Date();

  const locked = await tx
    .select()
    .from(numberSequences)
    .where(
      and(
        eq(numberSequences.companyId, companyId),
        eq(numberSequences.documentType, documentType),
      ),
    )
    .for('update')
    .limit(1);

  let sequence = locked[0];

  if (!sequence) {
    const pattern = DEFAULT_PATTERNS[documentType];
    if (!pattern) {
      throw new AppError(
        `No numbering sequence configured for document type "${documentType}"`,
        500,
        'numbering_not_configured',
      );
    }

    /**
     * Create on first use, so a new company works without pre-seeding every
     * sequence and an admin can still customise the pattern later.
     *
     * `FOR UPDATE` above cannot lock a row that does not exist yet, so two
     * concurrent first-uses would both try to insert and one would hit the
     * unique index. `onConflictDoNothing` lets the loser fall through and
     * re-read the winner's row, after which the normal lock applies.
     */
    const [created] = await tx
      .insert(numberSequences)
      .values({
        companyId,
        documentType,
        pattern,
        nextValue: 1,
        resetPolicy: NEVER_RESET.has(documentType) ? 'never' : 'yearly',
      })
      .onConflictDoNothing({
        target: [numberSequences.companyId, numberSequences.documentType],
      })
      .returning();

    sequence =
      created ??
      (
        await tx
          .select()
          .from(numberSequences)
          .where(
            and(
              eq(numberSequences.companyId, companyId),
              eq(numberSequences.documentType, documentType),
            ),
          )
          .for('update')
          .limit(1)
      )[0];
  }

  if (!sequence) {
    throw new AppError('Failed to allocate document number', 500, 'numbering_failed');
  }

  /**
   * The reset boundary is keyed on *today*, not on the document's date.
   *
   * Documents are routinely entered out of order — a backdated correction for
   * last year, then today's invoice. Keying the counter on the document date
   * would make each such entry look like a new period and restart the sequence
   * at 1, colliding with numbers already issued. A counter tracks how many
   * documents the company has issued, which is a fact about now.
   */
  const currentKey = resetKeyFor(sequence.resetPolicy, new Date());
  const shouldReset =
    sequence.resetPolicy !== 'never' &&
    sequence.lastResetKey !== null &&
    sequence.lastResetKey !== currentKey;

  const valueToUse = shouldReset ? 1 : sequence.nextValue;

  await tx
    .update(numberSequences)
    .set({
      nextValue: valueToUse + 1,
      lastResetKey: currentKey,
      updatedAt: sql`now()`,
    })
    .where(eq(numberSequences.id, sequence.id));

  /**
   * Rendered with the *document's* date, so a backdated 2025 invoice reads
   * `INV-2025-0042` while still drawing 0042 from the single company counter.
   * The counter guarantees uniqueness; the date tokens are presentation.
   */
  return renderPattern(sequence.pattern, valueToUse, date, params.branchCode);
}

/** Preview for the settings UI — does not consume a number. */
export function previewPattern(pattern: string, sampleValue = 1): string {
  return renderPattern(pattern, sampleValue, new Date(), 'BR1');
}
