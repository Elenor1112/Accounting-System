import { relations } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { primaryKeyId, timestamps } from './_shared';

/**
 * Tenancy is three levels: Organization → Company → Branch (spec §5).
 *
 * The *company* is the accounting boundary: a chart of accounts, a base
 * currency, a fiscal calendar, and a ledger all belong to exactly one company.
 * An organization groups companies for billing and cross-company user access.
 * A branch is a reporting dimension inside a company, never its own ledger.
 *
 * Every financial table carries `companyId` directly rather than reaching it
 * through a join. That redundancy is deliberate: it lets every query filter on
 * the tenant boundary with a single indexed predicate, and it lets composite
 * foreign keys prove — in the database, not in application code — that a
 * journal line's account belongs to the same company as its entry.
 */
export const organizations = pgTable(
  'organizations',
  {
    id: primaryKeyId(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    isActive: boolean('is_active').notNull().default(true),
    ...timestamps,
  },
  (t) => [uniqueIndex('organizations_slug_key').on(t.slug)],
);

export const companies = pgTable(
  'companies',
  {
    id: primaryKeyId(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),

    name: text('name').notNull(),
    legalName: text('legal_name'),
    slug: text('slug').notNull(),

    // Branding / document header (spec §6, §26).
    logoUrl: text('logo_url'),
    email: text('email'),
    phone: text('phone'),
    addressLine1: text('address_line1'),
    addressLine2: text('address_line2'),
    city: text('city'),
    state: text('state'),
    postalCode: text('postal_code'),
    countryCode: text('country_code'),

    taxIdentifier: text('tax_identifier'),

    /**
     * The currency every ledger amount is ultimately expressed in. Immutable
     * once any journal entry is posted — changing it would silently reinterpret
     * all historical base amounts, so the service layer refuses the edit.
     */
    baseCurrencyCode: text('base_currency_code').notNull().default('USD'),

    /** 1 = January. A fiscal year starting in July stores 7. */
    fiscalYearStartMonth: integer('fiscal_year_start_month').notNull().default(1),

    timezone: text('timezone').notNull().default('UTC'),
    dateFormat: text('date_format').notNull().default('yyyy-MM-dd'),
    /** Presentation scale for money. Storage always keeps 6 decimals. */
    currencyPrecision: integer('currency_precision').notNull().default(2),

    /**
     * Open-ended per-company settings that do not warrant columns: default
     * account mappings, document template choices, feature toggles. Anything
     * queried or constrained gets a real column instead.
     */
    settings: jsonb('settings').notNull().default({}),

    isActive: boolean('is_active').notNull().default(true),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('companies_org_slug_key').on(t.organizationId, t.slug),
    index('companies_org_idx').on(t.organizationId),
  ],
);

export const branches = pgTable(
  'branches',
  {
    id: primaryKeyId(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    code: text('code').notNull(),
    name: text('name').notNull(),
    isActive: boolean('is_active').notNull().default(true),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('branches_company_code_key').on(t.companyId, t.code),
    index('branches_company_idx').on(t.companyId),
  ],
);

export const organizationsRelations = relations(organizations, ({ many }) => ({
  companies: many(companies),
}));

export const companiesRelations = relations(companies, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [companies.organizationId],
    references: [organizations.id],
  }),
  branches: many(branches),
}));

export const branchesRelations = relations(branches, ({ one }) => ({
  company: one(companies, {
    fields: [branches.companyId],
    references: [companies.id],
  }),
}));
