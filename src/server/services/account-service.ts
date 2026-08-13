import 'server-only';

import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';

import { db, type Executor, type Tx } from '@/db';
import { accounts, journalLines } from '@/db/schema';
import { requirePermission, type TenantContext } from '@/server/auth/context';
import { PERMISSIONS } from '@/server/auth/permissions';
import { AccountingError, ConflictError, NotFoundError, ValidationError } from '@/server/errors';
import { subtract } from '@/lib/money';

import { recordAudit, diffValues } from './audit-service';
import { getTemplate, type AccountRole, type TemplateAccount } from './coa-templates';

export type AccountRow = typeof accounts.$inferSelect;

/**
 * Debit-normal account types. An asset or expense increases on the debit side;
 * everything else increases on the credit side. Derived rather than stored so
 * the two can never contradict each other.
 */
const DEBIT_NORMAL = new Set(['asset', 'expense']);

export function normalBalance(type: string): 'debit' | 'credit' {
  return DEBIT_NORMAL.has(type) ? 'debit' : 'credit';
}

/**
 * Signs a raw debit/credit pair according to the account's normal balance, so
 * a report shows a positive number for the ordinary case. A revenue account
 * with 1,000 credit reads as +1,000, not −1,000.
 */
export function signedBalance(type: string, debit: string, credit: string): string {
  // Exact subtraction: these are numeric(20,6) strings straight from the
  // ledger, and routing a balance through a JS number would both lose
  // precision on large figures and reintroduce binary-fraction drift into
  // numbers every report displays.
  return normalBalance(type) === 'debit'
    ? subtract(debit, credit)
    : subtract(credit, debit);
}

/** Installs a template's accounts for a company, resolving parents and paths. */
export async function applyCoaTemplate(
  tx: Executor,
  companyId: string,
  templateKey: string,
): Promise<Map<string, string>> {
  const template = getTemplate(templateKey);
  return insertAccountTree(tx, companyId, template.accounts);
}

/**
 * Inserts accounts parent-before-child so each row can reference its parent's
 * id and inherit its materialized `path`. Returns code → id for callers that
 * need to wire up defaults afterwards.
 */
async function insertAccountTree(
  tx: Executor,
  companyId: string,
  template: TemplateAccount[],
): Promise<Map<string, string>> {
  const byCode = new Map<string, TemplateAccount>(template.map((a) => [a.code, a]));
  const idByCode = new Map<string, string>();
  const pathByCode = new Map<string, string>();

  const depthOf = (account: TemplateAccount): number => {
    let depth = 0;
    let cursor = account;
    while (cursor.parent) {
      const parent = byCode.get(cursor.parent);
      if (!parent) break;
      cursor = parent;
      depth++;
    }
    return depth;
  };

  // Shallowest first: a parent is always inserted before its children.
  const ordered = [...template].sort((a, b) => depthOf(a) - depthOf(b));

  for (const account of ordered) {
    const parentId = account.parent ? idByCode.get(account.parent) ?? null : null;
    const parentPath = account.parent ? pathByCode.get(account.parent) : undefined;
    const path = parentPath ? `${parentPath}.${account.code}` : account.code;
    const depth = depthOf(account);

    const [row] = await tx
      .insert(accounts)
      .values({
        companyId,
        code: account.code,
        name: account.name,
        description: account.description ?? null,
        type: account.type,
        subtype: account.subtype,
        parentId,
        path,
        depth,
        isPostable: account.isPostable ?? true,
        isControlAccount: account.isControlAccount ?? false,
        role: account.role ?? null,
      })
      .returning({ id: accounts.id });

    if (row) {
      idByCode.set(account.code, row.id);
      pathByCode.set(account.code, path);
    }
  }

  return idByCode;
}

/**
 * Resolves an account by its functional role.
 *
 * Every subledger posting goes through here rather than hardcoding a code like
 * '1130' — that indirection is what keeps the engine working when a client
 * renumbers their chart (spec §39).
 */
export async function resolveAccountByRole(
  tx: Executor,
  companyId: string,
  role: AccountRole,
): Promise<AccountRow> {
  const [account] = await tx
    .select()
    .from(accounts)
    .where(and(eq(accounts.companyId, companyId), eq(accounts.role, role)))
    .limit(1);

  if (!account) {
    throw new AccountingError(
      `No account is configured for the "${role}" role. ` +
        'Set it in Settings → Chart of Accounts before posting this document.',
    );
  }
  if (account.isArchived) {
    throw new AccountingError(
      `The account configured for "${role}" (${account.code}) is archived. Assign an active account.`,
    );
  }
  return account;
}

export async function listAccounts(
  ctx: TenantContext,
  options: { includeArchived?: boolean; type?: string; search?: string } = {},
): Promise<AccountRow[]> {
  requirePermission(ctx, PERMISSIONS.accounts.view);

  const conditions = [eq(accounts.companyId, ctx.companyId)];
  if (!options.includeArchived) conditions.push(eq(accounts.isArchived, false));
  if (options.type) conditions.push(eq(accounts.type, options.type as AccountRow['type']));
  if (options.search) {
    const term = `%${options.search.toLowerCase()}%`;
    conditions.push(
      sql`(lower(${accounts.name}) like ${term} or lower(${accounts.code}) like ${term})`,
    );
  }

  return db
    .select()
    .from(accounts)
    .where(and(...conditions))
    .orderBy(asc(accounts.code));
}

/** Accounts arranged as a tree, for the chart-of-accounts screen. */
export async function getAccountTree(ctx: TenantContext, includeArchived = false) {
  const rows = await listAccounts(ctx, { includeArchived });
  type Node = AccountRow & { children: Node[] };

  const nodes = new Map<string, Node>(rows.map((r) => [r.id, { ...r, children: [] }]));
  const roots: Node[] = [];

  for (const node of nodes.values()) {
    const parent = node.parentId ? nodes.get(node.parentId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

export async function createAccount(
  ctx: TenantContext,
  input: {
    code: string;
    name: string;
    type: AccountRow['type'];
    subtype: AccountRow['subtype'];
    parentId?: string | null;
    description?: string | null;
    isPostable?: boolean;
    currencyCode?: string | null;
  },
): Promise<AccountRow> {
  requirePermission(ctx, PERMISSIONS.accounts.manage);

  if (!/^[\w.-]+$/.test(input.code)) {
    throw new ValidationError('Account code may contain only letters, numbers, dots and dashes');
  }

  return db.transaction(async (tx) => {
    let path = input.code;
    let depth = 0;

    if (input.parentId) {
      const [parent] = await tx
        .select()
        .from(accounts)
        .where(and(eq(accounts.id, input.parentId), eq(accounts.companyId, ctx.companyId)))
        .limit(1);

      if (!parent) throw new NotFoundError('Parent account');
      if (parent.type !== input.type) {
        throw new ValidationError(
          `A ${input.type} account cannot sit under a ${parent.type} account — ` +
            'the two would report in different statements.',
        );
      }
      path = `${parent.path}.${input.code}`;
      depth = parent.depth + 1;

      // A parent holding postings must stop being postable, or its own balance
      // and the sum of its children would double-count in a rollup.
      if (parent.isPostable) {
        await tx
          .update(accounts)
          .set({ isPostable: false, updatedAt: sql`now()` })
          .where(eq(accounts.id, parent.id));
      }
    }

    const existing = await tx
      .select({ id: accounts.id })
      .from(accounts)
      .where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.code, input.code)))
      .limit(1);

    if (existing.length > 0) {
      throw new ConflictError(`Account code ${input.code} is already in use`);
    }

    const [created] = await tx
      .insert(accounts)
      .values({
        companyId: ctx.companyId,
        code: input.code,
        name: input.name,
        type: input.type,
        subtype: input.subtype,
        parentId: input.parentId ?? null,
        description: input.description ?? null,
        path,
        depth,
        isPostable: input.isPostable ?? true,
        currencyCode: input.currencyCode ?? null,
      })
      .returning();

    if (!created) throw new ConflictError('Failed to create account');

    await recordAudit(tx, ctx, {
      action: 'account.created',
      entityType: 'account',
      entityId: created.id,
      newValues: { code: created.code, name: created.name, type: created.type },
    });

    return created;
  });
}

export async function updateAccount(
  ctx: TenantContext,
  accountId: string,
  updates: Partial<Pick<AccountRow, 'name' | 'description' | 'subtype' | 'currencyCode'>>,
): Promise<AccountRow> {
  requirePermission(ctx, PERMISSIONS.accounts.manage);

  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(accounts)
      .where(and(eq(accounts.id, accountId), eq(accounts.companyId, ctx.companyId)))
      .limit(1);

    if (!existing) throw new NotFoundError('Account');

    const diff = diffValues(existing as Record<string, unknown>, updates);

    const [updated] = await tx
      .update(accounts)
      .set({ ...updates, updatedAt: sql`now()` })
      .where(eq(accounts.id, accountId))
      .returning();

    if (!updated) throw new ConflictError('Failed to update account');

    if (diff) {
      await recordAudit(tx, ctx, {
        action: 'account.updated',
        entityType: 'account',
        entityId: accountId,
        ...diff,
      });
    }
    return updated;
  });
}

/**
 * Archives an account. Deletion is offered only when the account has never
 * been used — otherwise the ledger would lose the meaning of historical lines
 * (spec §7: "Prevent deletion of accounts that are referenced by posted
 * transactions. Use archive/deactivation instead.").
 */
export async function archiveAccount(
  ctx: TenantContext,
  accountId: string,
  archived = true,
): Promise<void> {
  requirePermission(ctx, PERMISSIONS.accounts.manage);

  await db.transaction(async (tx) => {
    const [account] = await tx
      .select()
      .from(accounts)
      .where(and(eq(accounts.id, accountId), eq(accounts.companyId, ctx.companyId)))
      .limit(1);

    if (!account) throw new NotFoundError('Account');

    if (archived) {
      const children = await tx
        .select({ id: accounts.id })
        .from(accounts)
        .where(
          and(
            eq(accounts.companyId, ctx.companyId),
            eq(accounts.parentId, accountId),
            eq(accounts.isArchived, false),
          ),
        )
        .limit(1);

      if (children.length > 0) {
        throw new ConflictError('Archive or move the child accounts first');
      }
      if (account.role) {
        throw new ConflictError(
          `Account ${account.code} is assigned the "${account.role}" role and is required for posting. ` +
            'Assign the role to another account before archiving this one.',
        );
      }
    }

    await tx
      .update(accounts)
      .set({ isArchived: archived, updatedAt: sql`now()` })
      .where(eq(accounts.id, accountId));

    await recordAudit(tx, ctx, {
      action: archived ? 'account.archived' : 'account.unarchived',
      entityType: 'account',
      entityId: accountId,
      previousValues: { isArchived: account.isArchived },
      newValues: { isArchived: archived },
    });
  });
}

/** True when the account has never appeared on a journal line. */
export async function accountHasTransactions(
  ctx: TenantContext,
  accountId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: journalLines.id })
    .from(journalLines)
    .where(
      and(eq(journalLines.companyId, ctx.companyId), eq(journalLines.accountId, accountId)),
    )
    .limit(1);
  return Boolean(row);
}

export async function deleteAccount(ctx: TenantContext, accountId: string): Promise<void> {
  requirePermission(ctx, PERMISSIONS.accounts.manage);

  if (await accountHasTransactions(ctx, accountId)) {
    throw new ConflictError(
      'This account has transactions and cannot be deleted. Archive it instead so history stays intact.',
    );
  }

  await db.transaction(async (tx) => {
    const [account] = await tx
      .select()
      .from(accounts)
      .where(and(eq(accounts.id, accountId), eq(accounts.companyId, ctx.companyId)))
      .limit(1);

    if (!account) throw new NotFoundError('Account');
    if (account.role) {
      throw new ConflictError(
        `Account ${account.code} fills the "${account.role}" role and cannot be deleted.`,
      );
    }

    await recordAudit(tx, ctx, {
      action: 'account.deleted',
      entityType: 'account',
      entityId: accountId,
      previousValues: { code: account.code, name: account.name },
    });

    await tx.delete(accounts).where(eq(accounts.id, accountId));
  });
}

/** Assigns a functional role to an account, clearing it from any other. */
export async function assignAccountRole(
  ctx: TenantContext,
  accountId: string,
  role: AccountRole,
): Promise<void> {
  requirePermission(ctx, PERMISSIONS.settings.manage);

  await db.transaction(async (tx) => {
    // The partial unique index permits only one holder per role, so the
    // previous holder must be cleared in the same transaction.
    await tx
      .update(accounts)
      .set({ role: null, updatedAt: sql`now()` })
      .where(and(eq(accounts.companyId, ctx.companyId), eq(accounts.role, role)));

    const [updated] = await tx
      .update(accounts)
      .set({ role, updatedAt: sql`now()` })
      .where(and(eq(accounts.id, accountId), eq(accounts.companyId, ctx.companyId)))
      .returning({ id: accounts.id });

    if (!updated) throw new NotFoundError('Account');

    await recordAudit(tx, ctx, {
      action: 'account.role_assigned',
      entityType: 'account',
      entityId: accountId,
      newValues: { role },
    });
  });
}
