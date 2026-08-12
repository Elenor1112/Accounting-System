import { relations } from 'drizzle-orm';
import { index, jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core';

import { primaryKeyId, timestamps } from './_shared';
import { users } from './identity';
import { companies } from './tenancy';

/**
 * Append-only record of every financially meaningful action (spec §23).
 *
 * Nothing in the application ever updates or deletes a row here — the service
 * layer only inserts, and the audit write happens inside the same transaction
 * as the change it describes, so an action and its audit trail commit or fail
 * together. There is no code path that posts an entry without logging it.
 */
export const auditLogs = pgTable(
  'audit_logs',
  {
    id: primaryKeyId(),
    companyId: uuid('company_id').references(() => companies.id, {
      onDelete: 'restrict',
    }),
    actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),

    /** Dotted verb, e.g. `journal_entry.posted`, `invoice.approved`. */
    action: text('action').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id'),

    /**
     * Field-level before/after. Only changed fields are stored, so the row
     * stays small and a diff view needs no reconstruction.
     */
    previousValues: jsonb('previous_values'),
    newValues: jsonb('new_values'),

    /** Required by the service for reversals, period reopening, and voids. */
    reason: text('reason'),

    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),

    createdAt: timestamps.createdAt,
  },
  (t) => [
    index('audit_logs_company_created_idx').on(t.companyId, t.createdAt),
    index('audit_logs_entity_idx').on(t.entityType, t.entityId),
    index('audit_logs_actor_idx').on(t.actorId),
  ],
);

export const auditLogsRelations = relations(auditLogs, ({ one }) => ({
  company: one(companies, {
    fields: [auditLogs.companyId],
    references: [companies.id],
  }),
  actor: one(users, { fields: [auditLogs.actorId], references: [users.id] }),
}));
