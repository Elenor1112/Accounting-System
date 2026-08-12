import { redirect } from 'next/navigation';

import { getTenantContext } from '@/server/auth/session';

import { LoginForm } from './login-form';

export const metadata = { title: 'Sign in — LedgerBase' };

export default async function LoginPage() {
  // Already signed in: no reason to show the form again.
  if (await getTenantContext()) redirect('/dashboard');

  return (
    <main className="flex min-h-screen items-center justify-center bg-surface-muted px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <span className="text-sm font-bold">LB</span>
          </div>
          <h1 className="text-lg font-semibold tracking-tight">Sign in to LedgerBase</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Accounting for your organisation
          </p>
        </div>

        <div className="card p-6">
          <LoginForm />
        </div>

        <p className="mt-4 text-center text-xs text-subtle-foreground">
          Demo credentials: owner@demo.test / demo-password-123
        </p>
      </div>
    </main>
  );
}
