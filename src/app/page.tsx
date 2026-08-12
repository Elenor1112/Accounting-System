import { redirect } from 'next/navigation';

import { getTenantContext } from '@/server/auth/session';

export default async function RootPage() {
  const ctx = await getTenantContext();
  redirect(ctx ? '/dashboard' : '/login');
}
