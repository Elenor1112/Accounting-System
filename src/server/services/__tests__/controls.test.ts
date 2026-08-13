/**
 * Internal-control integration tests.
 *
 * These cover the three findings the audit called absolute blockers: approval
 * workflows that were configured but never enforced, the absence of any
 * segregation of duties, and the period lock that silently did not apply where
 * no period existed. Each asserts the *ledger* outcome rather than a return
 * value — the question is always whether value reached the general ledger, not
 * whether a function returned without throwing.
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import { and, eq } from 'drizzle-orm';

import { closeDb, db } from '@/db';
import { approvals, auditLogs, documents, journalEntries, journalLines } from '@/db/schema';
import { ForbiddenError } from '@/server/errors';
import { PERMISSIONS, ALL_PERMISSIONS } from '@/server/auth/permissions';
import { listAuditLogs } from '@/server/services/audit-service';
import { createContact } from '@/server/services/contact-service';
import { createDocument, postDocument } from '@/server/services/document-service';
import { createWorkflow, decideApproval, getApprovalStatus } from '@/server/services/workflow-service';
import { createJournalEntry } from '@/server/services/journal-service';

import { createTestCompany, destroyTestCompany, type TestCompany } from './harness';

/** Permissions minus the self-approval overrides, i.e. real segregation. */
const WITHOUT_SELF_APPROVAL = ALL_PERMISSIONS.filter(
  (p) =>
    p !== PERMISSIONS.selfApproval.documents && p !== PERMISSIONS.selfApproval.expenses,
);

describe('internal controls', () => {
  let co: TestCompany;
  let customerId: string;

  const today = new Date().toISOString().slice(0, 10);

  before(async () => {
    co = await createTestCompany({ permissions: WITHOUT_SELF_APPROVAL });
    const customer = await createContact(co.ctx, {
      kind: 'customer',
      displayName: 'Approval Test Customer',
    });
    customerId = customer.id;
  });

  after(async () => {
    await destroyTestCompany(co);
    await closeDb();
  });

  /** An invoice for `total`, raised by the default (maker) user. */
  async function draftInvoice(total: string) {
    return createDocument(co.ctx, {
      direction: 'outbound',
      documentType: 'invoice',
      contactId: customerId,
      issueDate: today,
      lines: [
        {
          description: 'Consulting',
          quantity: '1',
          unitPrice: total,
          accountId: co.accountId('4100'),
        },
      ],
    });
  }

  async function ledgerEntryFor(documentId: string) {
    const [row] = await db
      .select()
      .from(journalEntries)
      .where(
        and(
          eq(journalEntries.companyId, co.companyId),
          eq(journalEntries.sourceId, documentId),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  // ---------------------------------------------------------------- approvals

  test('a document above the configured threshold cannot post without approval', async () => {
    await createWorkflow(co.ctx, {
      documentType: 'invoice',
      name: 'Large invoices need the controller',
      steps: [
        {
          name: 'Financial controller sign-off',
          approverRoleKey: 'financial_controller',
          minAmount: '50000',
        },
      ],
    });

    const invoice = await draftInvoice('75000');
    const result = await postDocument(co.ctx, invoice.id);

    // It must NOT have posted.
    assert.ok('pendingApproval' in result, 'document posted despite the threshold');
    assert.equal(result.stepsRequired, 1);

    const [row] = await db
      .select()
      .from(documents)
      .where(eq(documents.id, invoice.id));
    assert.equal(row?.status, 'pending_approval');
    assert.equal(row?.journalEntryId, null);

    // The decisive assertion: nothing reached the ledger.
    assert.equal(await ledgerEntryFor(invoice.id), null);

    // And the approval row the inbox reads actually exists.
    const chain = await getApprovalStatus(co.ctx, 'document', invoice.id);
    assert.equal(chain.length, 1);
    assert.equal(chain[0]?.status, 'pending');
  });

  test('a document below the threshold posts without an approval chain', async () => {
    const invoice = await draftInvoice('1000');
    const result = await postDocument(co.approver, invoice.id);

    assert.ok('journalEntryId' in result, 'small invoice should post directly');
    assert.equal((await getApprovalStatus(co.ctx, 'document', invoice.id)).length, 0);
    assert.ok(await ledgerEntryFor(invoice.id));
  });

  test('a user without the required role cannot approve the step', async () => {
    const invoice = await draftInvoice('60000');
    await postDocument(co.ctx, invoice.id);

    // Holds every permission, but not the role the step names.
    const wrongRole = co.userWith(ALL_PERMISSIONS, 'bookkeeper');

    await assert.rejects(
      decideApproval(wrongRole, {
        entityType: 'document',
        entityId: invoice.id,
        decision: 'approved',
      }),
      /requires the "financial_controller" role/,
    );

    assert.equal(await ledgerEntryFor(invoice.id), null);
  });

  test('the creator cannot approve their own document', async () => {
    const invoice = await draftInvoice('65000');
    await postDocument(co.ctx, invoice.id);

    // co.ctx raised it; the role key matches the step, so only the
    // maker-checker rule stands between this user and their own approval.
    const maker = co.userWith(WITHOUT_SELF_APPROVAL, 'financial_controller');
    const selfApprove = { ...maker, userId: co.userId };

    await assert.rejects(
      decideApproval(selfApprove, {
        entityType: 'document',
        entityId: invoice.id,
        decision: 'approved',
      }),
      (err: Error) => {
        assert.ok(err instanceof ForbiddenError);
        assert.match(err.message, /cannot also approve it/);
        return true;
      },
    );

    assert.equal(await ledgerEntryFor(invoice.id), null);
  });

  test('the required approver approves and the document posts to the ledger', async () => {
    const invoice = await draftInvoice('80000');
    await postDocument(co.ctx, invoice.id);
    assert.equal(await ledgerEntryFor(invoice.id), null);

    const decision = await decideApproval(co.approver, {
      entityType: 'document',
      entityId: invoice.id,
      decision: 'approved',
      comment: 'Reviewed against the signed contract',
    });

    assert.equal(decision.complete, true);
    assert.equal(decision.remaining, 0);
    assert.ok(decision.journalEntryId, 'final approval must post the document');

    const [row] = await db.select().from(documents).where(eq(documents.id, invoice.id));
    assert.equal(row?.journalEntryId, decision.journalEntryId);

    // The ledger effect is a real, balanced entry.
    const entry = await ledgerEntryFor(invoice.id);
    assert.ok(entry);
    assert.equal(entry.status, 'posted');
    assert.equal(entry.totalDebit, entry.totalCredit);

    const lines = await db
      .select()
      .from(journalLines)
      .where(eq(journalLines.entryId, entry.id));

    // Dr Accounts Receivable 80,000 / Cr Revenue 80,000.
    const ar = lines.find((l) => l.accountId === co.accountId('1130'));
    const revenue = lines.find((l) => l.accountId === co.accountId('4100'));
    assert.equal(Number(ar?.baseDebit), 80000);
    assert.equal(Number(revenue?.baseCredit), 80000);
  });

  test('a rejection returns the document to draft and posts nothing', async () => {
    const invoice = await draftInvoice('90000');
    await postDocument(co.ctx, invoice.id);

    const decision = await decideApproval(co.approver, {
      entityType: 'document',
      entityId: invoice.id,
      decision: 'rejected',
      comment: 'No purchase order on file',
    });

    assert.equal(decision.complete, false);
    assert.equal(decision.journalEntryId, null);

    const [row] = await db.select().from(documents).where(eq(documents.id, invoice.id));
    assert.equal(row?.status, 'draft');
    assert.equal(row?.journalEntryId, null);
    assert.equal(await ledgerEntryFor(invoice.id), null);

    // The refusal is preserved rather than erased.
    const chain = await getApprovalStatus(co.ctx, 'document', invoice.id);
    assert.equal(chain[0]?.status, 'rejected');
    assert.equal(chain[0]?.comment, 'No purchase order on file');
  });

  test('a rejected document cannot be posted directly afterwards', async () => {
    const invoice = await draftInvoice('95000');
    await postDocument(co.ctx, invoice.id);
    await decideApproval(co.approver, {
      entityType: 'document',
      entityId: invoice.id,
      decision: 'rejected',
      comment: 'Wrong customer',
    });

    await assert.rejects(postDocument(co.approver, invoice.id), /was rejected in approval/);
    assert.equal(await ledgerEntryFor(invoice.id), null);
  });

  test('re-posting a pending document does not duplicate its approval chain', async () => {
    const invoice = await draftInvoice('55000');
    await postDocument(co.ctx, invoice.id);
    await postDocument(co.ctx, invoice.id);

    const rows = await db
      .select()
      .from(approvals)
      .where(
        and(
          eq(approvals.companyId, co.companyId),
          eq(approvals.entityType, 'document'),
          eq(approvals.entityId, invoice.id),
        ),
      );
    assert.equal(rows.length, 1);
  });

  // ------------------------------------------------- segregation of duties

  test('the creator cannot post their own document even with no workflow', async () => {
    // Below the 50,000 threshold, so no chain applies and only the
    // maker-checker rule is in play.
    const invoice = await draftInvoice('900');

    await assert.rejects(postDocument(co.ctx, invoice.id), (err: Error) => {
      assert.ok(err instanceof ForbiddenError);
      assert.match(err.message, /cannot also approve it/);
      return true;
    });

    assert.equal(await ledgerEntryFor(invoice.id), null);
  });

  test('an explicit self-approval grant lifts the block', async () => {
    const invoice = await draftInvoice('950');

    // The same user, now holding the override an administrator would grant to
    // a one-person business. The weakened control is a deliberate decision.
    const permissive = {
      ...co.ctx,
      permissions: [...WITHOUT_SELF_APPROVAL, PERMISSIONS.selfApproval.documents],
    };

    const result = await postDocument(permissive, invoice.id);
    assert.ok('journalEntryId' in result);
    assert.ok(await ledgerEntryFor(invoice.id));
  });

  // ------------------------------------------------------- period controls

  test('posting to a date with no accounting period is refused', async () => {
    // The harness creates last year, this year and next year. 1998 has no
    // period, and previously posted anyway with a null period id — escaping
    // both the lock and every period-based report.
    await assert.rejects(
      createJournalEntry(co.approver, {
        entryDate: '1998-06-15',
        lines: [
          { accountId: co.accountId('6200'), debit: '100' },
          { accountId: co.accountId('1120'), credit: '100' },
        ],
        post: true,
      }),
      /no accounting period covers that date/,
    );
  });

  test('posting far into the future is refused', async () => {
    const farFuture = new Date();
    farFuture.setUTCFullYear(farFuture.getUTCFullYear() + 5);

    await assert.rejects(
      createJournalEntry(co.approver, {
        entryDate: farFuture.toISOString().slice(0, 10),
        lines: [
          { accountId: co.accountId('6200'), debit: '100' },
          { accountId: co.accountId('1120'), credit: '100' },
        ],
        post: true,
      }),
      /in the future/,
    );
  });

  test('a draft may still be dated outside any period; only posting is barred', async () => {
    const draft = await createJournalEntry(co.approver, {
      entryDate: '1998-06-15',
      lines: [
        { accountId: co.accountId('6200'), debit: '100' },
        { accountId: co.accountId('1120'), credit: '100' },
      ],
    });
    assert.equal(draft.status, 'draft');
  });

  // ----------------------------------------------------------- audit log

  test('the audit log cannot be updated, even with direct SQL', async () => {
    // The control has to hold against a database connection, not merely
    // against the service layer — the party being audited is often the one
    // holding the credentials.
    const [row] = await db
      .select({ id: auditLogs.id })
      .from(auditLogs)
      .where(eq(auditLogs.companyId, co.companyId))
      .limit(1);

    assert.ok(row, 'expected the preceding tests to have written audit rows');

    // Drizzle wraps the Postgres message, so the assertion is that the write
    // is refused at all — and, below, that the row is genuinely unchanged.
    await assert.rejects(
      db
        .update(auditLogs)
        .set({ action: 'tampered.with' })
        .where(eq(auditLogs.id, row.id)),
    );

    const [after] = await db
      .select({ action: auditLogs.action })
      .from(auditLogs)
      .where(eq(auditLogs.id, row.id));
    assert.notEqual(after?.action, 'tampered.with', 'the audit row was modified');
  });

  test('the audit log cannot be deleted, even with direct SQL', async () => {
    const [row] = await db
      .select({ id: auditLogs.id })
      .from(auditLogs)
      .where(eq(auditLogs.companyId, co.companyId))
      .limit(1);

    assert.ok(row);

    await assert.rejects(db.delete(auditLogs).where(eq(auditLogs.id, row.id)));

    // Still there: the refusal was real, not a swallowed no-op.
    const [after] = await db
      .select({ id: auditLogs.id })
      .from(auditLogs)
      .where(eq(auditLogs.id, row.id));
    assert.ok(after, 'the audit row was deleted');
  });

  test('the audit log records who did what, and can be filtered by actor', async () => {
    // The question an auditor actually asks: "show me everything this user
    // did". Before filtering existed there was no way to answer it.
    const byApprover = await listAuditLogs(co.ctx, {
      actorId: co.approverUserId,
      limit: 200,
    });

    assert.ok(byApprover.length > 0, 'the approver posted documents in this suite');
    assert.ok(
      byApprover.every((r) => r.actorId === co.approverUserId),
      'the actor filter leaked another user’s rows',
    );

    // Approval decisions are preserved with their reason.
    const approvals = await listAuditLogs(co.ctx, { action: 'approval', limit: 200 });
    assert.ok(approvals.some((r) => r.action === 'approval.approved'));
    assert.ok(approvals.some((r) => r.action === 'approval.rejected'));
    assert.ok(
      approvals.some((r) => r.reason === 'No purchase order on file'),
      'the rejection comment must survive in the audit trail',
    );
  });

  test('the audit log can be filtered by entity and date', async () => {
    const today = new Date().toISOString().slice(0, 10);

    const documentRows = await listAuditLogs(co.ctx, {
      entityType: 'document',
      from: today,
      to: today,
      limit: 200,
    });

    assert.ok(documentRows.length > 0);
    assert.ok(documentRows.every((r) => r.entityType === 'document'));

    // A window that excludes today returns nothing, proving the date bound is
    // applied rather than ignored.
    const empty = await listAuditLogs(co.ctx, {
      from: '1999-01-01',
      to: '1999-12-31',
      limit: 200,
    });
    assert.equal(empty.length, 0);
  });
});
