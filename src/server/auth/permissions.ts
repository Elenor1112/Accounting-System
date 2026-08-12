/**
 * The permission catalogue (spec §22).
 *
 * Permissions are plain dotted strings stored on roles. They are checked
 * server-side on every mutation; the UI may also consult them to hide
 * controls, but hiding a button is a convenience, never the enforcement.
 */
export const PERMISSIONS = {
  dashboard: {
    view: 'accounting.dashboard.view',
  },
  accounts: {
    view: 'accounting.accounts.view',
    manage: 'accounting.accounts.manage',
  },
  transactions: {
    view: 'accounting.transactions.view',
    create: 'accounting.transactions.create',
    post: 'accounting.transactions.post',
    reverse: 'accounting.transactions.reverse',
  },
  invoices: {
    view: 'accounting.invoices.view',
    create: 'accounting.invoices.create',
    approve: 'accounting.invoices.approve',
    send: 'accounting.invoices.send',
    delete: 'accounting.invoices.delete',
  },
  bills: {
    view: 'accounting.bills.view',
    create: 'accounting.bills.create',
    approve: 'accounting.bills.approve',
  },
  payments: {
    view: 'accounting.payments.view',
    create: 'accounting.payments.create',
    delete: 'accounting.payments.delete',
  },
  expenses: {
    view: 'accounting.expenses.view',
    create: 'accounting.expenses.create',
    approve: 'accounting.expenses.approve',
  },
  contacts: {
    view: 'accounting.contacts.view',
    manage: 'accounting.contacts.manage',
  },
  banking: {
    view: 'accounting.banking.view',
    manage: 'accounting.banking.manage',
    reconcile: 'accounting.banking.reconcile',
  },
  periods: {
    manage: 'accounting.periods.manage',
  },
  budgets: {
    view: 'accounting.budgets.view',
    manage: 'accounting.budgets.manage',
  },
  reports: {
    view: 'accounting.reports.view',
    export: 'accounting.reports.export',
  },
  settings: {
    manage: 'accounting.settings.manage',
  },
  audit: {
    view: 'accounting.audit.view',
  },
} as const;

type Leaves<T> = T extends string ? T : { [K in keyof T]: Leaves<T[K]> }[keyof T];
export type Permission = Leaves<typeof PERMISSIONS>;

/** Flattened list, used for seeding the owner role and for settings UI. */
export const ALL_PERMISSIONS: Permission[] = Object.values(PERMISSIONS).flatMap(
  (group) => Object.values(group) as Permission[],
);

/**
 * Wildcard grant. A role holding this passes every check — reserved for the
 * organization owner so a locked-out tenant always has a way back in.
 */
export const WILDCARD = '*';

/**
 * System role templates new organizations are seeded from (spec §39: roles are
 * configuration, so these are starting points a client can edit, not fixed
 * behaviour baked into the engine).
 */
export const SYSTEM_ROLE_TEMPLATES = [
  {
    key: 'owner',
    name: 'Owner',
    description: 'Full access, including settings and period locking.',
    permissions: [WILDCARD],
  },
  {
    key: 'accountant',
    name: 'Accountant',
    description: 'Full bookkeeping access: post, reverse, reconcile, report.',
    permissions: [
      PERMISSIONS.dashboard.view,
      PERMISSIONS.accounts.view,
      PERMISSIONS.accounts.manage,
      PERMISSIONS.transactions.view,
      PERMISSIONS.transactions.create,
      PERMISSIONS.transactions.post,
      PERMISSIONS.transactions.reverse,
      PERMISSIONS.invoices.view,
      PERMISSIONS.invoices.create,
      PERMISSIONS.invoices.approve,
      PERMISSIONS.invoices.send,
      PERMISSIONS.bills.view,
      PERMISSIONS.bills.create,
      PERMISSIONS.bills.approve,
      PERMISSIONS.payments.view,
      PERMISSIONS.payments.create,
      PERMISSIONS.expenses.view,
      PERMISSIONS.expenses.create,
      PERMISSIONS.expenses.approve,
      PERMISSIONS.contacts.view,
      PERMISSIONS.contacts.manage,
      PERMISSIONS.banking.view,
      PERMISSIONS.banking.manage,
      PERMISSIONS.banking.reconcile,
      PERMISSIONS.budgets.view,
      PERMISSIONS.budgets.manage,
      PERMISSIONS.reports.view,
      PERMISSIONS.reports.export,
      PERMISSIONS.audit.view,
    ],
  },
  {
    key: 'bookkeeper',
    name: 'Bookkeeper',
    description: 'Enters documents but cannot post to the ledger or approve.',
    permissions: [
      PERMISSIONS.dashboard.view,
      PERMISSIONS.accounts.view,
      PERMISSIONS.transactions.view,
      PERMISSIONS.transactions.create,
      PERMISSIONS.invoices.view,
      PERMISSIONS.invoices.create,
      PERMISSIONS.bills.view,
      PERMISSIONS.bills.create,
      PERMISSIONS.payments.view,
      PERMISSIONS.payments.create,
      PERMISSIONS.expenses.view,
      PERMISSIONS.expenses.create,
      PERMISSIONS.contacts.view,
      PERMISSIONS.contacts.manage,
      PERMISSIONS.banking.view,
      PERMISSIONS.reports.view,
    ],
  },
  {
    key: 'approver',
    name: 'Approver',
    description: 'Reviews and approves documents without entering them.',
    permissions: [
      PERMISSIONS.dashboard.view,
      PERMISSIONS.transactions.view,
      PERMISSIONS.invoices.view,
      PERMISSIONS.invoices.approve,
      PERMISSIONS.bills.view,
      PERMISSIONS.bills.approve,
      PERMISSIONS.expenses.view,
      PERMISSIONS.expenses.approve,
      PERMISSIONS.reports.view,
    ],
  },
  {
    key: 'viewer',
    name: 'Viewer',
    description: 'Read-only access to documents and reports.',
    permissions: [
      PERMISSIONS.dashboard.view,
      PERMISSIONS.accounts.view,
      PERMISSIONS.transactions.view,
      PERMISSIONS.invoices.view,
      PERMISSIONS.bills.view,
      PERMISSIONS.payments.view,
      PERMISSIONS.expenses.view,
      PERMISSIONS.contacts.view,
      PERMISSIONS.banking.view,
      PERMISSIONS.reports.view,
    ],
  },
] as const;

export function hasPermission(granted: readonly string[], required: Permission): boolean {
  return granted.includes(WILDCARD) || granted.includes(required);
}
