'use client';

import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useMemo, useState, useTransition } from 'react';

import { createDocumentAction } from '@/app/(app)/invoices/actions';
import * as fmt from '@/lib/format';
import { calculateDocumentTotals, calculateLine, type DiscountType } from '@/lib/line-calculator';

import { Button, Card, ErrorBanner, Field, Input, Select, TableWrap } from './ui';

export interface ContactOption {
  id: string;
  code: string;
  displayName: string;
  currencyCode: string | null;
  paymentTermsDays: number;
}

export interface AccountOption {
  id: string;
  code: string;
  name: string;
}

export interface TaxOption {
  id: string;
  code: string;
  name: string;
  ratePercent: string;
  isInclusive: boolean;
}

export interface CurrencyOption {
  code: string;
  name: string;
}

interface LineDraft {
  key: string;
  description: string;
  quantity: string;
  unitPrice: string;
  accountId: string;
  discountType: DiscountType;
  discountValue: string;
  taxId: string;
}

let lineCounter = 0;
function emptyLine(accountId = ''): LineDraft {
  lineCounter += 1;
  return {
    key: `line-${lineCounter}`,
    description: '',
    quantity: '1',
    unitPrice: '0',
    accountId,
    discountType: 'none',
    discountValue: '0',
    taxId: '',
  };
}

/**
 * Numeric fields are held as raw strings while the user types, so a half-typed
 * "1." or an empty box does not become NaN. Only the preview coerces, and it
 * treats anything unparseable as zero rather than blowing up the render.
 */
function num(value: string): string {
  const trimmed = value.trim();
  if (trimmed === '' || !Number.isFinite(Number(trimmed))) return '0';
  return trimmed;
}

/**
 * Draft entry form for a sales or purchase document.
 *
 * Totals are previewed client-side with the same calculator the server uses,
 * so what the user sees before saving matches what gets stored. The server
 * still recalculates on submit — this preview is a courtesy, not the source of
 * truth.
 */
export function DocumentForm({
  direction,
  contacts,
  accounts,
  taxes,
  currencies,
  defaultAccountId,
  baseCurrencyCode,
  currencyPrecision,
  backHref,
  backLabel,
}: {
  direction: 'outbound' | 'inbound';
  contacts: ContactOption[];
  accounts: AccountOption[];
  taxes: TaxOption[];
  currencies: CurrencyOption[];
  defaultAccountId: string;
  baseCurrencyCode: string;
  currencyPrecision: number;
  backHref: string;
  backLabel: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const isSale = direction === 'outbound';
  const documentTypes = isSale
    ? [
        { value: 'invoice', label: 'Invoice' },
        { value: 'credit_note', label: 'Credit note' },
        { value: 'quote', label: 'Quote' },
      ]
    : [
        { value: 'bill', label: 'Bill' },
        { value: 'debit_note', label: 'Debit note' },
        { value: 'purchase_order', label: 'Purchase order' },
      ];

  const [documentType, setDocumentType] = useState(documentTypes[0]!.value);
  const [contactId, setContactId] = useState('');
  const [issueDate, setIssueDate] = useState(fmt.todayISO());
  const [dueDate, setDueDate] = useState('');
  const [currencyCode, setCurrencyCode] = useState(baseCurrencyCode);
  const [reference, setReference] = useState('');
  const [notes, setNotes] = useState('');
  const [terms, setTerms] = useState('');
  const [lines, setLines] = useState<LineDraft[]>([emptyLine(defaultAccountId)]);

  const taxById = useMemo(() => new Map(taxes.map((t) => [t.id, t])), [taxes]);

  // Mirrors the server's default: the contact's terms drive the due date until
  // the user types one of their own.
  const selectedContact = contacts.find((c) => c.id === contactId);
  const effectiveDueDate = useMemo(() => {
    if (dueDate) return dueDate;
    if (!selectedContact || !issueDate) return '';
    const d = new Date(issueDate);
    if (Number.isNaN(d.getTime())) return '';
    d.setUTCDate(d.getUTCDate() + selectedContact.paymentTermsDays);
    return d.toISOString().slice(0, 10);
  }, [dueDate, issueDate, selectedContact]);

  const totals = useMemo(() => {
    const results = lines.map((line) => {
      const tax = line.taxId ? taxById.get(line.taxId) : undefined;
      return calculateLine(
        {
          quantity: num(line.quantity),
          unitPrice: num(line.unitPrice),
          discountType: line.discountType,
          discountValue: num(line.discountValue),
          taxRatePercent: tax?.ratePercent ?? '0',
          taxInclusive: tax?.isInclusive ?? false,
        },
        currencyPrecision,
      );
    });
    return { perLine: results, document: calculateDocumentTotals(results) };
  }, [lines, taxById, currencyPrecision]);

  const asMoney = (value: string) =>
    fmt.money(value, { currency: currencyCode, precision: currencyPrecision });

  const updateLine = (key: string, patch: Partial<LineDraft>) => {
    setLines((current) =>
      current.map((line) => (line.key === key ? { ...line, ...patch } : line)),
    );
  };

  const removeLine = (key: string) => {
    setLines((current) =>
      current.length === 1 ? current : current.filter((line) => line.key !== key),
    );
  };

  const canSubmit =
    contactId !== '' &&
    issueDate !== '' &&
    lines.length > 0 &&
    lines.every((line) => line.description.trim() !== '' && line.accountId !== '');

  const submit = () => {
    setError(null);
    startTransition(async () => {
      const result = await createDocumentAction({
        direction,
        documentType,
        contactId,
        issueDate,
        dueDate: dueDate || null,
        currencyCode,
        reference: reference.trim() || null,
        notes: notes.trim() || null,
        terms: terms.trim() || null,
        lines: lines.map((line) => ({
          description: line.description.trim(),
          quantity: num(line.quantity),
          unitPrice: num(line.unitPrice),
          accountId: line.accountId,
          discountType: line.discountType,
          discountValue: num(line.discountValue),
          taxId: line.taxId || null,
        })),
      });

      if (result.ok && result.id) {
        router.push(`${backHref}/${result.id}`);
      } else {
        setError(result.error ?? 'Could not save the document');
      }
    });
  };

  return (
    <>
      <div className="mb-4">
        <Link href={backHref} className="text-xs text-muted-foreground hover:text-foreground">
          ← {backLabel}
        </Link>
      </div>

      {error ? (
        <div className="mb-4">
          <ErrorBanner message={error} />
        </div>
      ) : null}

      {contacts.length === 0 ? (
        <div className="mb-4">
          <ErrorBanner
            message={
              isSale
                ? 'No customers yet. Add a customer before raising an invoice.'
                : 'No vendors yet. Add a vendor before entering a bill.'
            }
          />
        </div>
      ) : null}

      <div className="flex flex-col gap-4">
        <Card>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <Field label="Type" htmlFor="document-type">
              <Select
                id="document-type"
                value={documentType}
                onChange={(event) => setDocumentType(event.target.value)}
              >
                {documentTypes.map((type) => (
                  <option key={type.value} value={type.value}>
                    {type.label}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label={isSale ? 'Customer' : 'Vendor'} htmlFor="contact">
              <Select
                id="contact"
                value={contactId}
                onChange={(event) => {
                  const next = event.target.value;
                  setContactId(next);
                  // Follow the contact's own currency, as the server would.
                  const contact = contacts.find((c) => c.id === next);
                  if (contact?.currencyCode) setCurrencyCode(contact.currencyCode);
                }}
              >
                <option value="">Select…</option>
                {contacts.map((contact) => (
                  <option key={contact.id} value={contact.id}>
                    {contact.code} — {contact.displayName}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label="Currency" htmlFor="currency">
              <Select
                id="currency"
                value={currencyCode}
                onChange={(event) => setCurrencyCode(event.target.value)}
              >
                {currencies.map((currency) => (
                  <option key={currency.code} value={currency.code}>
                    {currency.code} — {currency.name}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label="Issue date" htmlFor="issue-date">
              <Input
                id="issue-date"
                type="date"
                value={issueDate}
                onChange={(event) => setIssueDate(event.target.value)}
              />
            </Field>

            <Field
              label="Due date"
              htmlFor="due-date"
              hint={
                !dueDate && effectiveDueDate
                  ? `Defaults to ${fmt.date(effectiveDueDate)} from payment terms`
                  : undefined
              }
            >
              <Input
                id="due-date"
                type="date"
                value={dueDate}
                onChange={(event) => setDueDate(event.target.value)}
              />
            </Field>

            <Field label="Reference" htmlFor="reference">
              <Input
                id="reference"
                value={reference}
                onChange={(event) => setReference(event.target.value)}
                placeholder={isSale ? 'Customer PO number' : 'Vendor invoice number'}
              />
            </Field>
          </div>
        </Card>

        <Card>
          <TableWrap>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th className="px-2 py-2 font-medium">Description</th>
                  <th className="px-2 py-2 font-medium">Account</th>
                  <th className="w-24 px-2 py-2 text-right font-medium">Qty</th>
                  <th className="w-32 px-2 py-2 text-right font-medium">Unit price</th>
                  <th className="w-40 px-2 py-2 font-medium">Discount</th>
                  <th className="w-40 px-2 py-2 font-medium">Tax</th>
                  <th className="w-32 px-2 py-2 text-right font-medium">Total</th>
                  <th className="w-10 px-2 py-2" />
                </tr>
              </thead>
              <tbody>
                {lines.map((line, index) => (
                  <tr key={line.key} className="border-b border-border align-top">
                    <td className="px-2 py-2">
                      <Input
                        aria-label={`Line ${index + 1} description`}
                        value={line.description}
                        onChange={(event) =>
                          updateLine(line.key, { description: event.target.value })
                        }
                        placeholder="What is being charged"
                      />
                    </td>
                    <td className="px-2 py-2">
                      <Select
                        aria-label={`Line ${index + 1} account`}
                        value={line.accountId}
                        onChange={(event) =>
                          updateLine(line.key, { accountId: event.target.value })
                        }
                      >
                        <option value="">Select…</option>
                        {accounts.map((account) => (
                          <option key={account.id} value={account.id}>
                            {account.code} — {account.name}
                          </option>
                        ))}
                      </Select>
                    </td>
                    <td className="px-2 py-2">
                      <Input
                        aria-label={`Line ${index + 1} quantity`}
                        className="text-right"
                        inputMode="decimal"
                        value={line.quantity}
                        onChange={(event) =>
                          updateLine(line.key, { quantity: event.target.value })
                        }
                      />
                    </td>
                    <td className="px-2 py-2">
                      <Input
                        aria-label={`Line ${index + 1} unit price`}
                        className="text-right"
                        inputMode="decimal"
                        value={line.unitPrice}
                        onChange={(event) =>
                          updateLine(line.key, { unitPrice: event.target.value })
                        }
                      />
                    </td>
                    <td className="px-2 py-2">
                      <div className="flex gap-1">
                        <Select
                          aria-label={`Line ${index + 1} discount type`}
                          className="w-24"
                          value={line.discountType}
                          onChange={(event) =>
                            updateLine(line.key, {
                              discountType: event.target.value as DiscountType,
                            })
                          }
                        >
                          <option value="none">None</option>
                          <option value="percent">%</option>
                          <option value="amount">Amount</option>
                        </Select>
                        {line.discountType !== 'none' ? (
                          <Input
                            aria-label={`Line ${index + 1} discount value`}
                            className="text-right"
                            inputMode="decimal"
                            value={line.discountValue}
                            onChange={(event) =>
                              updateLine(line.key, { discountValue: event.target.value })
                            }
                          />
                        ) : null}
                      </div>
                    </td>
                    <td className="px-2 py-2">
                      <Select
                        aria-label={`Line ${index + 1} tax`}
                        value={line.taxId}
                        onChange={(event) => updateLine(line.key, { taxId: event.target.value })}
                      >
                        <option value="">No tax</option>
                        {taxes.map((tax) => (
                          <option key={tax.id} value={tax.id}>
                            {tax.name} ({tax.ratePercent}%{tax.isInclusive ? ' incl.' : ''})
                          </option>
                        ))}
                      </Select>
                    </td>
                    <td className="px-2 py-2 text-right tabular-nums">
                      {asMoney(totals.perLine[index]?.lineTotal ?? '0')}
                    </td>
                    <td className="px-2 py-2 text-right">
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={`Remove line ${index + 1}`}
                        disabled={lines.length === 1}
                        onClick={() => removeLine(line.key)}
                      >
                        ✕
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>

          <div className="mt-3">
            <Button
              size="sm"
              onClick={() => setLines((current) => [...current, emptyLine(defaultAccountId)])}
            >
              Add line
            </Button>
          </div>
        </Card>

        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <div className="grid gap-4">
              <Field label="Notes" htmlFor="notes">
                <textarea
                  id="notes"
                  className="input-base h-20 py-2"
                  value={notes}
                  onChange={(event) => setNotes(event.target.value)}
                  placeholder="Visible on the document"
                />
              </Field>
              <Field label="Terms" htmlFor="terms">
                <textarea
                  id="terms"
                  className="input-base h-20 py-2"
                  value={terms}
                  onChange={(event) => setTerms(event.target.value)}
                  placeholder="Payment terms and conditions"
                />
              </Field>
            </div>
          </Card>

          <Card>
            <dl className="flex flex-col gap-2 text-sm">
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Subtotal</dt>
                <dd className="tabular-nums">{asMoney(totals.document.subtotal)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Discount</dt>
                <dd className="tabular-nums">{asMoney(totals.document.discountTotal)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Tax</dt>
                <dd className="tabular-nums">{asMoney(totals.document.taxTotal)}</dd>
              </div>
              <div className="flex justify-between border-t border-border pt-2 font-medium">
                <dt>Total</dt>
                <dd className="tabular-nums">{asMoney(totals.document.total)}</dd>
              </div>
            </dl>
          </Card>
        </div>

        <div className="flex items-center justify-end gap-2">
          <Link href={backHref}>
            <Button variant="ghost" disabled={pending}>
              Cancel
            </Button>
          </Link>
          <Button variant="primary" disabled={pending || !canSubmit} onClick={submit}>
            {pending ? 'Saving…' : 'Save draft'}
          </Button>
        </div>
      </div>
    </>
  );
}
