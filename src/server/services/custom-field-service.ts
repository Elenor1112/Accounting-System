import 'server-only';

import { and, asc, eq, inArray, sql } from 'drizzle-orm';

import { db, type Executor } from '@/db';
import { customFieldDefinitions, customFieldValues } from '@/db/schema';
import { requirePermission, type TenantContext } from '@/server/auth/context';
import { PERMISSIONS } from '@/server/auth/permissions';
import { NotFoundError, ValidationError } from '@/server/errors';

import { recordAudit } from './audit-service';

export type CustomFieldDefinition = typeof customFieldDefinitions.$inferSelect;

/**
 * Custom fields (spec §20).
 *
 * A client adding a field is a data change, not a migration: definitions
 * describe the field, values live keyed by entity id. That costs a join on
 * read, but it is what lets the same deployment serve a construction firm
 * tracking "Site Reference" and an agency tracking "Campaign Code" without
 * either one's schema knowing about the other.
 */
export async function createCustomField(
  ctx: TenantContext,
  input: {
    entityType: string;
    key: string;
    label: string;
    fieldType: CustomFieldDefinition['fieldType'];
    options?: Array<{ value: string; label: string }>;
    isRequired?: boolean;
    showInList?: boolean;
  },
): Promise<CustomFieldDefinition> {
  requirePermission(ctx, PERMISSIONS.settings.manage);

  if (!/^[a-z][a-z0-9_]*$/.test(input.key)) {
    throw new ValidationError(
      'Field key must start with a letter and contain only lowercase letters, numbers and underscores',
    );
  }
  if (
    (input.fieldType === 'select' || input.fieldType === 'multi_select') &&
    (!input.options || input.options.length === 0)
  ) {
    throw new ValidationError('A select field needs at least one option');
  }

  const [created] = await db
    .insert(customFieldDefinitions)
    .values({
      companyId: ctx.companyId,
      entityType: input.entityType,
      key: input.key,
      label: input.label,
      fieldType: input.fieldType,
      options: input.options ?? [],
      isRequired: input.isRequired ?? false,
      showInList: input.showInList ?? false,
    })
    .returning();

  if (!created) {
    throw new ValidationError(`A field with key "${input.key}" already exists for this entity`);
  }
  return created;
}

export async function listCustomFields(
  ctx: TenantContext,
  entityType: string,
): Promise<CustomFieldDefinition[]> {
  return db
    .select()
    .from(customFieldDefinitions)
    .where(
      and(
        eq(customFieldDefinitions.companyId, ctx.companyId),
        eq(customFieldDefinitions.entityType, entityType),
        eq(customFieldDefinitions.isActive, true),
      ),
    )
    .orderBy(asc(customFieldDefinitions.sortOrder), asc(customFieldDefinitions.label));
}

/** Validates a value against its definition, rejecting mistyped input. */
function validateValue(definition: CustomFieldDefinition, value: unknown): void {
  if (value === null || value === undefined || value === '') {
    if (definition.isRequired) {
      throw new ValidationError(`${definition.label} is required`);
    }
    return;
  }

  switch (definition.fieldType) {
    case 'number':
    case 'currency':
      if (Number.isNaN(Number(value))) {
        throw new ValidationError(`${definition.label} must be a number`);
      }
      break;
    case 'date':
      if (Number.isNaN(Date.parse(String(value)))) {
        throw new ValidationError(`${definition.label} must be a valid date`);
      }
      break;
    case 'boolean':
      if (typeof value !== 'boolean') {
        throw new ValidationError(`${definition.label} must be true or false`);
      }
      break;
    case 'select': {
      const options = definition.options as Array<{ value: string }>;
      if (!options.some((o) => o.value === value)) {
        throw new ValidationError(`${definition.label} has no option "${String(value)}"`);
      }
      break;
    }
    case 'multi_select': {
      if (!Array.isArray(value)) {
        throw new ValidationError(`${definition.label} must be a list`);
      }
      const options = definition.options as Array<{ value: string }>;
      for (const item of value) {
        if (!options.some((o) => o.value === item)) {
          throw new ValidationError(`${definition.label} has no option "${String(item)}"`);
        }
      }
      break;
    }
    default:
      break;
  }
}

/** Writes custom field values for an entity, replacing any existing ones. */
export async function setCustomFieldValues(
  tx: Executor,
  ctx: TenantContext,
  params: { entityType: string; entityId: string; values: Record<string, unknown> },
): Promise<void> {
  const definitions = await tx
    .select()
    .from(customFieldDefinitions)
    .where(
      and(
        eq(customFieldDefinitions.companyId, ctx.companyId),
        eq(customFieldDefinitions.entityType, params.entityType),
        eq(customFieldDefinitions.isActive, true),
      ),
    );

  const byKey = new Map(definitions.map((d) => [d.key, d]));

  // Required fields must be satisfied even when omitted from the payload.
  for (const definition of definitions) {
    if (definition.isRequired && !(definition.key in params.values)) {
      throw new ValidationError(`${definition.label} is required`);
    }
  }

  for (const [key, value] of Object.entries(params.values)) {
    const definition = byKey.get(key);
    if (!definition) continue; // Unknown keys are ignored, not an error.

    validateValue(definition, value);

    await tx
      .insert(customFieldValues)
      .values({
        companyId: ctx.companyId,
        definitionId: definition.id,
        entityType: params.entityType,
        entityId: params.entityId,
        value: value as never,
      })
      .onConflictDoUpdate({
        target: [customFieldValues.definitionId, customFieldValues.entityId],
        set: { value: value as never, updatedAt: sql`now()` },
      });
  }
}

/** Reads an entity's custom fields as a plain key → value object. */
export async function getCustomFieldValues(
  ctx: TenantContext,
  entityType: string,
  entityId: string,
): Promise<Record<string, unknown>> {
  const rows = await db
    .select({
      key: customFieldDefinitions.key,
      value: customFieldValues.value,
    })
    .from(customFieldValues)
    .innerJoin(
      customFieldDefinitions,
      eq(customFieldDefinitions.id, customFieldValues.definitionId),
    )
    .where(
      and(
        eq(customFieldValues.companyId, ctx.companyId),
        eq(customFieldValues.entityType, entityType),
        eq(customFieldValues.entityId, entityId),
      ),
    );

  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

/** Values for many entities at once, so a list view needs one query, not N. */
export async function getCustomFieldValuesBulk(
  ctx: TenantContext,
  entityType: string,
  entityIds: string[],
): Promise<Map<string, Record<string, unknown>>> {
  if (entityIds.length === 0) return new Map();

  const rows = await db
    .select({
      entityId: customFieldValues.entityId,
      key: customFieldDefinitions.key,
      value: customFieldValues.value,
    })
    .from(customFieldValues)
    .innerJoin(
      customFieldDefinitions,
      eq(customFieldDefinitions.id, customFieldValues.definitionId),
    )
    .where(
      and(
        eq(customFieldValues.companyId, ctx.companyId),
        eq(customFieldValues.entityType, entityType),
        inArray(customFieldValues.entityId, entityIds),
      ),
    );

  const result = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    const existing = result.get(row.entityId) ?? {};
    existing[row.key] = row.value;
    result.set(row.entityId, existing);
  }
  return result;
}

export async function deleteCustomField(
  ctx: TenantContext,
  definitionId: string,
): Promise<void> {
  requirePermission(ctx, PERMISSIONS.settings.manage);

  const [definition] = await db
    .select()
    .from(customFieldDefinitions)
    .where(
      and(
        eq(customFieldDefinitions.id, definitionId),
        eq(customFieldDefinitions.companyId, ctx.companyId),
      ),
    )
    .limit(1);

  if (!definition) throw new NotFoundError('Custom field');

  await db.transaction(async (tx) => {
    // Deactivated rather than deleted: the values recorded against it are part
    // of documents users have already issued.
    await tx
      .update(customFieldDefinitions)
      .set({ isActive: false, updatedAt: sql`now()` })
      .where(eq(customFieldDefinitions.id, definitionId));

    await recordAudit(tx, ctx, {
      action: 'custom_field.deactivated',
      entityType: 'custom_field_definition',
      entityId: definitionId,
      previousValues: { key: definition.key, label: definition.label },
    });
  });
}
