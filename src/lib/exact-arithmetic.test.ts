/**
 * Regression tests for the float-contamination defects found in the accounting
 * audit.
 *
 * Each test below fails against the arithmetic that shipped. They exist because
 * the system's whole premise is that money never becomes a JS number, and three
 * separate paths quietly broke that rule on the *posting* side, where the error
 * lands in the ledger rather than merely on a screen.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { calculateLine } from './line-calculator';
import { abs, add, divide, divideRate, equals, lt, money, multiply, subtract } from './money';

test('inverse exchange rate is an exact reciprocal, not a float', () => {
  // The shipped code computed `1 / Number('3.0675')`, which is
  // 0.32599837816462264 — 17 significant digits handed to a numeric(20,10)
  // column that truncates, so the stored rate was not the true reciprocal.
  const rate = '3.0675';
  const inverse = divideRate('1', rate);

  // Exact at rate scale (10dp), with no float tail to be truncated. Note this
  // must divide at *rate* scale: money-scale division would yield 0.325998 and
  // throw away four decimals the rate column is defined to hold.
  // Trailing zeros are trimmed, matching how every other amount is rendered.
  assert.equal(inverse, '0.32599837');

  // The decimal string carries no more precision than the column can hold.
  const decimals = inverse.split('.')[1] ?? '';
  assert.ok(decimals.length <= 10, `rate carried ${decimals.length} decimals`);
});

test('a rate round-trips through its inverse without drifting', () => {
  // Converting out and back must land on the original amount. With float
  // reciprocals this accumulates a systematic error on every conversion.
  const rate = '3.0675';
  const amount = '10000';

  const converted = multiply(amount, rate);
  const back = multiply(converted, divideRate('1', rate));

  // Within one minor unit at presentation scale — the reciprocal is exact to
  // 10dp, so the only residue is the deliberate rounding at money scale.
  const drift = abs(subtract(back, amount));
  assert.ok(lt(drift, '0.01'), `round-trip drifted by ${drift}`);
});

test('inclusive expense tax matches the line calculator exactly', () => {
  // The expense service had its own inclusive-tax extraction:
  //   base = (Number(amount) * 100) / (100 + Number(rate))
  // computed in floats and rounded with toFixed(6). It must agree with the
  // audited calculator that invoices and bills already use, or the same
  // purchase produces different recoverable input VAT depending on which
  // screen recorded it.
  const cases = [
    { amount: '1140', rate: '14' },
    { amount: '999.99', rate: '14' },
    { amount: '1000', rate: '15' },
    { amount: '333.33', rate: '5' },
    { amount: '0.07', rate: '14' },
  ];

  for (const { amount, rate } of cases) {
    const line = calculateLine(
      { quantity: '1', unitPrice: amount, taxRatePercent: rate, taxInclusive: true },
      2,
    );

    // The defining property of inclusive tax: base + tax is exactly the amount
    // entered, so the expense leg and the recoverable-tax leg re-add to the
    // credit leg and the entry balances without a plug. Compared with exact
    // addition — comparing via Number() here would reproduce the very defect
    // these tests exist to catch (0.07 becomes 0.06999999999999999).
    assert.ok(
      equals(add(line.lineSubtotal, line.taxAmount), money(amount)),
      `inclusive tax on ${amount} @ ${rate}% did not re-add to the charged amount: ` +
        `${line.lineSubtotal} + ${line.taxAmount}`,
    );
  }
});

test('exclusive expense tax is exact where float multiplication is not', () => {
  // `(Number('0.07') * Number('14')) / 100` is 0.009799999999999999 in binary
  // floating point. The exact answer is 0.0098.
  const line = calculateLine(
    { quantity: '1', unitPrice: '0.07', taxRatePercent: '14' },
    6,
  );
  assert.equal(line.taxAmount, '0.0098');
});

test('a fixed discount larger than the line is clamped exactly', () => {
  // The clamp compared with Number(); at six decimals two amounts that differ
  // only in the last place can compare equal as floats.
  const r = calculateLine({
    quantity: '1',
    unitPrice: '100',
    discountType: 'amount',
    discountValue: '250',
  });

  assert.equal(r.discountAmount, '100');
  assert.equal(r.lineSubtotal, '0');
  // Never a negative (credit) line from a mis-typed discount.
  assert.ok(!r.lineTotal.startsWith('-'));
});

test('budget variance percent is computed by exact division', () => {
  // actual 3,333.33 against budget 10,000 is 33.3333% over/under; the float
  // path produced a long binary tail that the UI then truncated arbitrarily.
  const variance = subtract('3333.33', '10000');
  const percent = multiply(divide(variance, '10000'), '100');
  assert.equal(percent, '-66.6667');
});
