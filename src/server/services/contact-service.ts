import 'server-only';

import { and, asc, eq, inArray, sql } from 'drizzle-orm';

import { db, type Tx } from '@/db';
import { contacts, documents, journalEntries, journalLines, payments } from '@/db/schema';
import { requirePermission, type TenantContext } from '@/server/auth/context';
import { PERMISSIONS } from '@/server/auth/permissions';
import { ConflictError, NotFoundError } from '@/server/errors';
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
    email?: string | null;
    phone?: string | null;
    taxIdentifier?: string | null;
    currencyCode?: string | null;
    paymentTermsDays?: number;
    creditLimit?: Money | null;
    billingAddress?: Record<string, unknown>;
    notes?: string | null;
    code?: string;
  },
): Promise<ContactRow> {
  requirePermission(ctx, PERMISSIONS.contacts.manage);

  return db.transaction(async (tx) => {
    const code = input.code ?? (await nextContactCode(tx, ctx.companyId, input.kind));

    const [created] = await tx
      .insert(contacts)
      .values({
        companyId: ctx.companyId,
        kind: input.kind,
        code,
        displayName: input.displayName,
        legalName: input.legalName ?? null,
        email: input.email ?? null,
        phone: input.phone ?? null,
        taxIdentifier: input.taxIdentifier ?? null,
        currencyCode: input.currencyCode ?? null,
        paymentTermsDays: input.paymentTermsDays ?? 30,
        creditLimit: input.creditLimit ?? null,
        billingAddress: input.billingAddress ?? {},
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
      | 'email'
      | 'phone'
      | 'taxIdentifier'
      | 'currencyCode'
      | 'paymentTermsDays'
      | 'creditLimit'
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
  if (filters.search) {
    const term = `%${filters.search.toLowerCase()}%`;
    conditions.push(
      sql`(lower(${contacts.displayName}) like ${term}
        or lower(${contacts.code}) like ${term}
        or lower(coalesce(${contacts.email}, '')) like ${term})`,
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
): Promise<{ outstanding: Money; overdue: Money; documentCount: number }> {
  const today = new Date().toISOString().slice(0, 10);

  const rows = await db
    .select({
      balanceDue: documents.balanceDue,
      dueDate: documents.dueDate,
    })
    .from(documents)
    .where(
      and(
        eq(documents.companyId, ctx.companyId),
        eq(documents.contactId, contactId),
        sql`${documents.balanceDue} > 0`,
        inArray(documents.status, ['approved', 'sent', 'partially_paid', 'overdue']),
      ),
    );

  let outstanding = '0';
  let overdue = '0';
  for (const row of rows) {
    outstanding = add(outstanding, row.balanceDue);
    if (row.dueDate && row.dueDate < today) overdue = add(overdue, row.balanceDue);
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
        inArray(documents.status, ['approved', 'sent', 'partially_paid', 'paid', 'overdue']),
      ),
    )
    .orderBy(asc(documents.issueDate));

  const paymentRows = await db
    .select({
      id: payments.id,
      date: payments.paymentDate,
      number: payments.paymentNumber,
      amount: payments.amount,
    })
    .from(payments)
    .where(
      and(
        eq(payments.companyId, ctx.companyId),
        eq(payments.contactId, contactId),
        eq(payments.status, 'posted'),
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
 * Aging buckets for AR or AP (spec §12).
 *
 * Buckets are computed in SQL so a company with 10,000 open invoices does not
 * ship them all to the application to be summed.
 */
export async function getAgingReport(
  ctx: TenantContext,
  params: { direction: 'outbound' | 'inbound'; asOf?: string },
) {
  requirePermission(ctx, PERMISSIONS.reports.view);

  const asOf = params.asOf ?? new Date().toISOString().slice(0, 10);
  const daysOverdue = sql`(${asOf}::date - ${documents.dueDate}::date)`;

  return db
    .select({
      contactId: documents.contactId,
      contactName: contacts.displayName,
      current: sql<string>`coalesce(sum(case when ${daysOverdue} <= 0 then ${documents.balanceDue} else 0 end), 0)`,
      days1to30: sql<string>`coalesce(sum(case when ${daysOverdue} between 1 and 30 then ${documents.balanceDue} else 0 end), 0)`,
      days31to60: sql<string>`coalesce(sum(case when ${daysOverdue} between 31 and 60 then ${documents.balanceDue} else 0 end), 0)`,
      days61to90: sql<string>`coalesce(sum(case when ${daysOverdue} between 61 and 90 then ${documents.balanceDue} else 0 end), 0)`,
      days90plus: sql<string>`coalesce(sum(case when ${daysOverdue} > 90 then ${documents.balanceDue} else 0 end), 0)`,
      total: sql<string>`coalesce(sum(${documents.balanceDue}), 0)`,
    })
    .from(documents)
    .innerJoin(contacts, eq(contacts.id, documents.contactId))
    .where(
      and(
        eq(documents.companyId, ctx.companyId),
        eq(documents.direction, params.direction),
        sql`${documents.balanceDue} > 0`,
        inArray(documents.status, ['approved', 'sent', 'partially_paid', 'overdue']),
      ),
    )
    .groupBy(documents.contactId, contacts.displayName)
    .orderBy(asc(contacts.displayName));
}
