'use client';

import { useRouter } from 'next/navigation';

import { Select } from './ui';

/** Account selector that navigates, keeping the report a server-rendered URL. */
export function AccountPicker({
  accounts,
  selectedId,
  basePath,
  extra,
}: {
  accounts: Array<{ id: string; code: string; name: string; isPostable: boolean }>;
  selectedId?: string;
  basePath: string;
  extra?: Record<string, string | undefined>;
}) {
  const router = useRouter();

  return (
    <div>
      <label className="label-base" htmlFor="account-picker">
        Account
      </label>
      <Select
        id="account-picker"
        value={selectedId ?? ''}
        onChange={(event) => {
          const params = new URLSearchParams();
          for (const [key, value] of Object.entries(extra ?? {})) {
            if (value) params.set(key, value);
          }
          if (event.target.value) params.set('accountId', event.target.value);
          const query = params.toString();
          router.push(query ? `${basePath}?${query}` : basePath);
        }}
        className="w-auto min-w-[320px]"
      >
        <option value="">All accounts</option>
        {accounts
          // Summary accounts hold no lines of their own, so selecting one
          // would always show an empty ledger.
          .filter((account) => account.isPostable)
          .map((account) => (
            <option key={account.id} value={account.id}>
              {account.code} — {account.name}
            </option>
          ))}
      </Select>
    </div>
  );
}
