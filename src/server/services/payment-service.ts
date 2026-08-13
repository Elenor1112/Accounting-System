import 'server-only';

import { and, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';

import { db, type Tx } from '@/db';
import {
  bankAccounts,
  contacts,
  documents,
  journalEntries,
  journalLines,
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

    /**
     * The part of the payment that settles documents, and the part that does
     * not.
     *
     * Only the allocated part belongs against AR/AP — that is the amount that
     * actually clears an invoice. The unapplied residue is money held on the
     * customer's behalf (or paid to a vendor ahead of a bill), which is a
     * liability or an asset in its own right:
     *
     *   Dr Bank                    10,500
     *     Cr Accounts Receivable         10,000   (settles the invoice)
     *     Cr Customer Advances              500   (held on account)
     *
     * Crediting the whole 10,500 to AR — the previous behaviour — left a
     * credit balance sitting in a receivable, presenting a liability as a
     * negative asset and understating both current assets and current
     * liabilities.
     */
    const unapplied = subtract(amount, allocationTotal);

    const entryLines: Array<Record<string, unknown>> = [
      {
        accountId: bankAccount.ledgerAccountId,
        ...(isReceipt ? { debit: amount } : { credit: amount }),
        description: `${isReceipt ? 'Received' : 'Paid'} via ${input.method ?? 'bank transfer'}`,
        branchId: input.branchId ?? null,
      },
    ];

    if (gt(allocationTotal, '0')) {
      entryLines.push({
        accountId: controlAccount.id,
        ...(isReceipt ? { credit: allocationTotal } : { debit: allocationTotal }),
        description: `${isReceipt ? 'Settle receivable' : 'Settle payable'} ${paymentNumber}`,
        customerId: isReceipt ? input.contactId ?? null : null,
        vendorId: isReceipt ? null : input.contactId ?? null,
        branchId: input.branchId ?? null,
      });
    }

    if (gt(unapplied, '0')) {
      const advanceAccount = await resolveAccountByRole(
        tx,
        ctx.companyId,
        isReceipt ? 'customer_advances' : 'vendor_prepayments',
      );
      entryLines.push({
        accountId: advanceAccount.id,
        ...(isReceipt ? { credit: unapplied } : { debit: unapplied }),
        description: `Unapplied ${isReceipt ? 'receipt' : 'payment'} ${paymentNumber}`,
        customerId: isReceipt ? input.contactId ?? null : null,
        vendorId: isReceipt ? null : input.contactId ?? null,
        branchId: input.branchId ?? null,
      });
    }

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
        lines: entryLines as never,
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

    /**
     * Applying an advance is a reclassification, and needs its own entry.
     *
     * The original receipt credited Customer Advances because it settled
     * nothing at the time. Now that it clears an invoice, the liability is
     * discharged and the receivable goes with it:
     *
     *   Dr Customer Advances       amount applied
     *     Cr Accounts Receivable        amount applied
     *
     * Without this the advance would sit in the liability account for ever
     * while the invoice showed as paid — the subledger would say settled and
     * the ledger would still carry both balances.
     */
    const isReceipt = payment.direction === 'receipt';

    const advanceAccount = await resolveAccountByRole(
      tx,
      ctx.companyId,
      isReceipt ? 'customer_advances' : 'vendor_prepayments',
    );
    const controlAccount = await resolveAccountByRole(
      tx,
      ctx.companyId,
      isReceipt ? 'accounts_receivable' : 'accounts_payable',
    );

    const reclassEntry = await createJournalEntry(
      ctx,
      {
        entryDate: payment.paymentDate,
        description: `Apply ${isReceipt ? 'advance' : 'prepayment'} ${payment.paymentNumber}`,
        reference: payment.reference,
        currencyCode: payment.currencyCode,
        exchangeRate: payment.exchangeRate,
        branchId: payment.branchId,
        sourceType: 'payment_allocation',
        sourceId: payment.id,
        lines: [
          {
            accountId: advanceAccount.id,
            ...(isReceipt ? { debit: additional } : { credit: additional }),
            description: `Applied to ${allocations.length} document(s)`,
            customerId: isReceipt ? payment.contactId : null,
            vendorId: isReceipt ? null : payment.contactId,
            branchId: payment.branchId,
          },
          {
            accountId: controlAccount.id,
            ...(isReceipt ? { credit: additional } : { debit: additional }),
            description: `Settle ${isReceipt ? 'receivable' : 'payable'} ${payment.paymentNumber}`,
            customerId: isReceipt ? payment.contactId : null,
            vendorId: isReceipt ? null : payment.contactId,
            branchId: payment.branchId,
          },
        ] as never,
        post: true,
      },
      { tx, allowControlAccounts: true },
    );

    for (const allocation of allocations) {
      await refreshDocumentBalance(tx, ctx.companyId, allocation.documentId);
    }

    await recordAudit(tx, ctx, {
      action: 'payment.allocated',
      entityType: 'payment',
      entityId: paymentId,
      newValues: {
        allocated: additional,
        totalAllocated: newTotal,
        journalEntryId: reclassEntry.id,
      },
    });
  });
}

/**
 * Refunds money held on account back to a customer (or recovers a prepayment
 * from a vendor).
 *
 *   Dr Customer Advances       refund amount
 *     Cr Bank                       refund amount
 *
 * Refunds are made against the *advance*, not against an invoice: an invoice
 * that was overpaid produced an advance in the first place, and a credit note
 * that was never applied does the same. Refunding straight out of AR would
 * re-create the negative-asset problem advances exist to avoid.
 *
 * The available pool is the contact's unapplied receipts, which is exactly the
 * balance sitting in the advances account for them.
 */
export async function refundContact(
  ctx: TenantContext,
  params: {
    contactId: string;
    bankAccountId: string;
    amount: Money;
    refundDate: string;
    direction?: PaymentDirection;
    reference?: string | null;
    notes?: string | null;
    branchId?: string | null;
  },
): Promise<{ paymentId: string; journalEntryId: string }> {
  requirePermission(ctx, PERMISSIONS.payments.create);
  requireBranchAccess(ctx, params.branchId ?? null);

  const amount = money(params.amount);
  if (!gt(amount, '0')) {
    throw new ValidationError('Refund amount must be greater than zero');
  }

  // Refunding a customer pays money out; recovering a vendor prepayment brings
  // money in. The advance being cleared is the customer's by default.
  const isCustomerRefund = (params.direction ?? 'disbursement') === 'disbursement';

  return db.transaction(async (tx) => {
    const [bankAccount] = await tx
      .select()
      .from(bankAccounts)
      .where(
        and(
          eq(bankAccounts.id, params.bankAccountId),
          eq(bankAccounts.companyId, ctx.companyId),
        ),
      )
      .limit(1);

    if (!bankAccount) throw new NotFoundError('Bank account');

    const advanceAccount = await resolveAccountByRole(
      tx,
      ctx.companyId,
      isCustomerRefund ? 'customer_advances' : 'vendor_prepayments',
    );

    /**
     * Refuse to refund more than is actually held.
     *
     * Read from the ledger rather than from the payments table: the advances
     * account balance for this contact is the authoritative figure, and it
     * already accounts for advances that have since been applied to invoices.
     */
    const [held] = await tx
      .select({
        debit: sql<string>`coalesce(sum(${journalLines.baseDebit}), 0)`,
        credit: sql<string>`coalesce(sum(${journalLines.baseCredit}), 0)`,
      })
      .from(journalLines)
      .innerJoin(journalEntries, eq(journalEntries.id, journalLines.entryId))
      .where(
        and(
          eq(journalLines.companyId, ctx.companyId),
          eq(journalLines.accountId, advanceAccount.id),
          isCustomerRefund
            ? eq(journalLines.customerId, params.contactId)
            : eq(journalLines.vendorId, params.contactId),
          sql`${journalEntries.status} in ('posted', 'reversed')`,
        ),
      );

    // Advances are credit-normal for a customer, debit-normal for a vendor.
    const available = isCustomerRefund
      ? subtract(held?.credit ?? '0', held?.debit ?? '0')
      : subtract(held?.debit ?? '0', held?.credit ?? '0');

    if (gt(amount, available)) {
      throw new AccountingError(
        `Cannot refund ${amount}: only ${available} is held on account for this contact. ` +
          'Apply a credit note or record the overpayment first.',
      );
    }

    const paymentNumber = await allocateDocumentNumber(tx, {
      companyId: ctx.companyId,
      documentType: 'payment',
      date: new Date(params.refundDate),
    });

    const [payment] = await tx
      .insert(payments)
      .values({
        companyId: ctx.companyId,
        branchId: params.branchId ?? null,
        direction: isCustomerRefund ? 'disbursement' : 'receipt',
        paymentNumber,
        contactId: params.contactId,
        paymentDate: params.refundDate,
        method: 'bank_transfer',
        reference: params.reference ?? null,
        currencyCode: bankAccount.currencyCode,
        exchangeRate: '1',
        amount,
        // A refund settles no document: it discharges the advance itself.
        allocatedAmount: amount,
        unappliedAmount: '0',
        bankAccountId: params.bankAccountId,
        status: 'draft',
        notes: params.notes ?? `Refund of amounts held on account`,
        createdById: ctx.userId,
      })
      .returning();

    if (!payment) throw new ConflictError('Failed to create refund');

    const entry = await createJournalEntry(
      ctx,
      {
        entryDate: params.refundDate,
        description: `Refund ${paymentNumber}`,
        reference: params.reference,
        currencyCode: bankAccount.currencyCode,
        branchId: params.branchId ?? null,
        sourceType: 'refund',
        sourceId: payment.id,
        lines: [
          {
            accountId: advanceAccount.id,
            [isCustomerRefund ? 'debit' : 'credit']: amount,
            description: `Refund of amounts held on account`,
            customerId: isCustomerRefund ? params.contactId : null,
            vendorId: isCustomerRefund ? null : params.contactId,
            branchId: params.branchId ?? null,
          },
          {
            accountId: bankAccount.ledgerAccountId,
            [isCustomerRefund ? 'credit' : 'debit']: amount,
            description: `Refund ${paymentNumber}`,
            branchId: params.branchId ?? null,
          },
        ] as never,
        post: true,
      },
      { tx },
    );

    await tx
      .update(payments)
      .set({ status: 'posted', journalEntryId: entry.id, updatedAt: sql`now()` })
      .where(eq(payments.id, payment.id));

    await recordAudit(tx, ctx, {
      action: 'payment.refunded',
      entityType: 'payment',
      entityId: payment.id,
      newValues: { paymentNumber, amount, contactId: params.contactId },
    });

    return { paymentId: payment.id, journalEntryId: entry.id };
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
