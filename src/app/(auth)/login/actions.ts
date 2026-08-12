'use server';

import { redirect } from 'next/navigation';
import { headers } from 'next/headers';

import { isAppError } from '@/server/errors';
import { createSessionCookies, login } from '@/server/auth/session';

export interface LoginState {
  error?: string;
}

/**
 * Server action for sign-in. Credentials never reach the client bundle, and
 * the failure message is deliberately identical for unknown emails and wrong
 * passwords so it cannot be used to enumerate accounts.
 */
export async function loginAction(
  _previous: LoginState,
  formData: FormData,
): Promise<LoginState> {
  const email = String(formData.get('email') ?? '');
  const password = String(formData.get('password') ?? '');

  if (!email || !password) {
    return { error: 'Enter your email and password' };
  }

  try {
    const headerList = await headers();
    const result = await login({
      email,
      password,
      ipAddress:
        headerList.get('x-forwarded-for')?.split(',')[0]?.trim() ??
        headerList.get('x-real-ip') ??
        undefined,
      userAgent: headerList.get('user-agent') ?? undefined,
    });

    if (!result.companyId) {
      return {
        error: 'This account has no company access yet. Ask an administrator to invite you.',
      };
    }

    await createSessionCookies(result.token, result.companyId);
  } catch (err) {
    if (isAppError(err)) return { error: err.message };
    console.error('Login failed:', err);
    return { error: 'Something went wrong signing you in. Please try again.' };
  }

  // Outside the try: redirect throws a control-flow signal Next.js handles,
  // and catching it here would turn a successful login into an error message.
  redirect('/dashboard');
}
