import { relations } from 'drizzle-orm';
import {
  boolean,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { primaryKeyId, timestamps } from './_shared';
import { branches, companies, organizations } from './tenancy';

/**
 * A user is global; access is granted per company through `memberships`.
 * That separation is what lets one accountant serve several companies in an
 * organization without duplicate logins, and it keeps the tenant check on the
 * membership row rather than on the user.
 */
export const users = pgTable(
  'users',
  {
    id: primaryKeyId(),
    email: text('email').notNull(),
    passwordHash: text('password_hash').notNull(),
    name: text('name').notNull(),
    isActive: boolean('is_active').notNull().default(true),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [uniqueIndex('users_email_key').on(t.email)],
);

/**
 * Roles are per-organization so each client can define its own. A role with a
 * null `organizationId` is a system template (Owner, Accountant, Viewer) that
 * new organizations are seeded from — templates themselves are never assigned.
 */
export const roles = pgTable(
  'roles',
  {
    id: primaryKeyId(),
    organizationId: uuid('organization_id').references(() => organizations.id, {
      onDelete: 'cascade',
    }),
    key: text('key').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    /**
     * Permission keys such as `accounting.transactions.post` (spec §22).
     * Stored as a text array rather than a join table: the set is small,
     * always read whole when building a session, and never queried by
     * individual permission.
     */
    permissions: text('permissions').array().notNull().default([]),
    isSystem: boolean('is_system').notNull().default(false),
    ...timestamps,
  },
  (t) => [uniqueIndex('roles_org_key_key').on(t.organizationId, t.key)],
);

/**
 * Grants a user access to one company under one role.
 *
 * `branchIds` empty means every branch in the company; a non-empty array
 * restricts the user to those branches (spec §5). The restriction is applied
 * server-side in the query layer, never by hiding UI.
 */
export const memberships = pgTable(
  'memberships',
  {
    id: primaryKeyId(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    roleId: uuid('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'restrict' }),
    branchIds: uuid('branch_ids').array().notNull().default([]),
    isActive: boolean('is_active').notNull().default(true),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('memberships_user_company_key').on(t.userId, t.companyId),
    index('memberships_company_idx').on(t.companyId),
    index('memberships_user_idx').on(t.userId),
  ],
);

export const sessions = pgTable(
  'sessions',
  {
    id: primaryKeyId(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** SHA-256 of the cookie token. The raw token is never stored. */
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('sessions_token_hash_key').on(t.tokenHash),
    index('sessions_user_idx').on(t.userId),
  ],
);

export const usersRelations = relations(users, ({ many }) => ({
  memberships: many(memberships),
  sessions: many(sessions),
}));

export const membershipsRelations = relations(memberships, ({ one }) => ({
  user: one(users, { fields: [memberships.userId], references: [users.id] }),
  company: one(companies, {
    fields: [memberships.companyId],
    references: [companies.id],
  }),
  role: one(roles, { fields: [memberships.roleId], references: [roles.id] }),
}));

export const rolesRelations = relations(roles, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [roles.organizationId],
    references: [organizations.id],
  }),
  memberships: many(memberships),
}));

export const sessionsRelations = relations(sessions, ({ one }) => ({
  user: one(users, { fields: [sessions.userId], references: [users.id] }),
}));

// `branches` is imported for the FK-less `branchIds` array documented above;
// re-exported here so schema consumers resolve the reference in one import.
export type BranchScope = typeof branches.$inferSelect;
