import Link from 'next/link';

import * as fmt from '@/lib/format';

import { ContactActions } from './contact-actions';
import { Badge, Card, PageHeader, SectionTitle, Stat, statusTone, TableWrap } from './ui';

type Aging = {
  asOf: string;
  current: string;
  days1to30: string;
  days31to60: string;
  days61to90: string;
  days90plus: string;
  total: string;
};

type Statement = {
  openingBalance: string;
  closingBalance: string;
  entries: Array<{
    date: string;
    reference: string;
    description: string;
    charge: string;
    credit: string;
    balance: string;
  }>;
  range: { from: string; to: string };
};

/**
 * Customer / vendor detail.
 *
 * Four views of the same relationship: who they are and what they owe
 * (overview), what has happened (transactions), the running account
 * (statement), and how overdue it is (aging). All four derive from the same
 * point-in-time arithmetic, so the aging total, the statement's closing
 * balance and the overview balance necessarily agree — a customer screen that
 * disagreed with the AR report would be worse than no screen.
 */
export function ContactDetail({
  contact,
  kind,
  basePath,
  balance,
  credit,
  aging,
  statement,
  transactions,
  baseCurrencyCode,
  currencyPrecision,
  canManage,
  canInvoice,
}: {
  contact: {
    id: string;
    code: string;
    displayName: string;
    legalName: string | null;
    kind: string;
    contactPerson: string | null;
    email: string | null;
    phone: string | null;
    mobile: string | null;
    website: string | null;
    taxIdentifier: string | null;
    category: string | null;
    currencyCode: string | null;
    paymentTermsDays: number;
    creditLimit: string | null;
    notes: string | null;
    isActive: boolean;
    billingAddress: unknown;
  };
  kind: 'customer' | 'vendor';
  basePath: string;
  balance: { outstanding: string; overdue: string; documentCount: number };
  credit: {
    creditLimit: string | null;
    used: string;
    available: string | null;
    isOverLimit: boolean;
  };
  aging: Aging;
  statement: Statement;
  transactions: {
    documents: Array<{
      id: string;
      date: string;
      dueDate: string | null;
      number: string;
      type: string;
      currencyCode: string;
      total: string;
      balanceDue: string;
      status: string;
    }>;
    payments: Array<{
      id: string;
      date: string;
      number: string;
      direction: string;
      amount: string;
      unappliedAmount: string;
      method: string | null;
      status: string;
    }>;
  };
  baseCurrencyCode: string;
  currencyPrecision: number;
  canManage: boolean;
  canInvoice: boolean;
}) {
  const asMoney = (value: string) =>
    fmt.money(value, { currency: baseCurrencyCode, precision: currencyPrecision });

  const address = (contact.billingAddress ?? {}) as Record<string, string>;
  const addressLines = [address.line1, address.city, address.country].filter(Boolean);
  const isCustomer = kind === 'customer';
  const documentHref = isCustomer ? '/invoices' : '/bills';

  return (
    <>
      <div className="mb-4">
        <Link href={basePath} className="text-xs text-muted-foreground hover:text-foreground">
          ← {isCustomer ? 'Customers' : 'Vendors'}
        </Link>
      </div>

      <PageHeader
        title={contact.displayName}
        description={`${contact.code}${contact.legalName ? ` · ${contact.legalName}` : ''}`}
        actions={
          <>
            {contact.kind === 'both' ? <Badge tone="accent">Customer & vendor</Badge> : null}
            {!contact.isActive ? <Badge tone="neutral">Archived</Badge> : null}
            <ContactActions
              contactId={contact.id}
              basePath={basePath}
              isActive={contact.isActive}
              canManage={canManage}
              canInvoice={canInvoice}
              documentHref={documentHref}
            />
          </>
        }
      />

      {credit.isOverLimit ? (
        <div className="mb-4 rounded-md border border-negative/30 bg-negative-subtle px-3 py-2 text-sm text-negative">
          Over their credit limit of {asMoney(credit.creditLimit!)} by{' '}
          {asMoney(credit.available!.replace('-', ''))}.
        </div>
      ) : null}

      {/* ---------------------------------------------------------- Overview */}
      <div className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label={isCustomer ? 'Outstanding (AR)' : 'Outstanding (AP)'}
          value={asMoney(balance.outstanding)}
          hint={`${balance.documentCount} open document${balance.documentCount === 1 ? '' : 's'}`}
        />
        <Stat
          label="Overdue"
          value={asMoney(balance.overdue)}
          tone={balance.overdue === '0' ? 'neutral' : 'negative'}
        />
        {isCustomer ? (
          <Stat
            label="Credit limit"
            value={credit.creditLimit ? asMoney(credit.creditLimit) : 'None set'}
          />
        ) : (
          <Stat label="Payment terms" value={`Net ${contact.paymentTermsDays}`} />
        )}
        {isCustomer ? (
          <Stat
            label="Available credit"
            value={credit.available ? asMoney(credit.available) : '—'}
            tone={credit.isOverLimit ? 'negative' : 'neutral'}
          />
        ) : (
          <Stat label="Currency" value={contact.currencyCode ?? baseCurrencyCode} />
        )}
      </div>

      <div className="mb-5 grid gap-4 lg:grid-cols-3">
        <Card>
          <SectionTitle>Details</SectionTitle>
          <dl className="space-y-1.5 text-sm">
            <Row label="Contact" value={contact.contactPerson} />
            <Row label="Email" value={contact.email} />
            <Row label="Phone" value={contact.phone} />
            <Row label="Mobile" value={contact.mobile} />
            <Row label="Website" value={contact.website} />
            <Row label="Tax / VAT" value={contact.taxIdentifier} />
            <Row label="Category" value={contact.category} />
            <Row
              label="Address"
              value={addressLines.length > 0 ? addressLines.join(', ') : null}
            />
          </dl>
        </Card>

        <Card>
          <SectionTitle>Terms</SectionTitle>
          <dl className="space-y-1.5 text-sm">
            <Row label="Currency" value={contact.currencyCode ?? baseCurrencyCode} />
            <Row label="Payment terms" value={`Net ${contact.paymentTermsDays} days`} />
            <Row
              label="Credit limit"
              value={contact.creditLimit ? asMoney(contact.creditLimit) : 'None'}
            />
            <Row label="Notes" value={contact.notes} />
          </dl>
        </Card>

        {/* -------------------------------------------------------- Aging */}
        <Card>
          <SectionTitle>Aging as at {fmt.date(aging.asOf)}</SectionTitle>
          <dl className="space-y-1.5 text-sm">
            <AgingRow label="Current" value={asMoney(aging.current)} />
            <AgingRow label="1–30 days" value={asMoney(aging.days1to30)} />
            <AgingRow label="31–60 days" value={asMoney(aging.days31to60)} />
            <AgingRow
              label="61–90 days"
              value={asMoney(aging.days61to90)}
              tone={aging.days61to90 !== '0' ? 'warning' : undefined}
            />
            <AgingRow
              label="90+ days"
              value={asMoney(aging.days90plus)}
              tone={aging.days90plus !== '0' ? 'negative' : undefined}
            />
            <div className="flex justify-between border-t border-border pt-1.5 font-medium">
              <dt>Total</dt>
              <dd className="num">{asMoney(aging.total)}</dd>
            </div>
          </dl>
        </Card>
      </div>

      {/* ----------------------------------------------------- Transactions */}
      <SectionTitle>{isCustomer ? 'Invoices & credit notes' : 'Bills & notes'}</SectionTitle>
      <TableWrap>
        <table className="w-full text-sm">
          <thead>
            <tr>
              <th className="th-base">Number</th>
              <th className="th-base">Type</th>
              <th className="th-base">Date</th>
              <th className="th-base">Due</th>
              <th className="th-base text-right">Total</th>
              <th className="th-base text-right">Balance</th>
              <th className="th-base">Status</th>
            </tr>
          </thead>
          <tbody>
            {transactions.documents.length === 0 ? (
              <tr>
                <td className="td-base text-muted-foreground" colSpan={7}>
                  Nothing raised for this {kind} yet.
                </td>
              </tr>
            ) : (
              transactions.documents.map((doc) => (
                <tr key={doc.id}>
                  <td className="td-base">
                    <Link
                      href={`${documentHref}/${doc.id}`}
                      className="font-medium text-accent hover:underline"
                    >
                      {doc.number}
                    </Link>
                  </td>
                  <td className="td-base text-muted-foreground">
                    {fmt.humanise(doc.type)}
                  </td>
                  <td className="td-base text-muted-foreground">{fmt.date(doc.date)}</td>
                  <td className="td-base text-muted-foreground">
                    {doc.dueDate ? fmt.date(doc.dueDate) : '—'}
                  </td>
                  <td className="td-base num text-right">{asMoney(doc.total)}</td>
                  <td className="td-base num text-right">{asMoney(doc.balanceDue)}</td>
                  <td className="td-base">
                    <Badge tone={statusTone(doc.status)}>{fmt.humanise(doc.status)}</Badge>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </TableWrap>

      <div className="mt-5">
        <SectionTitle>{isCustomer ? 'Receipts' : 'Payments'}</SectionTitle>
        <TableWrap>
          <table className="w-full text-sm">
            <thead>
              <tr>
                <th className="th-base">Number</th>
                <th className="th-base">Date</th>
                <th className="th-base">Method</th>
                <th className="th-base text-right">Amount</th>
                <th className="th-base text-right">Unapplied</th>
                <th className="th-base">Status</th>
              </tr>
            </thead>
            <tbody>
              {transactions.payments.length === 0 ? (
                <tr>
                  <td className="td-base text-muted-foreground" colSpan={6}>
                    No {isCustomer ? 'receipts' : 'payments'} recorded.
                  </td>
                </tr>
              ) : (
                transactions.payments.map((payment) => (
                  <tr key={payment.id}>
                    <td className="td-base font-medium">{payment.number}</td>
                    <td className="td-base text-muted-foreground">
                      {fmt.date(payment.date)}
                    </td>
                    <td className="td-base text-muted-foreground">
                      {payment.method ? fmt.humanise(payment.method) : '—'}
                    </td>
                    <td className="td-base num text-right">{asMoney(payment.amount)}</td>
                    <td className="td-base num text-right">
                      <span
                        className={
                          payment.unappliedAmount === '0'
                            ? 'text-muted-foreground'
                            : 'text-warning'
                        }
                      >
                        {asMoney(payment.unappliedAmount)}
                      </span>
                    </td>
                    <td className="td-base">
                      <Badge tone={statusTone(payment.status)}>
                        {fmt.humanise(payment.status)}
                      </Badge>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </TableWrap>
      </div>

      {/* -------------------------------------------------------- Statement */}
      <div className="mt-5">
        <SectionTitle>
          Statement · {fmt.date(statement.range.from)} — {fmt.date(statement.range.to)}
        </SectionTitle>
        <TableWrap>
          <table className="w-full text-sm">
            <thead>
              <tr>
                <th className="th-base">Date</th>
                <th className="th-base">Reference</th>
                <th className="th-base">Description</th>
                <th className="th-base text-right">Debit</th>
                <th className="th-base text-right">Credit</th>
                <th className="th-base text-right">Balance</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="td-base text-muted-foreground" colSpan={5}>
                  Opening balance
                </td>
                <td className="td-base num text-right font-medium">
                  {asMoney(statement.openingBalance)}
                </td>
              </tr>
              {statement.entries.map((entry, index) => (
                <tr key={`${entry.reference}-${index}`}>
                  <td className="td-base text-muted-foreground">{fmt.date(entry.date)}</td>
                  <td className="td-base">{entry.reference}</td>
                  <td className="td-base text-muted-foreground">
                    {fmt.humanise(entry.description)}
                  </td>
                  <td className="td-base num text-right">
                    {entry.charge !== '0' ? asMoney(entry.charge) : ''}
                  </td>
                  <td className="td-base num text-right">
                    {entry.credit !== '0' ? asMoney(entry.credit) : ''}
                  </td>
                  <td className="td-base num text-right">{asMoney(entry.balance)}</td>
                </tr>
              ))}
              <tr>
                <td className="td-base font-medium" colSpan={5}>
                  Closing balance
                </td>
                <td className="td-base num text-right font-medium">
                  {asMoney(statement.closingBalance)}
                </td>
              </tr>
            </tbody>
          </table>
        </TableWrap>
      </div>
    </>
  );
}

function Row({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right">{value || '—'}</dd>
    </div>
  );
}

function AgingRow({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: 'warning' | 'negative';
}) {
  return (
    <div className="flex justify-between">
      <dt className="text-muted-foreground">{label}</dt>
      <dd
        className={`num ${
          tone === 'negative' ? 'text-negative' : tone === 'warning' ? 'text-warning' : ''
        }`}
      >
        {value}
      </dd>
    </div>
  );
}
