import assert from 'node:assert/strict';
import { test } from 'node:test';

import { calculateDocumentTotals, calculateLine, summariseTaxes } from './line-calculator';
import { add, sum } from './money';

test('simple line without discount or tax', () => {
  const r = calculateLine({ quantity: '3', unitPrice: '250' });
  assert.equal(r.gross, '750');
  assert.equal(r.discountAmount, '0');
  assert.equal(r.lineSubtotal, '750');
  assert.equal(r.taxAmount, '0');
  assert.equal(r.lineTotal, '750');
});

test('exclusive tax is added on top', () => {
  const r = calculateLine({ quantity: '1', unitPrice: '1000', taxRatePercent: '14' });
  assert.equal(r.lineSubtotal, '1000');
  assert.equal(r.taxAmount, '140');
  assert.equal(r.lineTotal, '1140');
});

test('inclusive tax is extracted from the price', () => {
  // 1,140 charged at 14% inclusive: base 1,000 + tax 140.
  const r = calculateLine({
    quantity: '1',
    unitPrice: '1140',
    taxRatePercent: '14',
    taxInclusive: true,
  });
  assert.equal(r.lineSubtotal, '1000');
  assert.equal(r.taxAmount, '140');
  // The customer still pays exactly the price shown.
  assert.equal(r.lineTotal, '1140');
});

test('inclusive tax always re-adds to the charged amount', () => {
  // A price that does not divide cleanly: the parts must still sum exactly.
  const r = calculateLine({
    quantity: '1',
    unitPrice: '99.99',
    taxRatePercent: '14',
    taxInclusive: true,
  });
  assert.equal(add(r.lineSubtotal, r.taxAmount), '99.99');
  assert.equal(r.lineTotal, '99.99');
});

test('percentage discount applies before tax', () => {
  // 1,000 less 10% = 900 taxable; 14% of 900 = 126.
  const r = calculateLine({
    quantity: '1',
    unitPrice: '1000',
    discountType: 'percent',
    discountValue: '10',
    taxRatePercent: '14',
  });
  assert.equal(r.discountAmount, '100');
  assert.equal(r.lineSubtotal, '900');
  assert.equal(r.taxAmount, '126');
  assert.equal(r.lineTotal, '1026');
});

test('fixed-amount discount', () => {
  const r = calculateLine({
    quantity: '2',
    unitPrice: '500',
    discountType: 'amount',
    discountValue: '150',
  });
  assert.equal(r.gross, '1000');
  assert.equal(r.discountAmount, '150');
  assert.equal(r.lineSubtotal, '850');
});

test('a discount larger than the line is clamped, never negative', () => {
  const r = calculateLine({
    quantity: '1',
    unitPrice: '100',
    discountType: 'amount',
    discountValue: '500',
  });
  assert.equal(r.discountAmount, '100');
  assert.equal(r.lineSubtotal, '0');
  assert.equal(r.lineTotal, '0');
});

test('fractional quantities and prices round to the minor unit', () => {
  const r = calculateLine({ quantity: '1.5', unitPrice: '33.333', taxRatePercent: '14' });
  assert.equal(r.gross, '50');
  assert.equal(r.taxAmount, '7');
  assert.equal(r.lineTotal, '57');
});

test('zero-decimal currency precision', () => {
  // JPY has no minor unit: nothing after the decimal point.
  const r = calculateLine({ quantity: '3', unitPrice: '1000.4', taxRatePercent: '10' }, 0);
  assert.equal(r.gross, '3001');
  assert.equal(r.taxAmount, '300');
});

test('document totals sum their lines', () => {
  const lines = [
    calculateLine({ quantity: '2', unitPrice: '100', taxRatePercent: '14' }),
    calculateLine({ quantity: '1', unitPrice: '50', taxRatePercent: '14' }),
    calculateLine({ quantity: '4', unitPrice: '25' }),
  ];
  const totals = calculateDocumentTotals(lines);

  assert.equal(totals.subtotal, '350');
  assert.equal(totals.taxTotal, '35');
  assert.equal(totals.total, '385');
  // The invariant the ledger depends on: subtotal + tax = total.
  assert.equal(add(totals.subtotal, totals.taxTotal), totals.total);
});

test('totals hold across many awkward lines', () => {
  const lines = Array.from({ length: 97 }, (_, i) =>
    calculateLine({
      quantity: '3',
      unitPrice: String(19.99 + i * 0.37),
      discountType: 'percent',
      discountValue: '7.5',
      taxRatePercent: '14',
    }),
  );
  const totals = calculateDocumentTotals(lines);
  assert.equal(add(totals.subtotal, totals.taxTotal), totals.total);
  assert.equal(sum(lines.map((l) => l.lineTotal)), totals.total);
});

test('tax summary groups by rate', () => {
  const standard = calculateLine({ quantity: '1', unitPrice: '1000', taxRatePercent: '14' });
  const reduced = calculateLine({ quantity: '1', unitPrice: '500', taxRatePercent: '5' });
  const alsoStandard = calculateLine({ quantity: '1', unitPrice: '200', taxRatePercent: '14' });

  const summary = summariseTaxes([
    { taxId: 'vat-standard', taxRatePercent: '14', result: standard },
    { taxId: 'vat-reduced', taxRatePercent: '5', result: reduced },
    { taxId: 'vat-standard', taxRatePercent: '14', result: alsoStandard },
  ]);

  assert.equal(summary.length, 2);
  const std = summary.find((s) => s.taxId === 'vat-standard');
  assert.equal(std?.taxableAmount, '1200');
  assert.equal(std?.taxAmount, '168');
});

test('untaxed lines are excluded from the tax summary', () => {
  const untaxed = calculateLine({ quantity: '1', unitPrice: '100' });
  assert.deepEqual(summariseTaxes([{ taxRatePercent: '0', result: untaxed }]), []);
});
