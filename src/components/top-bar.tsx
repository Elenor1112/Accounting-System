'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';

import { logoutAction, switchCompanyAction } from '@/app/(app)/actions';

import { Button, cn } from './ui';

interface CompanyOption {
  companyId: string;
  companyName: string;
  roleKey: string;
}

export function TopBar({
  userName,
  userEmail,
  companyName,
  companyId,
  companies,
  roleKey,
}: {
  userName: string;
  userEmail: string;
  companyName: string;
  companyId: string;
  companies: CompanyOption[];
  roleKey: string;
}) {
  const router = useRouter();
  const [menuOpen, setMenuOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  const initials = userName
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('');

  return (
    <header className="sticky top-0 z-20 flex h-14 items-center justify-between gap-4 border-b border-border bg-surface px-6">
      <div className="flex items-center gap-3">
        {companies.length > 1 ? (
          <select
            aria-label="Switch company"
            value={companyId}
            disabled={pending}
            onChange={(event) => {
              const next = event.target.value;
              startTransition(async () => {
                await switchCompanyAction(next);
                // The whole shell depends on the company, so refresh rather
                // than trying to patch state in place.
                router.refresh();
              });
            }}
            className="h-8 rounded-md border border-border bg-surface px-2 text-sm font-medium"
          >
            {companies.map((company) => (
              <option key={company.companyId} value={company.companyId}>
                {company.companyName}
              </option>
            ))}
          </select>
        ) : (
          <span className="text-sm font-medium text-foreground">{companyName}</span>
        )}
      </div>

      <div className="relative">
        <button
          type="button"
          onClick={() => setMenuOpen((open) => !open)}
          className="flex items-center gap-2 rounded-md px-1.5 py-1 hover:bg-surface-muted"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
        >
          <span className="flex h-7 w-7 items-center justify-center rounded-full bg-accent-subtle text-[11px] font-semibold text-accent">
            {initials}
          </span>
          <span className="hidden text-sm text-foreground sm:block">{userName}</span>
        </button>

        {menuOpen ? (
          <>
            {/* Click-away layer keeps the menu behaviour keyboard- and
                pointer-consistent without a dependency. */}
            <div className="fixed inset-0 z-10" onClick={() => setMenuOpen(false)} />
            <div
              role="menu"
              className="absolute right-0 z-20 mt-1 w-56 rounded-md border border-border bg-surface p-1 shadow-lg"
            >
              <div className="border-b border-border px-2.5 py-2">
                <p className="text-sm font-medium text-foreground">{userName}</p>
                <p className="truncate text-xs text-muted-foreground">{userEmail}</p>
                <p className="mt-1 text-[11px] uppercase tracking-wide text-subtle-foreground">
                  {roleKey}
                </p>
              </div>
              <form action={logoutAction}>
                <button
                  type="submit"
                  className={cn(
                    'w-full rounded px-2.5 py-1.5 text-left text-sm text-muted-foreground',
                    'hover:bg-surface-muted hover:text-foreground',
                  )}
                >
                  Sign out
                </button>
              </form>
            </div>
          </>
        ) : null}
      </div>
    </header>
  );
}
