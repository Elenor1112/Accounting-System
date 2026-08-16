'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { PERMISSIONS } from '@/server/auth/permissions';

import { cn } from './ui';

/**
 * Navigation, filtered by permission.
 *
 * Hiding a link is a convenience so users are not shown doors they cannot
 * open — it is never the enforcement. Every service call re-checks the same
 * permission server-side, so navigating directly to a hidden URL still fails.
 */
interface NavItem {
  href: string;
  label: string;
  permission?: string;
}

interface NavGroup {
  label: string;
  items: NavItem[];
}

const NAV: NavGroup[] = [
  {
    label: 'Overview',
    items: [{ href: '/dashboard', label: 'Dashboard', permission: PERMISSIONS.dashboard.view }],
  },
  {
    label: 'Sales',
    items: [
      { href: '/invoices', label: 'Invoices', permission: PERMISSIONS.invoices.view },
      { href: '/customers', label: 'Customers', permission: PERMISSIONS.contacts.view },
      { href: '/payments?direction=receipt', label: 'Receipts', permission: PERMISSIONS.payments.view },
    ],
  },
  {
    label: 'Purchases',
    items: [
      { href: '/bills', label: 'Bills', permission: PERMISSIONS.bills.view },
      { href: '/vendors', label: 'Vendors', permission: PERMISSIONS.contacts.view },
      { href: '/expenses', label: 'Expenses', permission: PERMISSIONS.expenses.view },
    ],
  },
  {
    label: 'Banking',
    items: [
      { href: '/banking', label: 'Accounts', permission: PERMISSIONS.banking.view },
      { href: '/banking/reconcile', label: 'Reconciliation', permission: PERMISSIONS.banking.reconcile },
    ],
  },
  {
    label: 'Accounting',
    items: [
      { href: '/accounts', label: 'Chart of Accounts', permission: PERMISSIONS.accounts.view },
      { href: '/journal', label: 'Journal Entries', permission: PERMISSIONS.transactions.view },
      { href: '/inventory', label: 'Inventory', permission: PERMISSIONS.inventory.view },
      { href: '/fixed-assets', label: 'Fixed Assets', permission: PERMISSIONS.fixedAssets.view },
      { href: '/periods', label: 'Fiscal Periods', permission: PERMISSIONS.transactions.view },
    ],
  },
  {
    label: 'Reports',
    items: [
      { href: '/reports/profit-loss', label: 'Profit & Loss', permission: PERMISSIONS.reports.view },
      { href: '/reports/balance-sheet', label: 'Balance Sheet', permission: PERMISSIONS.reports.view },
      { href: '/reports/trial-balance', label: 'Trial Balance', permission: PERMISSIONS.reports.view },
      { href: '/reports/general-ledger', label: 'General Ledger', permission: PERMISSIONS.reports.view },
      { href: '/reports/aging', label: 'AR / AP Aging', permission: PERMISSIONS.reports.view },
      { href: '/reports/cash-flow', label: 'Cash Flow', permission: PERMISSIONS.reports.view },
      { href: '/reports/tax', label: 'Tax Report', permission: PERMISSIONS.reports.view },
    ],
  },
  {
    label: 'Configure',
    items: [
      { href: '/settings', label: 'Settings', permission: PERMISSIONS.settings.manage },
      { href: '/audit', label: 'Audit Log', permission: PERMISSIONS.audit.view },
    ],
  },
];

export function Sidebar({ permissions }: { permissions: readonly string[] }) {
  const pathname = usePathname();
  const can = (permission?: string) =>
    !permission || permissions.includes('*') || permissions.includes(permission);

  return (
    <aside className="hidden w-60 shrink-0 flex-col border-r border-border bg-surface lg:flex">
      <div className="flex items-center gap-3 border-b border-border p-5">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground">
          <span className="text-xs font-bold">LB</span>
        </div>
        <div className="min-w-0">
          <p className="truncate text-base font-bold tracking-tight text-primary">LedgerBase</p>
          <p className="truncate text-[11px] text-muted-foreground">Enterprise Accounting</p>
        </div>
      </div>

      <nav
        className="flex-1 space-y-5 overflow-y-auto px-3 py-4"
        style={{ maxHeight: 'calc(100vh - 4.5rem)' }}
      >
        {NAV.map((group) => {
          const visible = group.items.filter((item) => can(item.permission));
          if (visible.length === 0) return null;

          return (
            <div key={group.label}>
              <p className="mb-1.5 px-3 text-[10px] font-semibold uppercase tracking-caps text-subtle-foreground">
                {group.label}
              </p>
              <ul className="space-y-0.5">
                {visible.map((item) => {
                  const base = item.href.split('?')[0]!;
                  const active = pathname === base || pathname.startsWith(`${base}/`);
                  return (
                    <li key={item.href}>
                      <Link
                        href={item.href}
                        className={cn(
                          'block border-l-4 px-3 py-1.5 text-sm transition-colors',
                          active
                            ? 'border-primary bg-surface-muted font-semibold text-foreground'
                            : 'border-transparent text-muted-foreground hover:bg-surface-muted hover:text-foreground',
                        )}
                      >
                        {item.label}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </nav>
    </aside>
  );
}
