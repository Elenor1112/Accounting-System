/**
 * Decimal arithmetic for money, implemented on BigInt.
 *
 * Money never becomes a JS number anywhere in this system. `0.1 + 0.2` is
 * `0.30000000000000004` in binary floating point, and a ledger that must
 * satisfy `sum(debit) = sum(credit)` exactly cannot tolerate that drift — a
 * few thousand invoice lines is enough for a trial balance to fail by a cent
 * with no bug to point at.
 *
 * Amounts travel as decimal strings (matching Postgres `numeric`) and are
 * converted to scaled BigInt only inside these helpers. `SCALE` is 6 to match
 * the column definition, which leaves headroom above the 2–3 decimals used for
 * presentation so intermediate results (tax on a discounted line, currency
 * conversion) can round once at the end rather than at every step.
 */

export const SCALE = 6;
const SCALE_FACTOR = 10n ** BigInt(SCALE);

/**
 * Multipliers — exchange rates above all — carry more decimals than money.
 * A rate column is `numeric(20,10)`, and some pairs genuinely trade at
 * 0.0000123, so parsing a rate at money scale would truncate it to 0.000012
 * and silently misstate every converted amount.
 */
const RATE_SCALE = 10;
const RATE_FACTOR = 10n ** BigInt(RATE_SCALE);

export type Money = string;

/** Parses a decimal string into a BigInt scaled by 10^`scale`. */
function parseDecimal(value: Money | number, scale: number): bigint {
  const str = typeof value === 'number' ? String(value) : String(value ?? '').trim();
  if (str === '') return 0n;

  if (!/^-?\d*(\.\d*)?$/.test(str)) {
    throw new Error(`Invalid decimal amount: "${str}"`);
  }

  const negative = str.startsWith('-');
  const unsigned = negative ? str.slice(1) : str;
  const [whole = '0', fraction = ''] = unsigned.split('.');

  // Pad or truncate the fraction to exactly `scale` digits. Truncation is safe
  // because inputs carry at most `scale` meaningful decimals; rounding of
  // computed values happens explicitly via `round`.
  const paddedFraction = fraction.padEnd(scale, '0').slice(0, scale);
  const digits = `${whole}${paddedFraction}`.replace(/^0+(?=\d)/, '');
  const magnitude = BigInt(digits === '' ? '0' : digits);
  return negative ? -magnitude : magnitude;
}

/** Parses at money scale (6dp). */
function toScaled(value: Money | number): bigint {
  return parseDecimal(value, SCALE);
}

/** Parses a multiplier/rate at 10dp. */
function toRateScaled(value: Money | number): bigint {
  return parseDecimal(value, RATE_SCALE);
}

/** Renders a scaled BigInt back to a canonical decimal string. */
function fromScaled(scaled: bigint): Money {
  const negative = scaled < 0n;
  const magnitude = negative ? -scaled : scaled;
  const whole = magnitude / SCALE_FACTOR;
  const fraction = magnitude % SCALE_FACTOR;
  const fractionStr = fraction.toString().padStart(SCALE, '0').replace(/0+$/, '');
  const body = fractionStr === '' ? `${whole}` : `${whole}.${fractionStr}`;
  return negative && body !== '0' ? `-${body}` : body;
}

export const money = (value: Money | number): Money => fromScaled(toScaled(value));

export const ZERO: Money = '0';

export function add(a: Money, b: Money): Money {
  return fromScaled(toScaled(a) + toScaled(b));
}

export function subtract(a: Money, b: Money): Money {
  return fromScaled(toScaled(a) - toScaled(b));
}

export function sum(values: readonly Money[]): Money {
  return fromScaled(values.reduce<bigint>((acc, v) => acc + toScaled(v), 0n));
}

/**
 * Multiplies an amount by a factor (quantity, tax rate, exchange rate).
 *
 * The factor is parsed at rate scale so high-precision exchange rates survive;
 * the product is then divided back down to money scale with half-up rounding.
 */
export function multiply(a: Money, b: Money | number): Money {
  const product = toScaled(a) * toRateScaled(b);
  return fromScaled(divideRounded(product, RATE_FACTOR));
}

export function divide(a: Money, b: Money | number): Money {
  const divisor = toRateScaled(b);
  if (divisor === 0n) throw new Error('Division by zero');
  return fromScaled(divideRounded(toScaled(a) * RATE_FACTOR, divisor));
}

/**
 * Divides at *rate* scale (10dp) rather than money scale.
 *
 * Exchange rates need every one of those ten decimals: the reciprocal of
 * 3.0675 is 0.32599837…, and rounding it to money's 6dp (0.325998) loses
 * precision the `numeric(20,10)` rate column exists to hold — enough that
 * converting 10,000 out and back drifts by more than a minor unit. Use this
 * for rates; use `divide` for amounts.
 */
export function divideRate(a: Money, b: Money | number): Money {
  const divisor = toRateScaled(b);
  if (divisor === 0n) throw new Error('Division by zero');
  const scaled = divideRounded(toRateScaled(a) * RATE_FACTOR, divisor);

  // Render at rate scale, trimming trailing zeros the way `fromScaled` does.
  const negative = scaled < 0n;
  const magnitude = negative ? -scaled : scaled;
  const whole = magnitude / RATE_FACTOR;
  const fraction = (magnitude % RATE_FACTOR)
    .toString()
    .padStart(RATE_SCALE, '0')
    .replace(/0+$/, '');
  const body = fraction === '' ? `${whole}` : `${whole}.${fraction}`;
  return negative && body !== '0' ? `-${body}` : body;
}

/** Half-up division on BigInt, correct for negative numerators. */
function divideRounded(numerator: bigint, denominator: bigint): bigint {
  const negative = numerator < 0n !== denominator < 0n;
  const n = numerator < 0n ? -numerator : numerator;
  const d = denominator < 0n ? -denominator : denominator;
  const quotient = n / d;
  const remainder = n % d;
  // Round half away from zero: the convention accountants expect.
  const rounded = remainder * 2n >= d ? quotient + 1n : quotient;
  return negative ? -rounded : rounded;
}

/** Rounds to `decimals` places (half up), e.g. to a currency's minor unit. */
export function round(value: Money, decimals: number): Money {
  if (decimals >= SCALE) return money(value);
  const factor = 10n ** BigInt(SCALE - decimals);
  const scaled = toScaled(value);
  return fromScaled(divideRounded(scaled, factor) * factor);
}

export function compare(a: Money, b: Money): -1 | 0 | 1 {
  const x = toScaled(a);
  const y = toScaled(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

export const isZero = (v: Money): boolean => toScaled(v) === 0n;
export const isNegative = (v: Money): boolean => toScaled(v) < 0n;
export const isPositive = (v: Money): boolean => toScaled(v) > 0n;
export const equals = (a: Money, b: Money): boolean => toScaled(a) === toScaled(b);
export const gt = (a: Money, b: Money): boolean => compare(a, b) === 1;
export const gte = (a: Money, b: Money): boolean => compare(a, b) >= 0;
export const lt = (a: Money, b: Money): boolean => compare(a, b) === -1;
export const lte = (a: Money, b: Money): boolean => compare(a, b) <= 0;
export const abs = (v: Money): Money => fromScaled(toScaled(v) < 0n ? -toScaled(v) : toScaled(v));
export const negate = (v: Money): Money => fromScaled(-toScaled(v));
export const max = (a: Money, b: Money): Money => (gt(a, b) ? money(a) : money(b));
export const min = (a: Money, b: Money): Money => (lt(a, b) ? money(a) : money(b));

/**
 * Converts a transaction-currency amount to base currency.
 * Rounded to SCALE, not to the presentation precision: the ledger keeps full
 * working precision and only reports round for display.
 */
export function convertToBase(amount: Money, exchangeRate: string): Money {
  return multiply(amount, exchangeRate);
}

/**
 * Distributes `total` across `weights` so the parts sum to exactly `total`.
 *
 * Proportional splits (allocating a payment across invoices, apportioning a
 * document-level discount over lines) generically leave a remainder of one or
 * two minor units after rounding. Rather than let that vanish — which would
 * unbalance the resulting journal entry — the leftover is handed to the
 * largest weights, one minor unit at a time.
 */
export function allocate(total: Money, weights: readonly Money[], decimals = 2): Money[] {
  const weightTotal = sum(weights);
  if (isZero(weightTotal)) {
    return weights.map(() => ZERO);
  }

  const unit = 10n ** BigInt(SCALE - decimals);
  const totalScaled = toScaled(total);
  const parts = weights.map((w) => {
    const raw = (toScaled(w) * totalScaled) / toScaled(weightTotal);
    return (raw / unit) * unit; // floor to the minor unit
  });

  let remainder = totalScaled - parts.reduce((acc, p) => acc + p, 0n);

  // Hand out the remaining minor units to the largest weights first.
  const order = weights
    .map((w, i) => ({ i, w: toScaled(w) }))
    .sort((a, b) => (b.w > a.w ? 1 : b.w < a.w ? -1 : 0));

  let cursor = 0;
  while (remainder >= unit && order.length > 0) {
    const target = order[cursor % order.length]!;
    parts[target.i] = parts[target.i]! + unit;
    remainder -= unit;
    cursor++;
  }
  // Any sub-minor-unit dust goes to the largest weight so the sum is exact.
  if (remainder !== 0n && order.length > 0) {
    const target = order[0]!;
    parts[target.i] = parts[target.i]! + remainder;
  }

  return parts.map(fromScaled);
}

/** Formats for display. Storage and arithmetic always use the raw string. */
export function formatMoney(
  value: Money,
  options: { currency?: string; precision?: number; locale?: string } = {},
): string {
  const { currency, precision = 2, locale = 'en-US' } = options;
  const rounded = round(value, precision);
  const [whole = '0', fraction = ''] = rounded.replace('-', '').split('.');
  const grouped = Number(whole).toLocaleString(locale);
  const decimals = fraction.padEnd(precision, '0').slice(0, precision);
  const body = precision > 0 ? `${grouped}.${decimals}` : grouped;
  const signed = isNegative(rounded) ? `-${body}` : body;
  return currency ? `${currency} ${signed}` : signed;
}
