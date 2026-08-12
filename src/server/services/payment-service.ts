import 'server-only';

import { and, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';

import { db, type Tx } from '@/db';
import {
  bankAccounts,
  contacts,
  documents,
  paymentAllocations,
  payments,
} from '@/db/schema';
import {
  requireBranchAccess,
  requirePermission,
  type TenantContext,
} from '@/server/auth/context';
import { PERMISSIONS } from '@/server/auth/permissions';
import { AccountingError, ConflictError, NotFoundError, ValidationError } from '@/server/errors';
import { add, gt, isZero, money, subtract, sum, type Money } from '@/lib/money';

import { recordAudit } from './audit-service';
import { resolveAccountByRole } from './account-service';
import { resolveExchangeRate } from './currency-service';
import { refreshDocumentBalance } from './document-service';
import { createJournalEntry, reverseJournalEntry } from './journal-service';
import { allocateDocumentNumber } from './numbering-service';

export type PaymentRow = typeof payments.$inferSelect;
export type PaymentDirection = 'receipt' | 'disbursement';

export interface AllocationInput {
  documentId: string;
  amountApplied: Money;
}

export interface CreatePaymentInput {
  direction: PaymentDirection;
  contactId?: string | null;
  paymentDate: string;
  amount: Money;
  bankAccountId: string;
  method?: string;
  reference?: string | null;
  notes?: string | null;
  currencyCode?: string;
  exchangeRate?: string;
  branchId?: string | null;
  /** Invoices/bills this payment settles. May be empty (an unapplied payment). */
  allocations?: AllocationInput[];
}

/**
 * Records a payment and posts it to the ledger.
 *
 * A customer receipt is:
 *   Dr Bank                 amount
 *     Cr Accounts Receivable  amount
 *
 * The AR credit is what clears the invoice from the aging report; the
 * allocations rows record *which* invoices it cleared. Both happen in one
 * transaction, so a payment can never reduce AR without saying what it paid.
 */
export async function createPayment(
  ctx: TenantContext,
  input: CreatePaymentInput,
): Promise<PaymentRow> {
  requirePermission(ctx, PERMISSIONS.payments.create);
  requireBranchAccess(ctx, input.branchId ?? null);

  const amount = money(input.amount);
  if (!gt(amount, '0')) {
    throw new ValidationError('Payment amount must be greater than zero');
  }

  return db.transaction(async (tx) => {
    const [bankAccount] = await tx
      .select()
      .from(bankAccounts)
      .where(
        and(eq(bankAccounts.id, input.bankAccountId), eq(bankAccounts.companyId, ctx.companyId)),
      )
      .limit(1);

    if (!bankAccount) throw new NotFoundError('Bank account');

    const currencyCode = input.currencyCode ?? bankAccount.currencyCode;
    const exchangeRate =
      input.exchangeRate ??
      (await resolveExchangeRate(tx, {
        companyId: ctx.companyId,
        from: currencyCode,
        to: ctx.baseCurrencyCode,
        date: input.paymentDate,
      }));

    const isReceipt = input.direction === 'receipt';

    const allocations = input.allocations ?? [];
    const allocationTotal = sum(allocations.map((a) => money(a.amountApplied)));

    if (gt(allocationTotal, amount)) {
      throw new AccountingError(
        `Allocations total ${allocationTotal} but the payment is only ${amount}. ` +
          'Reduce the allocated amounts or increase the payment.',
      );
    }

    const paymentNumber = await allocateDocumentNumber(tx, {
      companyId: ctx.companyId,
      documentType: 'payment',
      date: new Date(input.paymentDate),
    });

    const [payment] = await tx
      .insert(payments)
      .values({
        companyId: ctx.companyId,
        branchId: input.branchId ?? null,
        direction: input.direction,
        paymentNumber,
        contactId: input.contactId ?? null,
        paymentDate: input.paymentDate,
        method: input.method ?? 'bank_transfer',
        reference: input.reference ?? null,
        currencyCode,
        exchangeRate,
        amount,
        allocatedAmount: allocationTotal,
        unappliedAmount: subtract(amount, allocationTotal),
        bankAccountId: input.bankAccountId,
        status: 'draft',
        notes: input.notes ?? null,
        createdById: ctx.userId,
      })
      .returning();

    if (!payment) throw new ConflictError('Failed to create payment');

    if (allocations.length > 0) {
      await applyAllocations(tx, ctx, payment.id, allocations, input.direction);
    }

    // Ledger side. The control account is credited for a receipt (reducing what
    // the customer owes) and debited for a disbursement (reducing what we owe).
    const controlAccount = await resolveAccountByRole(
      tx,
      ctx.companyId,
      isReceipt ? 'accounts_receivable' : 'accounts_payable',
    );

    const entry = await createJournalEntry(
      ctx,
      {
        entryDate: input.paymentDate,
        description: `${isReceipt ? 'Receipt' : 'Payment'} ${paymentNumber}`,
        reference: input.reference,
        currencyCode,
        exchangeRate,
        branchId: input.branchId ?? null,
        sourceType: 'payment',
        sourceId: payment.id,
        lines: [
          {
            accountId: bankAccount.ledgerAccountId,
            ...(isReceipt ? { debit: amount } : { credit: amount }),
            description: `${isReceipt ? 'Received' : 'Paid'} via ${input.method ?? 'bank transfer'}`,
            branchId: input.branchId ?? null,
          },
          {
            accountId: controlAccount.id,
            ...(isReceipt ? { credit: amount } : { debit: amount }),
            description: `${isReceipt ? 'Settle receivable' : 'Settle payable'} ${paymentNumber}`,
            customerId: isReceipt ? input.contactId ?? null : null,
            vendorId: isReceipt ? null : input.contactId ?? null,
            branchId: input.branchId ?? null,
          },
        ] as never,
        post: true,
      },
      { tx, allowControlAccounts: true },
    );

    await tx
      .update(payments)
      .set({ status: 'posted', journalEntryId: entry.id, updatedAt: sql`now()` })
      .where(eq(payments.id, payment.id));

    for (const allocation of allocations) {
      await refreshDocumentBalance(tx, ctx.companyId, allocation.documentId);
    }

    await recordAudit(tx, ctx, {
      action: 'payment.created',
      entityType: 'payment',
      entityId: payment.id,
      newValues: {
        paymentNumber,
        amount,
        direction: input.direction,
        allocationCount: allocations.length,
      },
    });

    return { ...payment, status: 'posted' as const, journalEntryId: entry.id };
  });
}

/**
 * Writes allocation rows, checking each against the document's remaining
 * balance. This is where spec §32's "allocations cannot exceed invoice
 * balance" is enforced; the document row is locked so two concurrent payments
 * cannot both allocate against the same remaining balance.
 */
async function applyAllocations(
  tx: Tx,
  ctx: TenantContext,
  paymentId: string,
  allocations: AllocationInput[],
  direction: PaymentDirection,
): Promise<void> {
  const expectedDirection = direction === 'receipt' ? 'outbound' : 'inbound';

  for (const allocation of allocations) {
    const applied = money(allocation.amountApplied);
    if (!gt(applied, '0')) {
      throw new ValidationError('Allocated amount must be greater than zero');
    }

    const [document] = await tx
      .select()
      .from(documents)
      .where(
        and(eq(documents.id, allocation.documentId), eq(documents.companyId, ctx.companyId)),
      )
      .for('update')
      .limit(1);

    if (!document) throw new NotFoundError('Document');

    if (document.direction !== expectedDirection) {
      throw new AccountingError(
        `${direction === 'receipt' ? 'A customer receipt' : 'A vendor payment'} cannot be ` +
          `allocated to ${document.documentNumber}, which is a ${document.direction} document.`,
      );
    }
    if (!document.journalEntryId) {
      throw new AccountingError(
        `${document.documentNumber} has not been posted yet and cannot receive a payment.`,
      );
    }
    if (document.status === 'void' || document.status === 'cancelled') {
      throw new AccountingError(`${document.documentNumber} is ${document.status}.`);
    }

    if (gt(applied, document.balanceDue)) {
      throw new AccountingError(
        `Cannot apply ${applied} to ${document.documentNumber}: only ${document.balanceDue} is outstanding.`,
      );
    }

    await tx.insert(paymentAllocations).values({
      companyId: ctx.companyId,
      paymentId,
      documentId: allocation.documentId,
      amountApplied: applied,
    });
  }
}

/** Allocates an existing unapplied payment to further documents. */
export async function allocatePayment(
  ctx: TenantContext,
  paymentId: string,
  allocations: AllocationInput[],
): Promise<void> {
  requirePermission(ctx, PERMISSIONS.payments.create);

  await db.transaction(async (tx) => {
    const [payment] = await tx
      .select()
      .from(payments)
      .where(and(eq(payments.id, paymentId), eq(payments.companyId, ctx.companyId)))
      .for('update')
      .limit(1);

    if (!payment) throw new NotFoundError('Payment');
    if (payment.status === 'void') {
      throw new ConflictError('A void payment cannot be allocated');
    }

    const additional = sum(allocations.map((a) => money(a.amountApplied)));
    const newTotal = add(payment.allocatedAmount, additional);

    if (gt(newTotal, payment.amount)) {
      throw new AccountingError(
        `Cannot allocate ${additional} more: the payment is ${payment.amount} and ` +
          `${payment.allocatedAmount} is already applied (${payment.unappliedAmount} remains).`,
      );
    }

    await applyAllocations(
      tx,
      ctx,
      paymentId,
      allocations,
      payment.direction as PaymentDirection,
    );

    await tx
      .update(payments)
      .set({
        allocatedAmount: newTotal,
        unappliedAmount: subtract(payment.amount, newTotal),
        updatedAt: sql`now()`,
      })
      .where(eq(payments.id, paymentId));

    for (const allocation of allocations) {
      await refreshDocumentBalance(tx, ctx.companyId, allocation.documentId);
    }

    await recordAudit(tx, ctx, {
      action: 'payment.allocated',
      entityType: 'payment',
      entityId: paymentId,
      newValues: { allocated: additional, totalAllocated: newTotal },
    });
  });
}

/** Removes an allocation, returning the amount to the payment's unapplied pool. */
export async function removeAllocation(
  ctx: TenantContext,
  allocationId: string,
): Promise<void> {
  requirePermission(ctx, PERMISSIONS.payments.create);

  await db.transaction(async (tx) => {
    const [allocation] = await tx
      .select()
      .from(paymentAllocations)
      .where(
        and(
          eq(paymentAllocations.id, allocationId),
          eq(paymentAllocations.companyId, ctx.companyId),
        ),
      )
      .limit(1);

    if (!allocation) throw new NotFoundError('Allocation');

    await tx.delete(paymentAllocations).where(eq(paymentAllocations.id, allocationId));

    const [payment] = await tx
      .select()
      .from(payments)
      .where(eq(payments.id, allocation.paymentId))
      .limit(1);

    if (payment) {
      const newAllocated = subtract(payment.allocatedAmount, allocation.amountApplied);
      await tx
        .update(payments)
        .set({
          allocatedAmount: newAllocated,
          unappliedAmount: subtract(payment.amount, newAllocated),
          updatedAt: sql`now()`,
        })
        .where(eq(payments.id, payment.id));
    }

    await refreshDocumentBalance(tx, ctx.companyId, allocation.documentId);

    await recordAudit(tx, ctx, {
      action: 'payment.allocation_removed',
      entityType: 'payment',
      entityId: allocation.paymentId,
      previousValues: {
        documentId: allocation.documentId,
        amount: allocation.amountApplied,
      },
    });
  });
}

/**
 * Voids a payment: reverses its ledger entry, drops its allocations, and
 * restores the balances of every document it had settled.
 */
export async function voidPayment(
  ctx: TenantContext,
  paymentId: string,
  reason: string,
): Promise<void> {
  requirePermission(ctx, PERMISSIONS.payments.delete);

  if (!reason?.trim()) {
    throw new ValidationError('A reason is required when voiding a payment');
  }

  await db.transaction(async (tx) => {
    const [payment] = await tx
      .select()
      .from(payments)
      .where(and(eq(payments.id, paymentId), eq(payments.companyId, ctx.companyId)))
      .for('update')
      .limit(1);

    if (!payment) throw new NotFoundError('Payment');
    if (payment.status === 'void') throw new ConflictError('This payment is already void');

    const existing = await tx
      .select()
      .from(paymentAllocations)
      .where(eq(paymentAllocations.paymentId, paymentId));

    await tx.delete(paymentAllocations).where(eq(paymentAllocations.paymentId, paymentId));

    if (payment.journalEntryId) {
      await reverseJournalEntry(
        ctx,
        payment.journalEntryId,
        { reason: `Void payment ${payment.paymentNumber}: ${reason}` },
        { tx },
      );
    }

    await tx
      .update(payments)
      .set({
        status: 'void',
        allocatedAmount: '0',
        unappliedAmount: '0',
        updatedAt: sql`now()`,
      })
      .where(eq(payments.id, paymentId));

    for (const allocation of existing) {
      await refreshDocumentBalance(tx, ctx.companyId, allocation.documentId);
    }

    await recordAudit(tx, ctx, {
      action: 'payment.voided',
      entityType: 'payment',
      entityId: paymentId,
      previousValues: { status: payment.status, amount: payment.amount },
      newValues: { status: 'void' },
      reason,
    });
  });
}

/** Open documents a payment could be applied to, newest first. */
export async function listOpenDocuments(
  ctx: TenantContext,
  params: { contactId: string; direction: PaymentDirection },
) {
  const documentDirection = params.direction === 'receipt' ? 'outbound' : 'inbound';

  return db
    .select({
      id: documents.id,
      documentNumber: documents.documentNumber,
      issueDate: documents.issueDate,
      dueDate: documents.dueDate,
      currencyCode: documents.currencyCode,
      total: documents.total,
      amountPaid: documents.amountPaid,
      balanceDue: documents.balanceDue,
      status: documents.status,
    })
    .from(documents)
    .where(
      and(
        eq(documents.companyId, ctx.companyId),
        eq(documents.contactId, params.contactId),
        eq(documents.direction, documentDirection),
        sql`${documents.balanceDue} > 0`,
        // Only posted documents carry a real receivable/payable to settle.
        isNotNull(documents.journalEntryId),
        inArray(documents.status, ['approved', 'sent', 'partially_paid', 'overdue']),
      ),
    )
    .orderBy(documents.issueDate);
}

export async function listPayments(
  ctx: TenantContext,
  filters: {
    direction?: PaymentDirection;
    contactId?: string;
    from?: string;
    to?: string;
    limit?: number;
    offset?: number;
  } = {},
) {
  requirePermission(ctx, PERMISSIONS.payments.view);

  const conditions = [eq(payments.companyId, ctx.companyId)];
  if (filters.direction) conditions.push(eq(payments.direction, filters.direction));
  if (filters.contactId) conditions.push(eq(payments.contactId, filters.contactId));
  if (filters.from) conditions.push(sql`${payments.paymentDate} >= ${filters.from}`);
  if (filters.to) conditions.push(sql`${payments.paymentDate} <= ${filters.to}`);

  return db
    .select({
      id: payments.id,
      paymentNumber: payments.paymentNumber,
      direction: payments.direction,
      paymentDate: payments.paymentDate,
      method: payments.method,
      currencyCode: payments.currencyCode,
      amount: payments.amount,
      allocatedAmount: payments.allocatedAmount,
      unappliedAmount: payments.unappliedAmount,
      status: payments.status,
      contactName: contacts.displayName,
    })
    .from(payments)
    .leftJoin(contacts, eq(contacts.id, payments.contactId))
    .where(and(...conditions))
    .orderBy(desc(payments.paymentDate))
    .limit(filters.limit ?? 50)
    .offset(filters.offset ?? 0);
}
