import { redirect } from 'next/navigation';

import { Sidebar } from '@/components/sidebar';
import { TopBar } from '@/components/top-bar';
import { listAccessibleCompanies } from '@/server/auth/context';
import { getTenantContext } from '@/server/auth/session';

/**
 * The authenticated shell.
 *
 * Every page beneath this layout is a server component that resolves its own
 * `TenantContext` and calls services directly. There is no client-side data
 * fetching of financial figures, so no amount is ever computed or filtered in
 * the browser.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const ctx = await getTenantContext();
  if (!ctx) redirect('/login');

  const companies = await listAccessibleCompanies(ctx.userId);

  return (
    <div className="flex min-h-screen bg-background">
      <Sidebar permissions={ctx.permissions} />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar
          userName={ctx.userName}
          userEmail={ctx.userEmail}
          companyName={ctx.companyName}
          companyId={ctx.companyId}
          companies={companies}
          roleKey={ctx.roleKey}
        />
        <main className="flex-1 px-8 py-8">
          <div className="mx-auto max-w-[1440px] animate-fade-in">{children}</div>
        </main>
      </div>
    </div>
  );
}
