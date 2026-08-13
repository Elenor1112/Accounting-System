'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState, useTransition } from 'react';

import { createJournalEntryAction } from '@/app/(app)/journal/actions';
import * as fmt from '@/lib/format';
import { add, isZero, money, subtract } from '@/lib/money';

import { Button, Card, ErrorBanner, Field, Input, Select, TableWrap } from './ui';

export interface JournalAccountOption {
  id: string;
  code: string;
  name: string;
  type: string;
  isPostable: boolean;
  isControlAccount: boolean;
  isArchived: boolean;
}

export interface JournalCurrencyOption {
  code: string;
  name: string;
}

interface LineDraft {
  key: string;
  accountId: string;
  description: string;
  debit: string;
  credit: string;
}

let lineCounter = 0;
function emptyLine(): LineDraft {
  lineCounter += 1;
  return { key: `jl-${lineCounter}`, accountId: '', description: '', debit: '', credit: '' };
}

/**
 * A half-typed "1." or an empty box must not become NaN. Anything unparseable
 * reads as zero for the running totals; the server recomputes regardless.
 */
function num(value: string): string {
  const trimmed = value.trim();
  if (trimmed === '' || !Number.isFinite(Number(trimmed))) return '0';
  return trimmed;
}

/**
 * Manual journal entry form.
 *
 * Accruals, prepayment amortisation, depreciation, payroll journals, opening
 * balances, corrections and every year-end adjustment are manual entries, and
 * an accountant cannot close a month without them.
 *
 * The running totals use the same exact BigInt arithmetic as the ledger, not
 * float addition, so the "difference" shown here is the same number the server
 * will compute — a balanced entry on screen is never rejected as unbalanced on
 * submit.
 */
export function JournalEntryForm({
  accounts,
  currencies,
  baseCurrencyCode,
  currencyPrecision,
  canPost,
}: {
  accounts: JournalAccountOption[];
  currencies: JournalCurrencyOption[];
  baseCurrencyCode: string;
  currencyPrecision: number;
  canPost: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const [entryDate, setEntryDate] = useState(fmt.todayISO());
  const [description, setDescription] = useState('');
  const [reference, setReference] = useState('');
  const [currencyCode, setCurrencyCode] = useState(baseCurrencyCode);
  const [exchangeRate, setExchangeRate] = useState('1');
  // Two lines by default: an entry needs at least a debit and a credit, so
  // starting with one would always require a click before anything useful.
  const [lines, setLines] = useState<LineDraft[]>([emptyLine(), emptyLine()]);

  /**
   * Accounts a manual entry may legitimately use.
   *
   * Summary accounts hold no lines of their own; archived accounts reject new
   * postings; and AR/AP control accounts are maintained by the invoices and
   * bills subledgers — posting to them by hand is what makes a subledger stop
   * agreeing with the ledger. The server enforces all three independently;
   * filtering here means the user never picks an account only to be refused.
   */
  const postable = useMemo(
    () =>
      accounts.filter(
        (a) => a.isPostable && !a.isArchived && !a.isControlAccount,
      ),
    [accounts],
  );

  const totals = useMemo(() => {
    let debit = '0';
    let credit = '0';
    for (const line of lines) {
      debit = add(debit, num(line.debit));
      credit = add(credit, num(line.credit));
    }
    return { debit, credit, difference: subtract(debit, credit) };
  }, [lines]);

  const balanced = isZero(totals.difference);
  const hasValue = !isZero(totals.debit) || !isZero(totals.credit);

  // Lines carrying a value must name an account, and no line may hold both a
  // debit and a credit — the same rules the ledger enforces.
  const linesValid = lines.every((line) => {
    const d = !isZero(num(line.debit));
    const c = !isZero(num(line.credit));
    if (d && c) return false;
    if ((d || c) && line.accountId === '') return false;
    return true;
  });

  const usableLines = lines.filter(
    (line) => !isZero(num(line.debit)) || !isZero(num(line.credit)),
  );

  const canSubmit =
    entryDate !== '' &&
    balanced &&
    hasValue &&
    linesValid &&
    usableLines.length >= 2 &&
    !pending;

  const asMoney = (value: string) =>
    fmt.money(value, { currency: currencyCode, precision: currencyPrecision });

  const updateLine = (key: string, patch: Partial<LineDraft>) =>
    setLines((current) =>
      current.map((line) => (line.key === key ? { ...line, ...patch } : line)),
    );

  const removeLine = (key: string) =>
    setLines((current) =>
      current.length <= 2 ? current : current.filter((line) => line.key !== key),
    );

  const submit = (post: boolean) => {
    setError(null);
    startTransition(async () => {
      const result = await createJournalEntryAction({
        entryDate,
        description: description.trim() || null,
        reference: reference.trim() || null,
        currencyCode,
        exchangeRate: currencyCode === baseCurrencyCode ? '1' : num(exchangeRate),
        post,
        lines: usableLines.map((line) => ({
          accountId: line.accountId,
          debit: isZero(num(line.debit)) ? undefined : money(num(line.debit)),
          credit: isZero(num(line.credit)) ? undefined : money(num(line.credit)),
          description: line.description.trim() || null,
        })),
      });

      if (result.ok && result.id) {
        router.push(`/journal/${result.id}`);
      } else {
        setError(result.error ?? 'Could not save the journal entry');
      }
    });
  };

  return (
    <>
      <div className="mb-4">
        <Link href="/journal" className="text-xs text-muted-foreground hover:text-foreground">
          ← Back to journal
        </Link>
      </div>

      {error ? (
        <div className="mb-4">
          <ErrorBanner message={error} />
        </div>
      ) : null}

      <div className="flex flex-col gap-4">
        <Card>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Date" htmlFor="entry-date">
              <Input
                id="entry-date"
                type="date"
                value={entryDate}
                onChange={(e) => setEntryDate(e.target.value)}
              />
            </Field>

            <Field label="Reference" htmlFor="entry-reference">
              <Input
                id="entry-reference"
                value={reference}
                onChange={(e) => setReference(e.target.value)}
                placeholder="e.g. ACCR-06"
              />
            </Field>

            <Field label="Currency" htmlFor="entry-currency">
              <Select
                id="entry-currency"
                value={currencyCode}
                onChange={(e) => {
                  setCurrencyCode(e.target.value);
                  if (e.target.value === baseCurrencyCode) setExchangeRate('1');
                }}
              >
                <option value={baseCurrencyCode}>{baseCurrencyCode}</option>
                {currencies
                  .filter((c) => c.code !== baseCurrencyCode)
                  .map((c) => (
                    <option key={c.code} value={c.code}>
                      {c.code} — {c.name}
                    </option>
                  ))}
              </Select>
            </Field>

            {currencyCode !== baseCurrencyCode ? (
              <Field
                label={`Rate to ${baseCurrencyCode}`}
                htmlFor="entry-rate"
                hint="Applied to every line"
              >
                <Input
                  id="entry-rate"
                  value={exchangeRate}
                  onChange={(e) => setExchangeRate(e.target.value)}
                  inputMode="decimal"
                />
              </Field>
            ) : null}
          </div>

          <div className="mt-4">
            <Field label="Description" htmlFor="entry-description">
              <Input
                id="entry-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="e.g. Accrued June rent"
              />
            </Field>
          </div>
        </Card>

        <Card>
          <TableWrap>
            <table className="w-full text-sm">
              <thead>
                <tr>
                  <th className="th-base w-[34%]">Account</th>
                  <th className="th-base">Description</th>
                  <th className="th-base w-[15%] text-right">Debit</th>
                  <th className="th-base w-[15%] text-right">Credit</th>
                  <th className="th-base w-10" />
                </tr>
              </thead>
              <tbody>
                {lines.map((line) => (
                  <tr key={line.key}>
                    <td className="td-base">
                      <Select
                        aria-label="Account"
                        value={line.accountId}
                        onChange={(e) => updateLine(line.key, { accountId: e.target.value })}
                      >
                        <option value="">Select an account…</option>
                        {postable.map((account) => (
                          <option key={account.id} value={account.id}>
                            {account.code} — {account.name}
                          </option>
                        ))}
                      </Select>
                    </td>
                    <td className="td-base">
                      <Input
                        aria-label="Line description"
                        value={line.description}
                        onChange={(e) =>
                          updateLine(line.key, { description: e.target.value })
                        }
                      />
                    </td>
                    <td className="td-base">
                      <Input
                        aria-label="Debit"
                        className="text-right"
                        inputMode="decimal"
                        value={line.debit}
                        onChange={(e) =>
                          // A line carries one side or the other, never both;
                          // typing in one clears the other rather than letting
                          // the user build an entry the ledger will refuse.
                          updateLine(line.key, { debit: e.target.value, credit: '' })
                        }
                      />
                    </td>
                    <td className="td-base">
                      <Input
                        aria-label="Credit"
                        className="text-right"
                        inputMode="decimal"
                        value={line.credit}
                        onChange={(e) =>
                          updateLine(line.key, { credit: e.target.value, debit: '' })
                        }
                      />
                    </td>
                    <td className="td-base text-right">
                      <button
                        type="button"
                        onClick={() => removeLine(line.key)}
                        disabled={lines.length <= 2}
                        className="text-muted-foreground hover:text-negative disabled:opacity-30"
                        aria-label="Remove line"
                        title="Remove line"
                      >
                        ×
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td className="td-base" colSpan={2}>
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={() => setLines((c) => [...c, emptyLine()])}
                    >
                      Add line
                    </Button>
                  </td>
                  <td className="td-base num text-right font-medium">
                    {asMoney(totals.debit)}
                  </td>
                  <td className="td-base num text-right font-medium">
                    {asMoney(totals.credit)}
                  </td>
                  <td className="td-base" />
                </tr>
              </tfoot>
            </table>
          </TableWrap>

          {/* The out-of-balance indicator: an accountant's first check. */}
          <div className="mt-4 flex items-center justify-between border-t border-border pt-4">
            <span className="text-sm text-muted-foreground">Difference</span>
            <span
              className={`num text-sm font-medium ${
                balanced ? 'text-positive' : 'text-negative'
              }`}
            >
              {balanced ? 'Balanced' : asMoney(totals.difference)}
            </span>
          </div>

          {!balanced && hasValue ? (
            <p className="mt-2 text-xs text-negative">
              Debits and credits must be equal before this entry can be saved.
            </p>
          ) : null}
        </Card>

        <div className="flex items-center gap-2">
          <Button type="button" onClick={() => submit(false)} disabled={!canSubmit}>
            {pending ? 'Saving…' : 'Save draft'}
          </Button>
          {canPost ? (
            <Button
              type="button"
              variant="primary"
              onClick={() => submit(true)}
              disabled={!canSubmit}
            >
              {pending ? 'Posting…' : 'Post to ledger'}
            </Button>
          ) : null}
          <Link
            href="/journal"
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            Cancel
          </Link>
        </div>
      </div>
    </>
  );
}
