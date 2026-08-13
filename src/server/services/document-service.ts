import 'server-only';

import { and, desc, eq, inArray, sql } from 'drizzle-orm';

import { db, type Tx } from '@/db';
import { approvals, contacts, documentLines, documents, paymentAllocations, taxes } from '@/db/schema';
import {
  requireBranchAccess,
  requireDifferentApprover,
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
import { divide, isZero, money, subtract, type Money } from '@/lib/money';

import { recordAudit } from './audit-service';
import { resolveAccountByRole } from './account-service';
import { resolveExchangeRate } from './currency-service';
import { createJournalEntry, reverseJournalEntry } from './journal-service';
import { allocateDocumentNumber } from './numbering-service';
import { postCostOfGoodsSold, recordMovement } from './inventory-service';
import { getApplicableSteps, startApprovalChain } from './workflow-service';

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
  /**
   * The stocked item being sold or bought. Setting this is what makes posting
   * the document move stock and, on a sale, recognise cost of goods sold.
   */
  productId?: string | null;
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

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Guards ids taken from URLs before they reach a uuid column. */
function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
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
        productId: c.input.productId ?? null,
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
 * Whether a document may proceed to the ledger, or must wait for signatures.
 *
 * Three cases, in order:
 *   - no workflow configured for this type/amount → post now;
 *   - a chain exists and every step is approved → post now;
 *   - a chain applies and steps are outstanding → block.
 *
 * A rejected step blocks outright: the document must be resubmitted rather
 * than quietly reopened by another post attempt.
 */
async function resolveApprovalState(
  tx: Tx,
  ctx: TenantContext,
  document: DocumentRow,
): Promise<{ blocked: boolean; alreadyOpen: boolean; stepsRequired: number }> {
  const existing = await tx
    .select({ status: approvals.status })
    .from(approvals)
    .where(
      and(
        eq(approvals.companyId, ctx.companyId),
        eq(approvals.entityType, 'document'),
        eq(approvals.entityId, document.id),
      ),
    );

  if (existing.length > 0) {
    const rejected = existing.filter((a) => a.status === 'rejected').length;
    if (rejected > 0) {
      throw new ConflictError(
        'This document was rejected in approval. Amend it and resubmit it for approval ' +
          'rather than posting it directly.',
      );
    }
    const pending = existing.filter((a) => a.status === 'pending').length;
    return {
      blocked: pending > 0,
      alreadyOpen: true,
      stepsRequired: existing.length,
    };
  }

  const steps = await getApplicableSteps(tx, {
    companyId: ctx.companyId,
    documentType: document.documentType,
    amount: document.total,
  });

  return { blocked: steps.length > 0, alreadyOpen: false, stepsRequired: steps.length };
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
): Promise<{ journalEntryId: string } | { pendingApproval: true; stepsRequired: number }> {
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

    /**
     * Approval gate (spec §21).
     *
     * Before this existed, a configured threshold — "bills over 100,000 need
     * the finance manager" — was displayed in Settings and enforced nowhere:
     * `postDocument` posted straight to the ledger on the single permission
     * check above. Now the chain is resolved first, and a document that needs
     * signatures stops here with its approval rows created rather than
     * reaching the ledger.
     */
    const approvalState = await resolveApprovalState(tx, ctx, document);

    if (approvalState.blocked) {
      // Opens the chain on first submission; a document already waiting simply
      // stays where it is rather than accruing a duplicate set of steps.
      if (!approvalState.alreadyOpen) {
        await startApprovalChain(tx, ctx, {
          entityType: 'document',
          entityId: document.id,
          documentType: document.documentType,
          amount: document.total,
        });

        await tx
          .update(documents)
          .set({ status: 'pending_approval', updatedAt: sql`now()` })
          .where(eq(documents.id, documentId));

        await recordAudit(tx, ctx, {
          action: 'document.submitted_for_approval',
          entityType: 'document',
          entityId: documentId,
          previousValues: { status: document.status },
          newValues: {
            status: 'pending_approval',
            stepsRequired: approvalState.stepsRequired,
            total: document.total,
          },
        });
      }

      return { pendingApproval: true as const, stepsRequired: approvalState.stepsRequired };
    }

    // Either no workflow applies or every step is approved. The originator
    // still may not be the one pushing it into the ledger.
    requireDifferentApprover(
      ctx,
      document.createdById,
      PERMISSIONS.selfApproval.documents,
      document.documentType.replace('_', ' '),
    );

    return postDocumentToLedger(tx, ctx, document);
  });
}

/**
 * Builds and posts the journal entry for an already-authorised document.
 *
 * Split out of `postDocument` so the approval path can reach the ledger
 * through exactly the same code rather than a parallel implementation — a
 * second posting routine is how the first control came to be bypassed. All
 * authorisation happens in the callers; by the time this runs the document is
 * cleared to post.
 */
async function postDocumentToLedger(
  tx: Tx,
  ctx: TenantContext,
  document: DocumentRow,
): Promise<{ journalEntryId: string }> {
  const documentId = document.id;

  {
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

    /**
     * Cost of goods sold (spec §16).
     *
     * A sale of a stocked product requires a second entry that the revenue
     * entry above does not contain:
     *
     *     Dr Cost of Goods Sold      quantity × weighted average
     *       Cr Inventory                  same
     *
     * Posted here, inside the document's own transaction, so revenue and its
     * cost land together or not at all. Without it revenue was recognised with
     * no matching cost: gross profit overstated by the cost of every unit sold,
     * and inventory on the balance sheet growing without bound.
     *
     * A credit note returns the goods, so stock comes back in instead.
     * Purchases are skipped — a bill already debits inventory through its own
     * line, and the movement is recorded without a second ledger effect.
     */
    const stockLines = lines.filter((line) => line.productId);

    if (stockLines.length > 0) {
      if (isSale) {
        await postCostOfGoodsSold(tx, ctx, {
          lines: stockLines.map((line) => ({
            productId: line.productId!,
            quantity: line.quantity,
            branchId: line.branchId ?? document.branchId,
          })),
          movementDate: document.issueDate,
          sourceType: document.documentType,
          sourceId: document.id,
          isReturn: isCredit,
        });
      } else {
        // Purchase: the bill's own entry already carried the value to the
        // inventory account, so the movement records quantity and cost only.
        for (const line of stockLines) {
          await recordMovement(
            ctx,
            {
              productId: line.productId!,
              movementDate: document.issueDate,
              quantity: line.quantity,
              // Unit cost net of tax and discount: recoverable tax is not part
              // of the cost of the asset.
              unitCost: divide(line.lineSubtotal, line.quantity),
              movementType: isCredit ? 'return_out' : 'purchase',
              sourceType: document.documentType,
              sourceId: document.id,
              journalEntryId: entry.id,
              branchId: line.branchId ?? document.branchId,
            },
            { tx, postToLedger: false },
          );
        }
      }
    }

    await recordAudit(tx, ctx, {
      action: 'document.posted',
      entityType: 'document',
      entityId: documentId,
      newValues: {
        journalEntryId: entry.id,
        total: document.total,
        stockLines: stockLines.length,
      },
    });

    return { journalEntryId: entry.id };
  }
}

/**
 * Posts a document whose approval chain has just completed.
 *
 * Called by `decideApproval` when the final step is approved, inside that
 * decision's transaction — so the last signature and the ledger entry commit
 * together. If posting fails (a closed period, a since-archived account), the
 * approval rolls back with it and the document stays pending rather than
 * ending up approved-but-unposted.
 */
export async function postApprovedDocument(
  tx: Tx,
  ctx: TenantContext,
  documentId: string,
): Promise<{ journalEntryId: string } | null> {
  const [document] = await tx
    .select()
    .from(documents)
    .where(and(eq(documents.id, documentId), eq(documents.companyId, ctx.companyId)))
    .for('update')
    .limit(1);

  if (!document) throw new NotFoundError('Document');
  // Already posted, or not a posting document: nothing further to do. Not an
  // error — the approval itself was still valid and must not be rolled back.
  if (document.journalEntryId) return null;
  if (isNonPosting(document.documentType)) return null;
  if (document.status === 'cancelled' || document.status === 'void') return null;

  return postDocumentToLedger(tx, ctx, document);
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
  if (
    document.status === 'cancelled' ||
    document.status === 'void' ||
    // A written-off balance was cleared by a bad-debt entry, not by payment.
    // Recomputing it would relabel the write-off as `paid` and hide the loss.
    document.status === 'written_off'
  ) {
    return document.status;
  }
  if (document.status === 'draft' || document.status === 'pending_approval') {
    return document.status;
  }

  if (isZero(balanceDue) && !isZero(amountPaid)) return 'paid';
  if (!isZero(amountPaid)) return 'partially_paid';

  // Overdue is derived from the due date rather than stored as an event, so it
  // becomes true on its own without a nightly job. Checked after the payment
  // states so a part-paid overdue invoice keeps its payment status; `isOverdue`
  // below is the orthogonal flag reports should filter on.
  if (document.dueDate && document.dueDate < new Date().toISOString().slice(0, 10)) {
    return 'overdue';
  }
  // `sent` is preserved: it was a real event, and reverting it to `approved` on
  // the next balance refresh lost the fact that the customer had been invoiced.
  return document.status;
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
  // Ids arrive straight from the URL, so a stray path segment ("new", a typo)
  // would otherwise reach Postgres and fail as a 500 on a uuid cast. A
  // malformed id simply cannot match a document, so treat it as not-found.
  if (!isUuid(documentId)) throw new NotFoundError('Document');

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

/**
 * Writes off an uncollectible receivable (or payable).
 *
 *   Dr Bad Debt Expense        outstanding balance
 *     Cr Accounts Receivable        outstanding balance
 *
 * The write-off is linked to the specific document via `sourceType`/`sourceId`
 * and carries the customer on the line, so the subledger and the control
 * account stay in step and the write-off can be traced back to what it wrote
 * off — an unlinked journal entry would clear the control account while
 * leaving the invoice showing as outstanding for ever.
 *
 * A write-off is recorded as an allocation-free settlement: `balanceDue` falls
 * to nil through the same `refreshDocumentBalance` path everything else uses.
 */
export async function writeOffDocument(
  ctx: TenantContext,
  documentId: string,
  params: { reason: string; writeOffDate?: string },
): Promise<{ journalEntryId: string; amount: Money }> {
  if (!params.reason?.trim()) {
    throw new ValidationError('A reason is required to write off a balance');
  }

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
    // Writing off a debt is a credit decision, not data entry: the person who
    // raised the invoice must not be the one deciding it is uncollectible.
    requireDifferentApprover(
      ctx,
      document.createdById,
      PERMISSIONS.selfApproval.documents,
      'document',
    );

    if (!document.journalEntryId) {
      throw new AccountingError(
        `${document.documentNumber} has not been posted, so there is no receivable to write off. ` +
          'Delete or void the draft instead.',
      );
    }
    if (document.status === 'void' || document.status === 'cancelled') {
      throw new ConflictError(`${document.documentNumber} is ${document.status}.`);
    }
    if (isZero(document.balanceDue)) {
      throw new AccountingError(
        `${document.documentNumber} has no outstanding balance to write off.`,
      );
    }

    const isSale = document.direction === 'outbound';
    const writeOffDate = params.writeOffDate ?? new Date().toISOString().slice(0, 10);
    const amount = money(document.balanceDue);

    const badDebt = await resolveAccountByRole(tx, ctx.companyId, 'bad_debt_expense');
    const control = await resolveAccountByRole(
      tx,
      ctx.companyId,
      isSale ? 'accounts_receivable' : 'accounts_payable',
    );

    const entry = await createJournalEntry(
      ctx,
      {
        entryDate: writeOffDate,
        description: `Write-off ${document.documentNumber}: ${params.reason}`,
        reference: document.documentNumber,
        currencyCode: document.currencyCode,
        exchangeRate: document.exchangeRate,
        branchId: document.branchId,
        sourceType: 'write_off',
        sourceId: document.id,
        lines: [
          {
            accountId: badDebt.id,
            // A written-off payable is a gain, not an expense, so the sides
            // flip for an inbound document.
            [isSale ? 'debit' : 'credit']: amount,
            description: `Bad debt: ${document.documentNumber}`,
            customerId: isSale ? document.contactId : null,
            vendorId: isSale ? null : document.contactId,
            branchId: document.branchId,
          },
          {
            accountId: control.id,
            [isSale ? 'credit' : 'debit']: amount,
            description: `Write off ${document.documentNumber}`,
            customerId: isSale ? document.contactId : null,
            vendorId: isSale ? null : document.contactId,
            branchId: document.branchId,
          },
        ] as never,
        post: true,
      },
      { tx, allowControlAccounts: true },
    );

    await tx
      .update(documents)
      .set({
        // The balance is gone from the ledger, so the document must agree.
        amountPaid: document.total,
        balanceDue: '0',
        status: 'written_off',
        updatedAt: sql`now()`,
      })
      .where(eq(documents.id, documentId));

    await recordAudit(tx, ctx, {
      action: 'document.written_off',
      entityType: 'document',
      entityId: documentId,
      previousValues: { status: document.status, balanceDue: document.balanceDue },
      newValues: { status: 'written_off', journalEntryId: entry.id, amount },
      reason: params.reason,
    });

    return { journalEntryId: entry.id, amount };
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
