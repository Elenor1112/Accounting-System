import Link from 'next/link';

import * as fmt from '@/lib/format';
import { PERMISSIONS } from '@/server/auth/permissions';

import { DocumentActions } from './document-actions';
import { Badge, Card, SectionTitle, statusTone, TableWrap } from './ui';

interface DocumentShape {
  id: string;
  documentNumber: string;
  documentType: string;
  direction: string;
  issueDate: string;
  dueDate: string | null;
  currencyCode: string;
  exchangeRate: string;
  subtotal: string;
  discountTotal: string;
  taxTotal: string;
  total: string;
  amountPaid: string;
  balanceDue: string;
  status: string;
  reference: string | null;
  notes: string | null;
  terms: string | null;
  journalEntryId: string | null;
}

interface LineShape {
  id: string;
  lineNumber: number;
  description: string;
  quantity: string;
  unitPrice: string;
  discountAmount: string;
  taxRatePercent: string;
  taxAmount: string;
  lineSubtotal: string;
  lineTotal: string;
}

interface ContactShape {
  id: string;
  displayName: string;
  email: string | null;
  code: string;
}

export function DocumentDetail({
  document,
  lines,
  contact,
  ctx,
  backHref,
  backLabel,
}: {
  document: DocumentShape;
  lines: LineShape[];
  contact: ContactShape | undefined;
  ctx: {
    baseCurrencyCode: string;
    currencyPrecision: number;
    companyName: string;
    permissions: string[];
  };
  backHref: string;
  backLabel: string;
}) {
  const currency = document.currencyCode;
  const precision = ctx.currencyPrecision;
  const asMoney = (value: string) => fmt.money(value, { currency, precision });

  const isSale = document.direction === 'outbound';
  const can = (permission: string) =>
    ctx.permissions.includes('*') || ctx.permissions.includes(permission);

  const isForeignCurrency = currency !== ctx.baseCurrencyCode;

  return (
    <>
      <div className="mb-4">
        <Link href={backHref} className="text-xs text-muted-foreground hover:text-foreground">
          ← {backLabel}
        </Link>
      </div>

      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2.5">
            <h1 className="text-xl font-semibold tracking-tight">{document.documentNumber}</h1>
            <Badge tone={statusTone(document.status)}>{fmt.humanise(document.status)}</Badge>
          </div>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {fmt.humanise(document.documentType)} · {contact?.displayName ?? 'Unknown contact'}
          </p>
        </div>

        <DocumentActions
          documentId={document.id}
          status={document.status}
          isPosted={Boolean(document.journalEntryId)}
          documentType={document.documentType}
          isSale={isSale}
          canApprove={can(isSale ? PERMISSIONS.invoices.approve : PERMISSIONS.bills.approve)}
          canSend={can(PERMISSIONS.invoices.send)}
          hasPayments={Number(document.amountPaid) > 0}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <TableWrap>
            <table className="data-table">
              <thead>
                <tr>
                  <th style={{ width: '40%' }}>Description</th>
                  <th className="text-right">Qty</th>
                  <th className="text-right">Unit price</th>
                  <th className="text-right">Discount</th>
                  <th className="text-right">Tax</th>
                  <th className="text-right">Amount</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((line) => (
                  <tr key={line.id}>
                    <td className="text-foreground">{line.description}</td>
                    <td className="num text-muted-foreground">{line.quantity}</td>
                    <td className="num">{asMoney(line.unitPrice)}</td>
                    <td className="num text-muted-foreground">
                      {Number(line.discountAmount) > 0 ? `−${asMoney(line.discountAmount)}` : '—'}
                    </td>
                    <td className="num text-muted-foreground">
                      {Number(line.taxRatePercent) > 0
                        ? `${asMoney(line.taxAmount)} (${Number(line.taxRatePercent)}%)`
                        : '—'}
                    </td>
                    <td className="num font-medium">{asMoney(line.lineTotal)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>

          {document.notes || document.terms ? (
            <Card>
              {document.notes ? (
                <>
                  <SectionTitle>Notes</SectionTitle>
                  <p className="mb-3 whitespace-pre-wrap text-sm text-muted-foreground">
                    {document.notes}
                  </p>
                </>
              ) : null}
              {document.terms ? (
                <>
                  <SectionTitle>Terms</SectionTitle>
                  <p className="whitespace-pre-wrap text-sm text-muted-foreground">
                    {document.terms}
                  </p>
                </>
              ) : null}
            </Card>
          ) : null}
        </div>

        <div className="space-y-4">
          <Card>
            <SectionTitle>Summary</SectionTitle>
            <dl className="space-y-1.5 text-sm">
              <Row label="Subtotal" value={asMoney(document.subtotal)} />
              {Number(document.discountTotal) > 0 ? (
                <Row label="Discount" value={`−${asMoney(document.discountTotal)}`} />
              ) : null}
              {Number(document.taxTotal) > 0 ? (
                <Row label="Tax" value={asMoney(document.taxTotal)} />
              ) : null}
              <div className="!mt-2 border-t border-border pt-2">
                <Row label="Total" value={asMoney(document.total)} strong />
              </div>
              <Row label="Paid" value={asMoney(document.amountPaid)} muted />
              <div className="!mt-2 border-t border-border pt-2">
                <Row
                  label="Balance due"
                  value={asMoney(document.balanceDue)}
                  strong
                  tone={Number(document.balanceDue) > 0 ? 'negative' : 'positive'}
                />
              </div>
            </dl>

            {isForeignCurrency ? (
              // The original currency is never overwritten by its conversion,
              // so both are shown (spec §18).
              <p className="mt-3 border-t border-border pt-2 text-xs text-subtle-foreground">
                Recorded in {currency} at {Number(document.exchangeRate)} ={' '}
                {fmt.money(
                  String(Number(document.total) * Number(document.exchangeRate)),
                  { currency: ctx.baseCurrencyCode, precision },
                )}
              </p>
            ) : null}
          </Card>

          <Card>
            <SectionTitle>Details</SectionTitle>
            <dl className="space-y-1.5 text-sm">
              <Row label="Issue date" value={fmt.date(document.issueDate)} muted />
              <Row label="Due date" value={fmt.date(document.dueDate)} muted />
              <Row label={isSale ? 'Customer' : 'Vendor'} value={contact?.displayName ?? '—'} muted />
              {document.reference ? (
                <Row label="Reference" value={document.reference} muted />
              ) : null}
              <Row label="Currency" value={currency} muted />
            </dl>

            {document.journalEntryId ? (
              <Link
                href={`/journal/${document.journalEntryId}`}
                className="mt-3 block border-t border-border pt-2 text-xs font-medium text-accent hover:underline"
              >
                View journal entry →
              </Link>
            ) : (
              <p className="mt-3 border-t border-border pt-2 text-xs text-subtle-foreground">
                Not yet posted to the ledger.
              </p>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}

function Row({
  label,
  value,
  strong,
  muted,
  tone,
}: {
  label: string;
  value: string;
  strong?: boolean;
  muted?: boolean;
  tone?: 'positive' | 'negative';
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd
        className={[
          'tabular',
          strong ? 'font-semibold text-foreground' : '',
          muted && !strong ? 'text-muted-foreground' : '',
          tone === 'negative' ? 'text-negative' : '',
          tone === 'positive' ? 'text-positive' : '',
        ]
          .filter(Boolean)
          .join(' ')}
      >
        {value}
      </dd>
    </div>
  );
}
