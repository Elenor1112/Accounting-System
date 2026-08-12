import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  add,
  allocate,
  compare,
  convertToBase,
  divide,
  equals,
  formatMoney,
  isZero,
  money,
  multiply,
  negate,
  round,
  subtract,
  sum,
} from './money';

test('addition is exact where floating point is not', () => {
  // The canonical float failure: 0.1 + 0.2 !== 0.3 in binary floating point.
  assert.equal(add('0.1', '0.2'), '0.3');
  assert.notEqual(0.1 + 0.2, 0.3);
});

test('summing many small amounts does not drift', () => {
  const cents = Array.from({ length: 10_000 }, () => '0.01');
  assert.equal(sum(cents), '100');
});

test('subtraction and negatives', () => {
  assert.equal(subtract('100', '250.50'), '-150.5');
  assert.equal(negate('-42.25'), '42.25');
  assert.equal(add('-10', '10'), '0');
  assert.ok(isZero(subtract('19.99', '19.99')));
});

test('multiplication rounds half away from zero', () => {
  assert.equal(multiply('10', '3'), '30');
  assert.equal(multiply('19.99', '0.14'), '2.7986');
  // 3 x 0.3333335 = 1.0000005 -> rounds up at 6dp
  assert.equal(multiply('3', '0.3333335'), '1.000001');
});

test('division', () => {
  assert.equal(divide('100', '3'), '33.333333');
  assert.equal(divide('10', '4'), '2.5');
  assert.throws(() => divide('1', '0'), /Division by zero/);
});

test('rounding to a currency minor unit', () => {
  assert.equal(round('2.7986', 2), '2.8');
  assert.equal(round('2.005', 2), '2.01');
  assert.equal(round('-2.005', 2), '-2.01');
  assert.equal(round('1234.5678', 0), '1235');
});

test('comparison', () => {
  assert.equal(compare('10.00', '10'), 0);
  assert.equal(compare('9.99', '10'), -1);
  assert.equal(compare('10.01', '10'), 1);
  assert.ok(equals('100.500000', '100.5'));
});

test('parsing normalises representations', () => {
  assert.equal(money('007.50'), '7.5');
  assert.equal(money('.5'), '0.5');
  assert.equal(money(''), '0');
  assert.equal(money('-0'), '0');
  assert.throws(() => money('12abc'), /Invalid decimal amount/);
});

test('currency conversion keeps full working precision', () => {
  // USD 1,000 at 48.75 EGP/USD
  assert.equal(convertToBase('1000', '48.75'), '48750');
  assert.equal(convertToBase('1000', '0.0000123'), '0.0123');
});

test('allocate distributes without losing or inventing money', () => {
  // 100 split three ways cannot divide evenly; the parts must still total 100.
  const parts = allocate('100', ['1', '1', '1']);
  assert.equal(sum(parts), '100');
  assert.deepEqual(parts, ['33.34', '33.33', '33.33']);
});

test('allocate is proportional to weights', () => {
  const parts = allocate('1000', ['600', '400']);
  assert.deepEqual(parts, ['600', '400']);
  assert.equal(sum(parts), '1000');
});

test('allocate handles a remainder of several minor units', () => {
  const parts = allocate('0.05', ['1', '1', '1', '1', '1', '1']);
  assert.equal(sum(parts), '0.05');
});

test('allocate with zero weights yields zeros', () => {
  assert.deepEqual(allocate('100', ['0', '0']), ['0', '0']);
});

test('formatting for display', () => {
  assert.equal(formatMoney('1234567.891', { precision: 2 }), '1,234,567.89');
  assert.equal(formatMoney('-99.5', { currency: 'USD' }), 'USD -99.50');
  assert.equal(formatMoney('1000', { precision: 0 }), '1,000');
});
