import { relations } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { amount, primaryKeyId, timestamps } from './_shared';
import { accounts } from './ledger';
import { companies } from './tenancy';

/**
 * Customers and vendors share one table with a `kind` discriminator, because a
 * great many real counterparties are both — a supplier you also sell to. One
 * row keeps their identity, contact details and custom fields in a single
 * place; the two AR/AP subledgers stay separate through the documents that
 * reference it, not through duplicate contact records.
 */
export const contacts = pgTable(
  'contacts',
  {
    id: primaryKeyId(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),

    kind: text('kind', { enum: ['customer', 'vendor', 'both'] })
      .notNull()
      .default('customer'),

    /** Human-facing identifier, unique per company, e.g. `CUST-0001`. */
    code: text('code').notNull(),
    displayName: text('display_name').notNull(),
    legalName: text('legal_name'),

    /** Named individual to deal with, distinct from the company itself. */
    contactPerson: text('contact_person'),
    email: text('email'),
    phone: text('phone'),
    mobile: text('mobile'),
    website: text('website'),
    taxIdentifier: text('tax_identifier'),

    /**
     * A free-text grouping the client defines (wholesale, retail, key account).
     * Deliberately not an enum: every business segments its customers
     * differently, and the point of this system is configuration over code.
     */
    category: text('category'),

    billingAddress: jsonb('billing_address').notNull().default({}),
    shippingAddress: jsonb('shipping_address').notNull().default({}),

    /** Defaults inherited by new documents; each document may override. */
    currencyCode: text('currency_code'),
    paymentTermsDays: integer('payment_terms_days').notNull().default(30),
    creditLimit: amount('credit_limit'),

    /**
     * Overrides the company-level AR/AP control account for this contact.
     * Some businesses track a major customer in a dedicated account; most
     * leave this null and inherit the default.
     */
    receivableAccountId: uuid('receivable_account_id').references(() => accounts.id, {
      onDelete: 'restrict',
    }),
    payableAccountId: uuid('payable_account_id').references(() => accounts.id, {
      onDelete: 'restrict',
    }),

    notes: text('notes'),
    isActive: boolean('is_active').notNull().default(true),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('contacts_company_code_key').on(t.companyId, t.code),
    index('contacts_company_kind_idx').on(t.companyId, t.kind, t.isActive),
    // Supports the type-ahead in every document form; server-side search only.
    index('contacts_company_name_idx').on(t.companyId, t.displayName),
    // Table constraint so documents can carry `companyId` into their FK to a
    // contact, the same tenant-proving pattern used across the ledger.
    unique('contacts_id_company_key').on(t.id, t.companyId),
  ],
);

export const contactsRelations = relations(contacts, ({ one }) => ({
  company: one(companies, {
    fields: [contacts.companyId],
    references: [companies.id],
  }),
  receivableAccount: one(accounts, {
    fields: [contacts.receivableAccountId],
    references: [accounts.id],
    relationName: 'contact_receivable',
  }),
  payableAccount: one(accounts, {
    fields: [contacts.payableAccountId],
    references: [accounts.id],
    relationName: 'contact_payable',
  }),
}));
