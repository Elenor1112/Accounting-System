/**
 * Document line arithmetic: quantity, discount, tax, totals.
 *
 * Deliberately pure and free of database access so it can be unit-tested
 * exhaustively and reused by invoices, bills, quotes and credit notes without
 * any of them re-deriving the rules. Every value is a decimal string.
 *
 * Order of operations, which matters and is easy to get wrong:
 *   1. gross      = quantity x unitPrice
 *   2. discount   = percentage of gross, or a fixed amount
 *   3. net        = gross - discount        <- the taxable base
 *   4. tax        = f(net, rate, inclusive)
 *   5. lineTotal  = net + tax               (exclusive)
 *                 = net                     (inclusive: tax already inside)
 *
 * Discount is applied before tax because tax authorities levy on the amount
 * actually charged. Computing tax on the undiscounted figure would overstate
 * the liability on every discounted line.
 */
import { add, divide, isZero, money, multiply, round, subtract, sum, ZERO, type Money } from './money';

export type DiscountType = 'none' | 'percent' | 'amount';

export interface LineInput {
  quantity: Money;
  unitPrice: Money;
  discountType?: DiscountType;
  discountValue?: Money;
  /** Percentage, e.g. '14' for 14%. */
  taxRatePercent?: Money;
  /** When true the unit price already contains the tax. */
  taxInclusive?: boolean;
}

export interface LineResult {
  /** quantity x unitPrice, before any discount. */
  gross: Money;
  discountAmount: Money;
  /** The taxable base: gross - discount. Excludes tax in both modes. */
  lineSubtotal: Money;
  taxAmount: Money;
  /** What the customer is billed for this line. */
  lineTotal: Money;
}

const HUNDRED = '100';

/**
 * Computes one line. `precision` is the currency's minor-unit count; rounding
 * happens once per component so the parts always re-add to the whole.
 */
export function calculateLine(input: LineInput, precision = 2): LineResult {
  const quantity = money(input.quantity);
  const unitPrice = money(input.unitPrice);
  const taxRate = money(input.taxRatePercent ?? ZERO);
  const inclusive = input.taxInclusive ?? false;

  const gross = round(multiply(quantity, unitPrice), precision);

  let discountAmount = ZERO;
  if (input.discountType === 'percent') {
    const pct = money(input.discountValue ?? ZERO);
    discountAmount = round(divide(multiply(gross, pct), HUNDRED), precision);
  } else if (input.discountType === 'amount') {
    discountAmount = round(money(input.discountValue ?? ZERO), precision);
  }

  // A discount can never exceed the line itself; clamping here keeps a
  // mis-typed fixed discount from producing a negative (credit) line.
  if (Number(discountAmount) > Number(gross)) {
    discountAmount = gross;
  }

  const netOfDiscount = subtract(gross, discountAmount);

  let lineSubtotal: Money;
  let taxAmount: Money;

  if (isZero(taxRate)) {
    lineSubtotal = netOfDiscount;
    taxAmount = ZERO;
  } else if (inclusive) {
    /**
     * The charged amount already contains the tax, so it must be extracted:
     *   base = charged / (1 + rate/100)
     *   tax  = charged - base
     * Deriving tax by subtraction rather than by multiplying the base keeps
     * base + tax exactly equal to the price the customer sees, with no
     * rounding gap.
     */
    const divisor = add(HUNDRED, taxRate);
    const base = round(divide(multiply(netOfDiscount, HUNDRED), divisor), precision);
    lineSubtotal = base;
    taxAmount = subtract(netOfDiscount, base);
  } else {
    lineSubtotal = netOfDiscount;
    taxAmount = round(divide(multiply(netOfDiscount, taxRate), HUNDRED), precision);
  }

  return {
    gross,
    discountAmount,
    lineSubtotal,
    taxAmount,
    lineTotal: add(lineSubtotal, taxAmount),
  };
}

export interface DocumentTotals {
  subtotal: Money;
  discountTotal: Money;
  taxTotal: Money;
  total: Money;
}

/** Sums calculated lines into document totals. */
export function calculateDocumentTotals(lines: LineResult[]): DocumentTotals {
  return {
    subtotal: sum(lines.map((l) => l.lineSubtotal)),
    discountTotal: sum(lines.map((l) => l.discountAmount)),
    taxTotal: sum(lines.map((l) => l.taxAmount)),
    total: sum(lines.map((l) => l.lineTotal)),
  };
}

/**
 * Groups tax by rate, which is what a tax return and the invoice's tax summary
 * need — a single "tax total" cannot be filed when a document mixes rates.
 */
export function summariseTaxes(
  lines: Array<{ taxId?: string | null; taxRatePercent: Money; result: LineResult }>,
): Array<{ taxId: string | null; ratePercent: Money; taxableAmount: Money; taxAmount: Money }> {
  const groups = new Map<
    string,
    { taxId: string | null; ratePercent: Money; taxableAmount: Money; taxAmount: Money }
  >();

  for (const line of lines) {
    if (isZero(line.taxRatePercent)) continue;
    const key = `${line.taxId ?? 'none'}:${line.taxRatePercent}`;
    const existing = groups.get(key);
    if (existing) {
      existing.taxableAmount = add(existing.taxableAmount, line.result.lineSubtotal);
      existing.taxAmount = add(existing.taxAmount, line.result.taxAmount);
    } else {
      groups.set(key, {
        taxId: line.taxId ?? null,
        ratePercent: line.taxRatePercent,
        taxableAmount: line.result.lineSubtotal,
        taxAmount: line.result.taxAmount,
      });
    }
  }

  return [...groups.values()];
}
