'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';

import { logout, switchCompany } from '@/server/auth/session';

export async function logoutAction(): Promise<void> {
  await logout();
  redirect('/login');
}

export async function switchCompanyAction(companyId: string): Promise<void> {
  // `switchCompany` verifies the membership before setting the cookie, so a
  // forged company id is rejected here rather than deeper in a query.
  await switchCompany(companyId);
  revalidatePath('/', 'layout');
}
