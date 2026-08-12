import 'server-only';

import { and, desc, eq, inArray, sql } from 'drizzle-orm';

import { db, type Tx } from '@/db';
import { contacts, documentLines, documents, paymentAllocations, taxes } from '@/db/schema';
import {
  requireBranchAccess,
  requirePermission,
  type TenantContext,
} from '@/server/auth/context';
import { PERMISSIONS, type Permission } from '@/server/auth/permissions';
import { AccountingError, ConflictError, NotFoundError, ValidationError } from '@/server/errors';
import {
  calculateDocumentTotals,
  calculateLine,
  type DiscountType,
  type LineResult,
} from '@/lib/line-calculator';
import { isZero, money, subtract, type Money } from '@/lib/money';

import { recordAudit } from './audit-service';
import { resolveAccountByRole } from './account-service';
import { resolveExchangeRate } from './currency-service';
import { createJournalEntry, reverseJournalEntry } from './journal-service';
import { allocateDocumentNumber } from './numbering-service';

export type DocumentRow = typeof documents.$inferSelect;
export type DocumentDirection = 'outbound' | 'inbound';

export interface DocumentLineInput {
  description: string;
  quantity: Money;
  unitPrice: Money;
  accountId: string;
  discountType?: DiscountType;
  discountValue?: Money;
  taxId?: string | null;
  branchId?: string | null;
  projectId?: string | null;
}

export interface CreateDocumentInput {
  direction: DocumentDirection;
  documentType: string;
  contactId: string;
  issueDate: string;
  dueDate?: string | null;
  currencyCode?: string;
  exchangeRate?: string;
  branchId?: string | null;
  reference?: string | null;
  notes?: string | null;
  terms?: string | null;
  lines: DocumentLineInput[];
}

/** Permissions differ for sales vs purchase documents. */
function permissionsFor(direction: DocumentDirection): {
  create: Permission;
  approve: Permission;
  view: Permission;
} {
  return direction === 'outbound'
    ? {
        create: PERMISSIONS.invoices.create,
        approve: PERMISSIONS.invoices.approve,
        view: PERMISSIONS.invoices.view,
      }
    : {
        create: PERMISSIONS.bills.create,
        approve: PERMISSIONS.bills.approve,
        view: PERMISSIONS.bills.view,
      };
}

/**
 * Credit and debit notes reduce what is owed, so their ledger effect is the
 * mirror of an invoice or bill. Treating them as a sign flip keeps one posting
 * routine rather than four near-duplicates.
 */
function isCreditDocument(documentType: string): boolean {
  return documentType === 'credit_note' || documentType === 'debit_note';
}

/** Documents that are commercial offers only and never touch the ledger. */
function isNonPosting(documentType: string): boolean {
  return documentType === 'quote' || documentType === 'purchase_order';
}

async function loadTaxRates(
  tx: Tx,
  companyId: string,
  taxIds: string[],
): Promise<Map<string, { ratePercent: string; isInclusive: boolean }>> {
  const unique = [...new Set(taxIds.filter(Boolean))];
  if (unique.length === 0) return new Map();

  const rows = await tx
    .select()
    .from(taxes)
    .where(and(eq(taxes.companyId, companyId), inArray(taxes.id, unique)));

  const map = new Map(
    rows.map((r) => [r.id, { ratePercent: r.ratePercent, isInclusive: r.isInclusive }]),
  );

  for (const id of unique) {
    if (!map.has(id)) throw new NotFoundError(`Tax ${id}`);
  }
  return map;
}

/**
 * Creates a draft invoice, bill, credit note or quote.
 *
 * Nothing is posted here: a draft can be edited freely. The ledger is only
 * touched by `postDocument`, which is the point the document becomes
 * financial history.
 */
export async function createDocument(
  ctx: TenantContext,
  input: CreateDocumentInput,
): Promise<DocumentRow> {
  const perms = permissionsFor(input.direction);
  requirePermission(ctx, perms.create);
  requireBranchAccess(ctx, input.branchId ?? null);

  if (input.lines.length === 0) {
    throw new ValidationError('A document must have at least one line');
  }

  return db.transaction(async (tx) => {
    const [contact] = await tx
      .select()
      .from(contacts)
      .where(and(eq(contacts.id, input.contactId), eq(contacts.companyId, ctx.companyId)))
      .limit(1);

    if (!contact) throw new NotFoundError('Contact');

    const currencyCode = input.currencyCode ?? contact.currencyCode ?? ctx.baseCurrencyCode;
    const exchangeRate =
      input.exchangeRate ??
      (await resolveExchangeRate(tx, {
        companyId: ctx.companyId,
        from: currencyCode,
        to: ctx.baseCurrencyCode,
        date: input.issueDate,
      }));

    const taxMap = await loadTaxRates(
      tx,
      ctx.companyId,
      input.lines.map((l) => l.taxId ?? '').filter(Boolean),
    );

    const calculated = input.lines.map((line) => {
      const tax = line.taxId ? taxMap.get(line.taxId) : undefined;
      return {
        input: line,
        tax,
        result: calculateLine(
          {
            quantity: line.quantity,
            unitPrice: line.unitPrice,
            discountType: line.discountType,
            discountValue: line.discountValue,
            taxRatePercent: tax?.ratePercent ?? '0',
            taxInclusive: tax?.isInclusive ?? false,
          },
          ctx.currencyPrecision,
        ),
      };
    });

    const totals = calculateDocumentTotals(calculated.map((c) => c.result));

    const documentNumber = await allocateDocumentNumber(tx, {
      companyId: ctx.companyId,
      documentType: input.documentType,
      date: new Date(input.issueDate),
    });

    // Default the due date from the contact's payment terms so users are not
    // forced to compute it, while still allowing an explicit override.
    const dueDate =
      input.dueDate ??
      (() => {
        const d = new Date(input.issueDate);
        d.setUTCDate(d.getUTCDate() + contact.paymentTermsDays);
        return d.toISOString().slice(0, 10);
      })();

    const [document] = await tx
      .insert(documents)
      .values({
        companyId: ctx.companyId,
        branchId: input.branchId ?? null,
        direction: input.direction,
        documentType: input.documentType,
        documentNumber,
        contactId: input.contactId,
        issueDate: input.issueDate,
        dueDate,
        currencyCode,
        exchangeRate,
        subtotal: totals.subtotal,
        discountTotal: totals.discountTotal,
        taxTotal: totals.taxTotal,
        total: totals.total,
        amountPaid: '0',
        balanceDue: totals.total,
        status: 'draft',
        reference: input.reference ?? null,
        notes: input.notes ?? null,
        terms: input.terms ?? null,
        createdById: ctx.userId,
      })
      .returning();

    if (!document) throw new ConflictError('Failed to create document');

    await tx.insert(documentLines).values(
      calculated.map((c, index) => ({
        companyId: ctx.companyId,
        documentId: document.id,
        lineNumber: index + 1,
        description: c.input.description,
        quantity: money(c.input.quantity),
        unitPrice: money(c.input.unitPrice),
        discountType: c.input.discountType ?? 'none',
        discountValue: money(c.input.discountValue ?? '0'),
        discountAmount: c.result.discountAmount,
        taxId: c.input.taxId ?? null,
        taxRatePercent: c.tax?.ratePercent ?? '0',
        taxAmount: c.result.taxAmount,
        accountId: c.input.accountId,
        lineSubtotal: c.result.lineSubtotal,
        lineTotal: c.result.lineTotal,
        branchId: c.input.branchId ?? input.branchId ?? null,
        projectId: c.input.projectId ?? null,
      })),
    );

    await recordAudit(tx, ctx, {
      action: 'document.created',
      entityType: 'document',
      entityId: document.id,
      newValues: {
        documentNumber,
        documentType: input.documentType,
        total: totals.total,
        currencyCode,
      },
    });

    return document;
  });
}

/**
 * Posts a document to the ledger.
 *
 * The entry for a customer invoice is:
 *   Dr Accounts Receivable      total
 *     Cr Revenue (per line)       net of tax
 *     Cr Sales Tax Payable        tax
 *
 * A bill is the mirror (Dr expense/asset, Dr recoverable tax, Cr AP), and a
 * credit note reverses the direction. Rather than write four variants, the
 * routine builds the control-account side and the line side, then swaps which
 * gets debited based on direction and document type.
 */
export async function postDocument(
  ctx: TenantContext,
  documentId: string,
): Promise<{ journalEntryId: string }> {
  return db.transaction(async (tx) => {
    const [document] = await tx
      .select()
      .from(documents)
      .where(and(eq(documents.id, documentId), eq(documents.companyId, ctx.companyId)))
      .for('update')
      .limit(1);

    if (!document) throw new NotFoundError('Document');

    const perms = permissionsFor(document.direction as DocumentDirection);
    requirePermission(ctx, perms.approve);

    if (isNonPosting(document.documentType)) {
      throw new AccountingError(
        `A ${document.documentType.replace('_', ' ')} is not a financial document and cannot be posted. ` +
          'Convert it to an invoice or bill first.',
      );
    }
    if (document.journalEntryId) {
      throw new ConflictError('This document has already been posted');
    }
    if (document.status === 'cancelled' || document.status === 'void') {
      throw new ConflictError(`A ${document.status} document cannot be posted`);
    }
    if (isZero(document.total)) {
      throw new AccountingError('A document with a zero total cannot be posted');
    }

    const lines = await tx
      .select()
      .from(documentLines)
      .where(eq(documentLines.documentId, documentId));

    if (lines.length === 0) {
      throw new AccountingError('This document has no lines to post');
    }

    const isSale = document.direction === 'outbound';
    const isCredit = isCreditDocument(document.documentType);

    // A credit note flips which side each component lands on.
    const controlOnDebit = isSale !== isCredit;

    const controlAccount = await resolveAccountByRole(
      tx,
      ctx.companyId,
      isSale ? 'accounts_receivable' : 'accounts_payable',
    );

    const entryLines = [
      {
        accountId: controlAccount.id,
        [controlOnDebit ? 'debit' : 'credit']: document.total,
        description: `${document.documentType} ${document.documentNumber}`,
        customerId: isSale ? document.contactId : null,
        vendorId: isSale ? null : document.contactId,
        branchId: document.branchId,
      } as Record<string, unknown>,
    ];

    for (const line of lines) {
      if (isZero(line.lineSubtotal)) continue;
      entryLines.push({
        accountId: line.accountId,
        [controlOnDebit ? 'credit' : 'debit']: line.lineSubtotal,
        description: line.description,
        branchId: line.branchId ?? document.branchId,
        projectId: line.projectId,
        customerId: isSale ? document.contactId : null,
        vendorId: isSale ? null : document.contactId,
      });
    }

    // Tax is aggregated into a single line per document: the tax authority is
    // owed one amount, not one per invoice line.
    if (!isZero(document.taxTotal)) {
      const taxAccount = await resolveAccountByRole(
        tx,
        ctx.companyId,
        isSale ? 'sales_tax_payable' : 'purchase_tax_receivable',
      );
      entryLines.push({
        accountId: taxAccount.id,
        [controlOnDebit ? 'credit' : 'debit']: document.taxTotal,
        description: `Tax on ${document.documentNumber}`,
        branchId: document.branchId,
      });
    }

    const entry = await createJournalEntry(
      ctx,
      {
        entryDate: document.issueDate,
        description: `${document.documentType} ${document.documentNumber}`,
        reference: document.reference,
        currencyCode: document.currencyCode,
        exchangeRate: document.exchangeRate,
        branchId: document.branchId,
        sourceType: document.documentType,
        sourceId: document.id,
        lines: entryLines as never,
        post: true,
      },
      // The subledger legitimately moves AR/AP; a hand-written entry may not.
      { tx, allowControlAccounts: true },
    );

    await tx
      .update(documents)
      .set({
        status: 'approved',
        journalEntryId: entry.id,
        approvedById: ctx.userId,
        approvedAt: sql`now()`,
        updatedAt: sql`now()`,
      })
      .where(eq(documents.id, documentId));

    await recordAudit(tx, ctx, {
      action: 'document.posted',
      entityType: 'document',
      entityId: documentId,
      newValues: { journalEntryId: entry.id, total: document.total },
    });

    return { journalEntryId: entry.id };
  });
}

/**
 * Recomputes `amountPaid`, `balanceDue` and status from the document's
 * allocations. Called after any payment change so the stored balance never
 * drifts from the allocations that justify it.
 */
export async function refreshDocumentBalance(
  tx: Tx,
  companyId: string,
  documentId: string,
): Promise<void> {
  const [document] = await tx
    .select()
    .from(documents)
    .where(and(eq(documents.id, documentId), eq(documents.companyId, companyId)))
    .limit(1);

  if (!document) return;

  const [allocated] = await tx
    .select({
      paid: sql<string>`coalesce(sum(${paymentAllocations.amountApplied}), 0)`,
    })
    .from(paymentAllocations)
    .where(
      and(
        eq(paymentAllocations.documentId, documentId),
        eq(paymentAllocations.companyId, companyId),
      ),
    );

  const amountPaid = money(allocated?.paid ?? '0');
  const balanceDue = subtract(document.total, amountPaid);

  const status = determineStatus(document, amountPaid, balanceDue);

  await tx
    .update(documents)
    .set({ amountPaid, balanceDue, status, updatedAt: sql`now()` })
    .where(eq(documents.id, documentId));
}

function determineStatus(
  document: DocumentRow,
  amountPaid: Money,
  balanceDue: Money,
): DocumentRow['status'] {
  // Terminal states are never recomputed from payment activity.
  if (document.status === 'cancelled' || document.status === 'void') return document.status;
  if (document.status === 'draft') return 'draft';

  if (isZero(balanceDue)) return 'paid';
  if (!isZero(amountPaid)) return 'partially_paid';

  // Overdue is derived from the due date rather than stored as an event, so it
  // becomes true on its own without a nightly job.
  if (document.dueDate && document.dueDate < new Date().toISOString().slice(0, 10)) {
    return 'overdue';
  }
  return document.status === 'approved' ? 'approved' : document.status;
}

export async function listDocuments(
  ctx: TenantContext,
  filters: {
    direction?: DocumentDirection;
    documentType?: string;
    status?: DocumentRow['status'];
    contactId?: string;
    from?: string;
    to?: string;
    search?: string;
    limit?: number;
    offset?: number;
  } = {},
) {
  const perms = permissionsFor(filters.direction ?? 'outbound');
  requirePermission(ctx, perms.view);

  const conditions = [eq(documents.companyId, ctx.companyId)];
  if (filters.direction) conditions.push(eq(documents.direction, filters.direction));
  if (filters.documentType) conditions.push(eq(documents.documentType, filters.documentType));
  if (filters.status) conditions.push(eq(documents.status, filters.status));
  if (filters.contactId) conditions.push(eq(documents.contactId, filters.contactId));
  if (filters.from) conditions.push(sql`${documents.issueDate} >= ${filters.from}`);
  if (filters.to) conditions.push(sql`${documents.issueDate} <= ${filters.to}`);
  if (filters.search) {
    const term = `%${filters.search.toLowerCase()}%`;
    conditions.push(
      sql`(lower(${documents.documentNumber}) like ${term} or lower(coalesce(${documents.reference}, '')) like ${term})`,
    );
  }

  // Branch-restricted users only ever see their own branches' documents.
  if (ctx.branchIds.length > 0) {
    conditions.push(inArray(documents.branchId, [...ctx.branchIds]));
  }

  return db
    .select({
      id: documents.id,
      documentNumber: documents.documentNumber,
      documentType: documents.documentType,
      direction: documents.direction,
      contactId: documents.contactId,
      contactName: contacts.displayName,
      issueDate: documents.issueDate,
      dueDate: documents.dueDate,
      currencyCode: documents.currencyCode,
      total: documents.total,
      amountPaid: documents.amountPaid,
      balanceDue: documents.balanceDue,
      status: documents.status,
    })
    .from(documents)
    .innerJoin(contacts, eq(contacts.id, documents.contactId))
    .where(and(...conditions))
    .orderBy(desc(documents.issueDate), desc(documents.documentNumber))
    .limit(filters.limit ?? 50)
    .offset(filters.offset ?? 0);
}

export async function getDocument(ctx: TenantContext, documentId: string) {
  const [document] = await db
    .select()
    .from(documents)
    .where(and(eq(documents.id, documentId), eq(documents.companyId, ctx.companyId)))
    .limit(1);

  if (!document) throw new NotFoundError('Document');
  requirePermission(ctx, permissionsFor(document.direction as DocumentDirection).view);

  const lines = await db
    .select()
    .from(documentLines)
    .where(eq(documentLines.documentId, documentId))
    .orderBy(documentLines.lineNumber);

  const [contact] = await db
    .select()
    .from(contacts)
    .where(eq(contacts.id, document.contactId))
    .limit(1);

  return { document, lines, contact };
}

/**
 * Voids a posted document by reversing its journal entry. The document itself
 * is kept with a `void` status — deleting it would break the number sequence
 * and erase evidence that it ever existed.
 */
export async function voidDocument(
  ctx: TenantContext,
  documentId: string,
  reason: string,
): Promise<void> {
  const [document] = await db
    .select()
    .from(documents)
    .where(and(eq(documents.id, documentId), eq(documents.companyId, ctx.companyId)))
    .limit(1);

  if (!document) throw new NotFoundError('Document');
  requirePermission(ctx, permissionsFor(document.direction as DocumentDirection).approve);

  if (!isZero(document.amountPaid)) {
    throw new ConflictError(
      'This document has payments applied. Remove the allocations before voiding it.',
    );
  }

  await db.transaction(async (tx) => {
    if (document.journalEntryId) {
      await reverseJournalEntry(
        ctx,
        document.journalEntryId,
        { reason: `Void ${document.documentNumber}: ${reason}` },
        { tx },
      );
    }

    await tx
      .update(documents)
      .set({ status: 'void', voidedAt: sql`now()`, updatedAt: sql`now()` })
      .where(eq(documents.id, documentId));

    await recordAudit(tx, ctx, {
      action: 'document.voided',
      entityType: 'document',
      entityId: documentId,
      previousValues: { status: document.status },
      newValues: { status: 'void' },
      reason,
    });
  });
}

/** Marks an approved sales document as sent to the customer. */
export async function markDocumentSent(ctx: TenantContext, documentId: string): Promise<void> {
  requirePermission(ctx, PERMISSIONS.invoices.send);

  await db.transaction(async (tx) => {
    const [document] = await tx
      .select()
      .from(documents)
      .where(and(eq(documents.id, documentId), eq(documents.companyId, ctx.companyId)))
      .limit(1);

    if (!document) throw new NotFoundError('Document');
    if (document.status === 'draft') {
      throw new ConflictError('Post the document before sending it');
    }

    await tx
      .update(documents)
      .set({ status: 'sent', sentAt: sql`now()`, updatedAt: sql`now()` })
      .where(eq(documents.id, documentId));

    await recordAudit(tx, ctx, {
      action: 'document.sent',
      entityType: 'document',
      entityId: documentId,
    });
  });
}
