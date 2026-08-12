import 'server-only';

import { and, asc, eq, sql } from 'drizzle-orm';

import { db, type Executor } from '@/db';
import { approvals, workflowSteps, workflows } from '@/db/schema';
import { requirePermission, type TenantContext } from '@/server/auth/context';
import { PERMISSIONS } from '@/server/auth/permissions';
import { ConflictError, ForbiddenError, NotFoundError } from '@/server/errors';
import { gte, money, type Money } from '@/lib/money';

import { recordAudit } from './audit-service';

export type WorkflowRow = typeof workflows.$inferSelect;
export type WorkflowStepRow = typeof workflowSteps.$inferSelect;

/**
 * Configurable approval workflows (spec §21).
 *
 * "Invoices over 50,000 need the finance manager" is a row in
 * `workflow_steps`, not a branch in the code. A new client configures their
 * chain; the engine never changes. Steps whose `minAmount` exceeds the
 * document total simply do not apply, so one workflow covers every band.
 */
export async function createWorkflow(
  ctx: TenantContext,
  input: {
    documentType: string;
    name: string;
    steps: Array<{ name: string; approverRoleKey?: string | null; minAmount?: Money | null }>;
  },
): Promise<WorkflowRow> {
  requirePermission(ctx, PERMISSIONS.settings.manage);

  return db.transaction(async (tx) => {
    const [workflow] = await tx
      .insert(workflows)
      .values({
        companyId: ctx.companyId,
        documentType: input.documentType,
        name: input.name,
      })
      .returning();

    if (!workflow) throw new ConflictError('Failed to create workflow');

    if (input.steps.length > 0) {
      await tx.insert(workflowSteps).values(
        input.steps.map((step, index) => ({
          companyId: ctx.companyId,
          workflowId: workflow.id,
          stepOrder: index + 1,
          name: step.name,
          approverRoleKey: step.approverRoleKey ?? null,
          minAmount: step.minAmount ?? null,
        })),
      );
    }

    await recordAudit(tx, ctx, {
      action: 'workflow.created',
      entityType: 'workflow',
      entityId: workflow.id,
      newValues: { name: input.name, documentType: input.documentType, stepCount: input.steps.length },
    });

    return workflow;
  });
}

/**
 * The steps that apply to a document of this type and amount.
 * Returns an empty array when no workflow is configured — meaning the document
 * needs no approval beyond the permission to post it.
 */
export async function getApplicableSteps(
  tx: Executor,
  params: { companyId: string; documentType: string; amount: Money },
): Promise<WorkflowStepRow[]> {
  const [workflow] = await tx
    .select()
    .from(workflows)
    .where(
      and(
        eq(workflows.companyId, params.companyId),
        eq(workflows.documentType, params.documentType),
        eq(workflows.isActive, true),
      ),
    )
    .limit(1);

  if (!workflow) return [];

  const steps = await tx
    .select()
    .from(workflowSteps)
    .where(eq(workflowSteps.workflowId, workflow.id))
    .orderBy(asc(workflowSteps.stepOrder));

  return steps.filter(
    (step) => !step.minAmount || gte(money(params.amount), step.minAmount),
  );
}

/** Opens the approval chain for a document, recording each pending step. */
export async function startApprovalChain(
  tx: Executor,
  ctx: TenantContext,
  params: { entityType: string; entityId: string; documentType: string; amount: Money },
): Promise<{ stepsRequired: number }> {
  const steps = await getApplicableSteps(tx, {
    companyId: ctx.companyId,
    documentType: params.documentType,
    amount: params.amount,
  });

  if (steps.length === 0) return { stepsRequired: 0 };

  await tx.insert(approvals).values(
    steps.map((step) => ({
      companyId: ctx.companyId,
      entityType: params.entityType,
      entityId: params.entityId,
      stepId: step.id,
      stepOrder: step.stepOrder,
      status: 'pending' as const,
    })),
  );

  return { stepsRequired: steps.length };
}

/**
 * Records an approval decision on the earliest pending step.
 *
 * Steps are approved in order: a later approver cannot sign off before an
 * earlier one, which is the entire point of a chain.
 */
export async function decideApproval(
  ctx: TenantContext,
  params: {
    entityType: string;
    entityId: string;
    decision: 'approved' | 'rejected';
    comment?: string;
  },
): Promise<{ complete: boolean; remaining: number }> {
  return db.transaction(async (tx) => {
    const pending = await tx
      .select()
      .from(approvals)
      .where(
        and(
          eq(approvals.companyId, ctx.companyId),
          eq(approvals.entityType, params.entityType),
          eq(approvals.entityId, params.entityId),
          eq(approvals.status, 'pending'),
        ),
      )
      .orderBy(asc(approvals.stepOrder));

    const next = pending[0];
    if (!next) throw new ConflictError('There are no pending approvals for this document');

    if (next.stepId) {
      const [step] = await tx
        .select()
        .from(workflowSteps)
        .where(eq(workflowSteps.id, next.stepId))
        .limit(1);

      // The step names a role; only holders of that role may decide it.
      if (step?.approverRoleKey && step.approverRoleKey !== ctx.roleKey) {
        throw new ForbiddenError(
          `This step requires the "${step.approverRoleKey}" role; you hold "${ctx.roleKey}".`,
        );
      }
    }

    await tx
      .update(approvals)
      .set({
        status: params.decision,
        actorId: ctx.userId,
        comment: params.comment ?? null,
        updatedAt: sql`now()`,
      })
      .where(eq(approvals.id, next.id));

    // A rejection cancels the rest of the chain: there is nothing left to
    // approve until the document is resubmitted.
    if (params.decision === 'rejected') {
      await tx
        .update(approvals)
        .set({ status: 'rejected', updatedAt: sql`now()` })
        .where(
          and(
            eq(approvals.companyId, ctx.companyId),
            eq(approvals.entityType, params.entityType),
            eq(approvals.entityId, params.entityId),
            eq(approvals.status, 'pending'),
          ),
        );
    }

    await recordAudit(tx, ctx, {
      action: `approval.${params.decision}`,
      entityType: params.entityType,
      entityId: params.entityId,
      newValues: { stepOrder: next.stepOrder, decision: params.decision },
      reason: params.comment ?? null,
    });

    const remaining = params.decision === 'rejected' ? 0 : pending.length - 1;
    return { complete: remaining === 0 && params.decision === 'approved', remaining };
  });
}

export async function getApprovalStatus(
  ctx: TenantContext,
  entityType: string,
  entityId: string,
) {
  return db
    .select({
      id: approvals.id,
      stepOrder: approvals.stepOrder,
      status: approvals.status,
      actorId: approvals.actorId,
      comment: approvals.comment,
      decidedAt: approvals.updatedAt,
      stepName: workflowSteps.name,
      approverRoleKey: workflowSteps.approverRoleKey,
    })
    .from(approvals)
    .leftJoin(workflowSteps, eq(workflowSteps.id, approvals.stepId))
    .where(
      and(
        eq(approvals.companyId, ctx.companyId),
        eq(approvals.entityType, entityType),
        eq(approvals.entityId, entityId),
      ),
    )
    .orderBy(asc(approvals.stepOrder));
}

/** Documents awaiting this user's decision — the approvals inbox. */
export async function listPendingApprovals(ctx: TenantContext) {
  return db
    .select({
      id: approvals.id,
      entityType: approvals.entityType,
      entityId: approvals.entityId,
      stepOrder: approvals.stepOrder,
      stepName: workflowSteps.name,
      approverRoleKey: workflowSteps.approverRoleKey,
      createdAt: approvals.createdAt,
    })
    .from(approvals)
    .leftJoin(workflowSteps, eq(workflowSteps.id, approvals.stepId))
    .where(and(eq(approvals.companyId, ctx.companyId), eq(approvals.status, 'pending')))
    .orderBy(asc(approvals.createdAt));
}

export async function listWorkflows(ctx: TenantContext) {
  requirePermission(ctx, PERMISSIONS.settings.manage);

  const rows = await db
    .select()
    .from(workflows)
    .where(eq(workflows.companyId, ctx.companyId));

  return Promise.all(
    rows.map(async (workflow) => ({
      ...workflow,
      steps: await db
        .select()
        .from(workflowSteps)
        .where(eq(workflowSteps.workflowId, workflow.id))
        .orderBy(asc(workflowSteps.stepOrder)),
    })),
  );
}

export async function deleteWorkflow(ctx: TenantContext, workflowId: string): Promise<void> {
  requirePermission(ctx, PERMISSIONS.settings.manage);

  const [existing] = await db
    .select()
    .from(workflows)
    .where(and(eq(workflows.id, workflowId), eq(workflows.companyId, ctx.companyId)))
    .limit(1);

  if (!existing) throw new NotFoundError('Workflow');

  await db.delete(workflows).where(eq(workflows.id, workflowId));
}
