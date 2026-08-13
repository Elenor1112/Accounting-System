import 'server-only';

import { and, asc, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';

import { db, type Tx } from '@/db';
import { contacts, documents, journalEntries, journalLines, payments } from '@/db/schema';
import { requirePermission, type TenantContext } from '@/server/auth/context';
import { PERMISSIONS } from '@/server/auth/permissions';
import { ConflictError, NotFoundError, ValidationError } from '@/server/errors';
import { add, money, subtract, type Money } from '@/lib/money';

import { recordAudit, diffValues } from './audit-service';
import { allocateDocumentNumber } from './numbering-service';

export type ContactRow = typeof contacts.$inferSelect;
export type ContactKind = 'customer' | 'vendor' | 'both';

/**
 * Next sequential contact code, e.g. `CUST-0007`.
 *
 * Allocated through the numbering service — which takes its counter row
 * `FOR UPDATE` — rather than by counting existing rows. Counting is racy: two
 * concurrent creates both read the same count and generate the same code, and
 * the unique index then rejects the loser after the user has filled in a form.
 */
async function nextContactCode(
  tx: Tx,
  companyId: string,
  kind: ContactKind,
): Promise<string> {
  return allocateDocumentNumber(tx, {
    companyId,
    documentType: kind === 'vendor' ? 'vendor' : 'customer',
  });
}

export async function createContact(
  ctx: TenantContext,
  input: {
    kind: ContactKind;
    displayName: string;
    legalName?: string | null;
    contactPerson?: string | null;
    email?: string | null;
    phone?: string | null;
    mobile?: string | null;
    website?: string | null;
    taxIdentifier?: string | null;
    category?: string | null;
    currencyCode?: string | null;
    paymentTermsDays?: number;
    creditLimit?: Money | null;
    billingAddress?: Record<string, unknown>;
    shippingAddress?: Record<string, unknown>;
    notes?: string | null;
    code?: string;
  },
): Promise<ContactRow> {
  requirePermission(ctx, PERMISSIONS.contacts.manage);

  if (!input.displayName?.trim()) {
    throw new ValidationError('A customer or vendor needs a name');
  }

  return db.transaction(async (tx) => {
    const code = input.code ?? (await nextContactCode(tx, ctx.companyId, input.kind));

    const [created] = await tx
      .insert(contacts)
      .values({
        companyId: ctx.companyId,
        kind: input.kind,
        code,
        displayName: input.displayName.trim(),
        legalName: input.legalName ?? null,
        contactPerson: input.contactPerson ?? null,
        email: input.email ?? null,
        phone: input.phone ?? null,
        mobile: input.mobile ?? null,
        website: input.website ?? null,
        taxIdentifier: input.taxIdentifier ?? null,
        category: input.category ?? null,
        currencyCode: input.currencyCode ?? null,
        paymentTermsDays: input.paymentTermsDays ?? 30,
        creditLimit: input.creditLimit ?? null,
        billingAddress: input.billingAddress ?? {},
        shippingAddress: input.shippingAddress ?? {},
        notes: input.notes ?? null,
      })
      .returning();

    if (!created) throw new ConflictError(`A contact with code ${code} already exists`);

    await recordAudit(tx, ctx, {
      action: 'contact.created',
      entityType: 'contact',
      entityId: created.id,
      newValues: { code, displayName: created.displayName, kind: created.kind },
    });

    return created;
  });
}

export async function updateContact(
  ctx: TenantContext,
  contactId: string,
  updates: Partial<
    Pick<
      ContactRow,
      | 'displayName'
      | 'legalName'
      | 'contactPerson'
      | 'email'
      | 'phone'
      | 'mobile'
      | 'website'
      | 'taxIdentifier'
      | 'category'
      | 'kind'
      | 'currencyCode'
      | 'paymentTermsDays'
      | 'creditLimit'
      | 'billingAddress'
      | 'shippingAddress'
      | 'notes'
      | 'isActive'
    >
  >,
): Promise<ContactRow> {
  requirePermission(ctx, PERMISSIONS.contacts.manage);

  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(contacts)
      .where(and(eq(contacts.id, contactId), eq(contacts.companyId, ctx.companyId)))
      .limit(1);

    if (!existing) throw new NotFoundError('Contact');

    const diff = diffValues(existing as Record<string, unknown>, updates);

    const [updated] = await tx
      .update(contacts)
      .set({ ...updates, updatedAt: sql`now()` })
      .where(eq(contacts.id, contactId))
      .returning();

    if (!updated) throw new ConflictError('Failed to update contact');

    if (diff) {
      await recordAudit(tx, ctx, {
        action: 'contact.updated',
        entityType: 'contact',
        entityId: contactId,
        ...diff,
      });
    }
    return updated;
  });
}

export async function listContacts(
  ctx: TenantContext,
  filters: {
    kind?: ContactKind;
    search?: string;
    includeInactive?: boolean;
    category?: string;
    limit?: number;
    offset?: number;
  } = {},
) {
  requirePermission(ctx, PERMISSIONS.contacts.view);

  const conditions = [eq(contacts.companyId, ctx.companyId)];
  if (!filters.includeInactive) conditions.push(eq(contacts.isActive, true));
  if (filters.kind) {
    // A contact marked `both` must appear in customer and vendor lists alike.
    conditions.push(inArray(contacts.kind, [filters.kind, 'both']));
  }
  if (filters.category) conditions.push(eq(contacts.category, filters.category));
  if (filters.search) {
    const term = `%${filters.search.toLowerCase()}%`;
    conditions.push(
      sql`(lower(${contacts.displayName}) like ${term}
        or lower(${contacts.code}) like ${term}
        or lower(coalesce(${contacts.email}, '')) like ${term}
        or lower(coalesce(${contacts.phone}, '')) like ${term}
        or lower(coalesce(${contacts.contactPerson}, '')) like ${term})`,
    );
  }

  return db
    .select()
    .from(contacts)
    .where(and(...conditions))
    .orderBy(asc(contacts.displayName))
    .limit(filters.limit ?? 50)
    .offset(filters.offset ?? 0);
}

/**
 * The customer/vendor list screen: identity plus the outstanding balance and
 * credit position, in one query.
 *
 * The balance is reconstructed from documents and posted allocations rather
 * than read from a stored figure, so a list row and the aging report can never
 * disagree — they are the same arithmetic (see `getContactBalance`). Doing it
 * in SQL keeps a company with 5,000 customers from shipping every document to
 * the application to be summed.
 */
export async function listContactsWithBalances(
  ctx: TenantContext,
  filters: {
    kind?: ContactKind;
    search?: string;
    includeInactive?: boolean;
    category?: string;
    sort?: 'name' | 'code' | 'balance';
    limit?: number;
    offset?: number;
  } = {},
) {
  requirePermission(ctx, PERMISSIONS.contacts.view);

  const asOf = new Date().toISOString().slice(0, 10);
  const isVendorList = filters.kind === 'vendor';
  const direction = isVendorList ? 'inbound' : 'outbound';

  const conditions = [eq(contacts.companyId, ctx.companyId)];
  if (!filters.includeInactive) conditions.push(eq(contacts.isActive, true));
  if (filters.kind) conditions.push(inArray(contacts.kind, [filters.kind, 'both']));
  if (filters.category) conditions.push(eq(contacts.category, filters.category));
  if (filters.search) {
    const term = `%${filters.search.toLowerCase()}%`;
    conditions.push(
      sql`(lower(${contacts.displayName}) like ${term}
        or lower(${contacts.code}) like ${term}
        or lower(coalesce(${contacts.email}, '')) like ${term}
        or lower(coalesce(${contacts.phone}, '')) like ${term}
        or lower(coalesce(${contacts.contactPerson}, '')) like ${term})`,
    );
  }

  /**
   * Correlated subqueries against the outer `contacts` row.
   *
   * The outer column is written as a literal `contacts.id` rather than
   * interpolating the Drizzle column: Drizzle renders `${contacts.id}` as a
   * bare `"id"`, which Postgres resolves against the *subquery's* scope
   * (`documents`) instead of the outer table — so every contact silently
   * reported a zero balance while the detail screen showed the real figure.
   */
  const outstanding = sql<string>`coalesce((
    select sum(d.total - coalesce((
      select sum(pa.amount_applied)
        from payment_allocations pa
        join payments p on p.id = pa.payment_id
       where pa.document_id = d.id
         and p.status = 'posted'
         and p.payment_date <= ${asOf}::date
    ), 0))
      from documents d
     where d.contact_id = contacts.id
       and d.company_id = ${ctx.companyId}
       and d.direction = ${direction}
       and d.journal_entry_id is not null
       and d.status not in ('void', 'cancelled', 'draft', 'pending_approval', 'written_off')
       and d.issue_date <= ${asOf}::date
  ), 0)`;

  const overdue = sql<string>`coalesce((
    select sum(d.total - coalesce((
      select sum(pa.amount_applied)
        from payment_allocations pa
        join payments p on p.id = pa.payment_id
       where pa.document_id = d.id
         and p.status = 'posted'
         and p.payment_date <= ${asOf}::date
    ), 0))
      from documents d
     where d.contact_id = contacts.id
       and d.company_id = ${ctx.companyId}
       and d.direction = ${direction}
       and d.journal_entry_id is not null
       and d.status not in ('void', 'cancelled', 'draft', 'pending_approval', 'written_off')
       and d.issue_date <= ${asOf}::date
       and d.due_date < ${asOf}::date
  ), 0)`;

  const orderBy =
    filters.sort === 'code'
      ? asc(contacts.code)
      : filters.sort === 'balance'
        ? sql`${outstanding} desc`
        : asc(contacts.displayName);

  const rows = await db
    .select({
      id: contacts.id,
      code: contacts.code,
      kind: contacts.kind,
      displayName: contacts.displayName,
      legalName: contacts.legalName,
      contactPerson: contacts.contactPerson,
      email: contacts.email,
      phone: contacts.phone,
      category: contacts.category,
      currencyCode: contacts.currencyCode,
      paymentTermsDays: contacts.paymentTermsDays,
      creditLimit: contacts.creditLimit,
      isActive: contacts.isActive,
      outstanding,
      overdue,
    })
    .from(contacts)
    .where(and(...conditions))
    .orderBy(orderBy)
    .limit(filters.limit ?? 50)
    .offset(filters.offset ?? 0);

  // Postgres returns `numeric` as an unnormalised string ("3300.000000");
  // canonicalising here means a list row and a detail page render identically.
  return rows.map((row) => ({
    ...row,
    outstanding: money(row.outstanding),
    overdue: money(row.overdue),
  }));
}

export async function getContact(ctx: TenantContext, contactId: string): Promise<ContactRow> {
  requirePermission(ctx, PERMISSIONS.contacts.view);

  const [contact] = await db
    .select()
    .from(contacts)
    .where(and(eq(contacts.id, contactId), eq(contacts.companyId, ctx.companyId)))
    .limit(1);

  if (!contact) throw new NotFoundError('Contact');
  return contact;
}

/**
 * A contact's outstanding balance, summed from their open documents.
 *
 * Read from documents rather than from the AR control account because the
 * control account aggregates every customer; this is the per-customer split
 * the statement and aging report need.
 */
export async function getContactBalance(
  ctx: TenantContext,
  contactId: string,
  options: { asOf?: string } = {},
): Promise<{ outstanding: Money; overdue: Money; documentCount: number }> {
  const asOf = options.asOf ?? new Date().toISOString().slice(0, 10);

  // Same point-in-time reconstruction as the aging report, so a customer's
  // balance and their aging total always agree — they are the same arithmetic.
  const paidAsOf = sql<string>`coalesce((
    select sum(pa.amount_applied)
      from payment_allocations pa
      join payments p on p.id = pa.payment_id
     where pa.document_id = ${documents.id}
       and pa.company_id = ${ctx.companyId}
       and p.status = 'posted'
       and p.payment_date <= ${asOf}::date
  ), 0)`;

  const rows = await db
    .select({
      balanceDue: sql<string>`(${documents.total} - ${paidAsOf})`,
      dueDate: documents.dueDate,
    })
    .from(documents)
    .where(
      and(
        eq(documents.companyId, ctx.companyId),
        eq(documents.contactId, contactId),
        sql`${documents.issueDate} <= ${asOf}::date`,
        isNotNull(documents.journalEntryId),
        sql`${documents.status} not in ('void', 'cancelled', 'draft', 'pending_approval')`,
        sql`(${documents.total} - ${paidAsOf}) > 0`,
      ),
    );

  let outstanding = '0';
  let overdue = '0';
  for (const row of rows) {
    outstanding = add(outstanding, row.balanceDue);
    if (row.dueDate && row.dueDate < asOf) overdue = add(overdue, row.balanceDue);
  }

  return { outstanding, overdue, documentCount: rows.length };
}

/**
 * Customer/vendor statement (spec §12):
 *   opening balance + invoices − payments = closing balance
 *
 * Built from the documents and payments themselves rather than from ledger
 * lines, so each row is the document the customer recognises.
 */
export async function getContactStatement(
  ctx: TenantContext,
  contactId: string,
  range: { from: string; to: string },
) {
  requirePermission(ctx, PERMISSIONS.reports.view);

  const contact = await getContact(ctx, contactId);
  const isCustomer = contact.kind !== 'vendor';

  const documentRows = await db
    .select({
      id: documents.id,
      date: documents.issueDate,
      number: documents.documentNumber,
      type: documents.documentType,
      total: documents.total,
      balanceDue: documents.balanceDue,
      dueDate: documents.dueDate,
    })
    .from(documents)
    .where(
      and(
        eq(documents.companyId, ctx.companyId),
        eq(documents.contactId, contactId),
        // Posted documents only; `paid` and `overdue` are payment states, so a
        // filter on status alone would drop a settled invoice from the history
        // the statement is supposed to show.
        isNotNull(documents.journalEntryId),
        sql`${documents.status} not in ('void', 'cancelled', 'draft', 'pending_approval')`,
      ),
    )
    .orderBy(asc(documents.issueDate));

  /**
   * Payments credited at the amount *allocated to this contact's documents*,
   * plus any unapplied residue on their own payments.
   *
   * The statement previously credited each payment's full `amount`, which is
   * wrong whenever a receipt was split across contacts or left partly
   * unapplied: the running balance then disagreed with the sum of the open
   * invoices it was supposed to explain.
   */
  const paymentRows = await db
    .select({
      id: payments.id,
      date: payments.paymentDate,
      number: payments.paymentNumber,
      // Table-qualified literals, not interpolated Drizzle columns: inside a
      // correlated subquery Drizzle renders `${payments.id}` as a bare "id",
      // which Postgres binds to the subquery's own scope rather than the outer
      // payments row.
      amount: sql<string>`(
        coalesce((
          select sum(pa.amount_applied)
            from payment_allocations pa
            join documents d on d.id = pa.document_id
           where pa.payment_id = payments.id
             and d.contact_id = ${contactId}
        ), 0)
        + case when payments.contact_id = ${contactId}
               then payments.unapplied_amount else 0 end
      )`,
    })
    .from(payments)
    .where(
      and(
        eq(payments.companyId, ctx.companyId),
        eq(payments.status, 'posted'),
        // Either the payment is theirs, or it settled one of their documents.
        sql`(
          ${payments.contactId} = ${contactId}
          or exists (
            select 1 from payment_allocations pa
              join documents d on d.id = pa.document_id
             where pa.payment_id = payments.id and d.contact_id = ${contactId}
          )
        )`,
      ),
    )
    .orderBy(asc(payments.paymentDate));

  type Entry = {
    date: string;
    reference: string;
    description: string;
    charge: Money;
    credit: Money;
    balance: Money;
  };

  // Everything before `from` collapses into a single opening balance.
  let openingBalance = '0';
  const withinRange: Array<Omit<Entry, 'balance'>> = [];

  for (const doc of documentRows) {
    const isCredit = doc.type === 'credit_note' || doc.type === 'debit_note';
    const charge = isCredit ? '0' : doc.total;
    const credit = isCredit ? doc.total : '0';

    if (doc.date < range.from) {
      openingBalance = add(openingBalance, subtract(charge, credit));
    } else if (doc.date <= range.to) {
      withinRange.push({
        date: doc.date,
        reference: doc.number,
        description: doc.type.replace('_', ' '),
        charge,
        credit,
      });
    }
  }

  for (const payment of paymentRows) {
    if (payment.date < range.from) {
      openingBalance = subtract(openingBalance, payment.amount);
    } else if (payment.date <= range.to) {
      withinRange.push({
        date: payment.date,
        reference: payment.number,
        description: 'Payment',
        charge: '0',
        credit: payment.amount,
      });
    }
  }

  withinRange.sort((a, b) => a.date.localeCompare(b.date));

  let running = openingBalance;
  const entries: Entry[] = withinRange.map((row) => {
    running = add(running, subtract(row.charge, row.credit));
    return { ...row, balance: running };
  });

  return {
    contact,
    isCustomer,
    openingBalance,
    closingBalance: running,
    entries,
    range,
  };
}

/**
 * Aging for one contact, bucketed as at a date.
 *
 * Same point-in-time reconstruction as the company-wide report, restricted to
 * a single party — this is what the customer detail screen shows, and it must
 * agree with that customer's row in the AR aging.
 */
export async function getContactAging(
  ctx: TenantContext,
  contactId: string,
  params: { asOf?: string } = {},
): Promise<{
  asOf: string;
  current: Money;
  days1to30: Money;
  days31to60: Money;
  days61to90: Money;
  days90plus: Money;
  total: Money;
}> {
  requirePermission(ctx, PERMISSIONS.contacts.view);

  const asOf = params.asOf ?? new Date().toISOString().slice(0, 10);
  const daysOverdue = sql`(${asOf}::date - ${documents.dueDate}::date)`;

  const paidAsOf = sql<string>`coalesce((
    select sum(pa.amount_applied)
      from payment_allocations pa
      join payments p on p.id = pa.payment_id
     where pa.document_id = ${documents.id}
       and p.status = 'posted'
       and p.payment_date <= ${asOf}::date
  ), 0)`;
  const balanceAsOf = sql`(${documents.total} - ${paidAsOf})`;

  const [row] = await db
    .select({
      current: sql<string>`coalesce(sum(case when ${daysOverdue} <= 0 then ${balanceAsOf} else 0 end), 0)`,
      days1to30: sql<string>`coalesce(sum(case when ${daysOverdue} between 1 and 30 then ${balanceAsOf} else 0 end), 0)`,
      days31to60: sql<string>`coalesce(sum(case when ${daysOverdue} between 31 and 60 then ${balanceAsOf} else 0 end), 0)`,
      days61to90: sql<string>`coalesce(sum(case when ${daysOverdue} between 61 and 90 then ${balanceAsOf} else 0 end), 0)`,
      days90plus: sql<string>`coalesce(sum(case when ${daysOverdue} > 90 then ${balanceAsOf} else 0 end), 0)`,
      total: sql<string>`coalesce(sum(${balanceAsOf}), 0)`,
    })
    .from(documents)
    .where(
      and(
        eq(documents.companyId, ctx.companyId),
        eq(documents.contactId, contactId),
        sql`${documents.issueDate} <= ${asOf}::date`,
        isNotNull(documents.journalEntryId),
        sql`${documents.status} not in ('void', 'cancelled', 'draft', 'pending_approval', 'written_off')`,
        sql`(${documents.total} - ${paidAsOf}) > 0`,
      ),
    );

  return {
    asOf,
    current: money(row?.current ?? '0'),
    days1to30: money(row?.days1to30 ?? '0'),
    days31to60: money(row?.days31to60 ?? '0'),
    days61to90: money(row?.days61to90 ?? '0'),
    days90plus: money(row?.days90plus ?? '0'),
    total: money(row?.total ?? '0'),
  };
}

/**
 * Everything financial that has happened with this contact: documents and
 * payments, newest first. The Transactions tab of the detail screen.
 */
export async function getContactTransactions(
  ctx: TenantContext,
  contactId: string,
  options: { limit?: number } = {},
) {
  requirePermission(ctx, PERMISSIONS.contacts.view);

  const limit = options.limit ?? 100;

  const documentRows = await db
    .select({
      id: documents.id,
      kind: sql<string>`'document'`,
      date: documents.issueDate,
      dueDate: documents.dueDate,
      number: documents.documentNumber,
      type: documents.documentType,
      direction: documents.direction,
      currencyCode: documents.currencyCode,
      total: documents.total,
      balanceDue: documents.balanceDue,
      status: documents.status,
    })
    .from(documents)
    .where(
      and(
        eq(documents.companyId, ctx.companyId),
        eq(documents.contactId, contactId),
        // Drafts are included here on purpose: unlike the aging report, this
        // is a working view of the relationship, and a user needs to see the
        // draft invoice they are about to send.
        sql`${documents.status} <> 'cancelled'`,
      ),
    )
    .orderBy(desc(documents.issueDate))
    .limit(limit);

  const paymentRows = await db
    .select({
      id: payments.id,
      kind: sql<string>`'payment'`,
      date: payments.paymentDate,
      number: payments.paymentNumber,
      direction: payments.direction,
      currencyCode: payments.currencyCode,
      amount: payments.amount,
      allocatedAmount: payments.allocatedAmount,
      unappliedAmount: payments.unappliedAmount,
      status: payments.status,
      method: payments.method,
    })
    .from(payments)
    .where(
      and(
        eq(payments.companyId, ctx.companyId),
        eq(payments.contactId, contactId),
        sql`${payments.status} <> 'void'`,
      ),
    )
    .orderBy(desc(payments.paymentDate))
    .limit(limit);

  return { documents: documentRows, payments: paymentRows };
}

/**
 * Credit position for a customer: limit, used, and what remains.
 *
 * The credit limit field existed and was never enforced or even displayed;
 * this at least surfaces it, so a user can see a customer is over their limit
 * before raising another invoice.
 */
export async function getCreditPosition(
  ctx: TenantContext,
  contactId: string,
): Promise<{
  creditLimit: Money | null;
  used: Money;
  available: Money | null;
  isOverLimit: boolean;
}> {
  const contact = await getContact(ctx, contactId);
  const balance = await getContactBalance(ctx, contactId);
  const used = money(balance.outstanding);

  if (!contact.creditLimit) {
    return { creditLimit: null, used, available: null, isOverLimit: false };
  }

  const available = subtract(contact.creditLimit, used);
  return {
    creditLimit: money(contact.creditLimit),
    used,
    available,
    isOverLimit: available.startsWith('-'),
  };
}

export async function archiveContact(ctx: TenantContext, contactId: string): Promise<void> {
  requirePermission(ctx, PERMISSIONS.contacts.manage);

  const balance = await getContactBalance(ctx, contactId);
  if (money(balance.outstanding) !== '0') {
    throw new ConflictError(
      `This contact has ${balance.outstanding} outstanding across ${balance.documentCount} document(s) ` +
        'and cannot be deactivated until those are settled or voided.',
    );
  }

  await db.transaction(async (tx) => {
    await tx
      .update(contacts)
      .set({ isActive: false, updatedAt: sql`now()` })
      .where(and(eq(contacts.id, contactId), eq(contacts.companyId, ctx.companyId)));

    await recordAudit(tx, ctx, {
      action: 'contact.archived',
      entityType: 'contact',
      entityId: contactId,
    });
  });
}

/**
 * Aging buckets for AR or AP (spec §12), as at a point in time.
 *
 * The balance of each document is reconstructed *as at `asOf`* rather than
 * read from the stored `balanceDue`:
 *
 *     balance(asOf) = total − allocations from payments dated on or before asOf
 *
 * The previous implementation used `asOf` only for the bucket arithmetic while
 * summing today's `balanceDue`, so "AR aging as at 30 June" run in August
 * showed June's bucket boundaries against August's balances: invoices settled
 * in July had vanished, and invoices raised in July were included. The result
 * reconciled to nothing — not to June's AR control account, and not to any
 * provision computed from it.
 *
 * Documents issued after `asOf` are excluded, and voided/cancelled documents
 * are excluded outright. Still one grouped SQL query, so a company with 10,000
 * open invoices does not ship them all to the application to be summed.
 */
export async function getAgingReport(
  ctx: TenantContext,
  params: { direction: 'outbound' | 'inbound'; asOf?: string },
) {
  requirePermission(ctx, PERMISSIONS.reports.view);

  const asOf = params.asOf ?? new Date().toISOString().slice(0, 10);
  const daysOverdue = sql`(${asOf}::date - ${documents.dueDate}::date)`;

  /**
   * Allocations settled on or before `asOf`, per document.
   *
   * Correlated against the payment's *date*, not the allocation row's creation
   * timestamp: a payment recorded late but dated in June belongs in June's
   * aging. Void payments are excluded — voiding removes the settlement, so the
   * invoice must reappear as outstanding.
   */
  const paidAsOf = sql<string>`coalesce((
    select sum(pa.amount_applied)
      from payment_allocations pa
      join payments p on p.id = pa.payment_id
     where pa.document_id = ${documents.id}
       and pa.company_id = ${ctx.companyId}
       and p.status = 'posted'
       and p.payment_date <= ${asOf}::date
  ), 0)`;

  const balanceAsOf = sql`(${documents.total} - ${paidAsOf})`;

  return db
    .select({
      contactId: documents.contactId,
      contactName: contacts.displayName,
      current: sql<string>`coalesce(sum(case when ${daysOverdue} <= 0 then ${balanceAsOf} else 0 end), 0)`,
      days1to30: sql<string>`coalesce(sum(case when ${daysOverdue} between 1 and 30 then ${balanceAsOf} else 0 end), 0)`,
      days31to60: sql<string>`coalesce(sum(case when ${daysOverdue} between 31 and 60 then ${balanceAsOf} else 0 end), 0)`,
      days61to90: sql<string>`coalesce(sum(case when ${daysOverdue} between 61 and 90 then ${balanceAsOf} else 0 end), 0)`,
      days90plus: sql<string>`coalesce(sum(case when ${daysOverdue} > 90 then ${balanceAsOf} else 0 end), 0)`,
      total: sql<string>`coalesce(sum(${balanceAsOf}), 0)`,
    })
    .from(documents)
    .innerJoin(contacts, eq(contacts.id, documents.contactId))
    .where(
      and(
        eq(documents.companyId, ctx.companyId),
        eq(documents.direction, params.direction),
        // Only documents that existed as at the reporting date.
        sql`${documents.issueDate} <= ${asOf}::date`,
        // Posted documents only: a draft or a document still awaiting approval
        // is not yet a receivable and must not age.
        isNotNull(documents.journalEntryId),
        sql`${documents.status} not in ('void', 'cancelled', 'draft', 'pending_approval')`,
        // Anything settled in full by `asOf` drops out of the report.
        sql`(${documents.total} - ${paidAsOf}) > 0`,
      ),
    )
    .groupBy(documents.contactId, contacts.displayName)
    .orderBy(asc(contacts.displayName));
}
