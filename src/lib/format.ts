import { formatMoney, isNegative, type Money } from './money';

/**
 * Presentation helpers. Formatting happens only at the edge — every value
 * behind this layer stays a decimal string so no rounding leaks into stored
 * figures.
 */

export function money(
  value: Money | null | undefined,
  options: { currency?: string; precision?: number } = {},
): string {
  if (value === null || value === undefined) return '—';
  return formatMoney(value, options);
}

/** Renders a signed amount with parentheses, the accounting convention. */
export function accountingMoney(
  value: Money | null | undefined,
  options: { currency?: string; precision?: number } = {},
): string {
  if (value === null || value === undefined) return '—';
  const formatted = formatMoney(value, options).replace('-', '');
  return isNegative(value) ? `(${formatted})` : formatted;
}

export function date(value: string | Date | null | undefined, format = 'medium'): string {
  if (!value) return '—';
  const d = typeof value === 'string' ? new Date(`${value}T00:00:00Z`) : value;
  if (Number.isNaN(d.getTime())) return '—';

  return d.toLocaleDateString('en-US', {
    timeZone: 'UTC',
    ...(format === 'short'
      ? { month: 'short', day: 'numeric' }
      : format === 'long'
        ? { year: 'numeric', month: 'long', day: 'numeric' }
        : { year: 'numeric', month: 'short', day: 'numeric' }),
  });
}

export function dateTime(value: string | Date | null | undefined): string {
  if (!value) return '—';
  const d = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** "3 days overdue", "due in 12 days" — the phrasing an AR clerk scans for. */
export function relativeDue(dueDate: string | null | undefined): {
  label: string;
  tone: 'neutral' | 'warning' | 'negative';
} {
  if (!dueDate) return { label: '—', tone: 'neutral' };

  const due = new Date(`${dueDate}T00:00:00Z`);
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  const days = Math.round((due.getTime() - today.getTime()) / 86_400_000);

  if (days < 0) {
    const n = Math.abs(days);
    return { label: `${n} day${n === 1 ? '' : 's'} overdue`, tone: 'negative' };
  }
  if (days === 0) return { label: 'Due today', tone: 'warning' };
  if (days <= 7) return { label: `Due in ${days} day${days === 1 ? '' : 's'}`, tone: 'warning' };
  return { label: `Due ${date(dueDate, 'short')}`, tone: 'neutral' };
}

export function percent(value: string | number | null | undefined, decimals = 1): string {
  if (value === null || value === undefined) return '—';
  const n = Number(value);
  if (Number.isNaN(n)) return '—';
  return `${n >= 0 ? '' : ''}${n.toFixed(decimals)}%`;
}

/** Turns `partially_paid` into `Partially paid`. */
export function humanise(value: string | null | undefined): string {
  if (!value) return '—';
  const spaced = value.replace(/_/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');
}

/** Today in the `yyyy-MM-dd` form every date column expects. */
export function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

export function monthRange(date: Date = new Date()): { from: string; to: string } {
  const from = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
  const to = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0));
  return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
}

export function yearRange(year: number = new Date().getUTCFullYear()): {
  from: string;
  to: string;
} {
  return { from: `${year}-01-01`, to: `${year}-12-31` };
}
