/**
 * Helpers for maintenance scripts talking to Neon over the raw SQL driver.
 *
 * The driver returns `Record<string, any>[]`, which under
 * `noUncheckedIndexedAccess` makes every `rows[0]` possibly-undefined. These
 * wrappers assert the expectation once, with a message naming the query, so
 * scripts stay readable instead of carrying non-null assertions everywhere.
 */

export function firstRow<T = Record<string, unknown>>(
  rows: Record<string, unknown>[],
  what: string,
): T {
  const row = rows[0];
  if (!row) throw new Error(`Expected at least one row from: ${what}`);
  return row as T;
}

export function scalar<T = string>(rows: Record<string, unknown>[], key: string, what: string): T {
  const row = firstRow(rows, what);
  return row[key] as T;
}

/** `id` of the first row — the common `insert … returning id` case. */
export function firstId(rows: Record<string, unknown>[], what: string): string {
  return scalar<string>(rows, 'id', what);
}
