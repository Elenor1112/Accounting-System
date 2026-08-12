'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { Button, Input, Select } from './ui';

/**
 * Filters navigate rather than fetch: submitting builds a URL and lets the
 * server component re-run its query. That keeps filtering server-side (spec
 * §30) and makes every filtered view a shareable, bookmarkable link.
 */
export function FilterBar({
  basePath,
  searchParams,
  searchPlaceholder = 'Search…',
  selects = [],
}: {
  basePath: string;
  searchParams: Record<string, string | undefined>;
  searchPlaceholder?: string;
  selects?: Array<{
    name: string;
    label: string;
    options: Array<{ value: string; label: string }>;
  }>;
}) {
  const router = useRouter();
  const [query, setQuery] = useState(searchParams.q ?? '');

  const navigate = (overrides: Record<string, string>) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries({ ...searchParams, ...overrides })) {
      // `page` is dropped: changing a filter should return to the first page.
      if (value && key !== 'page') params.set(key, value);
    }
    const search = params.toString();
    router.push(search ? `${basePath}?${search}` : basePath);
  };

  const hasFilters = Boolean(searchParams.q) || selects.some((s) => searchParams[s.name]);

  return (
    <form
      className="mb-3 flex flex-wrap items-end gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        navigate({ q: query });
      }}
    >
      <div className="min-w-[220px] flex-1">
        <Input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={searchPlaceholder}
          aria-label="Search"
        />
      </div>

      {selects.map((select) => (
        <Select
          key={select.name}
          aria-label={select.label}
          value={searchParams[select.name] ?? ''}
          onChange={(event) => navigate({ [select.name]: event.target.value })}
          className="w-auto min-w-[140px]"
        >
          {select.options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </Select>
      ))}

      <Button type="submit">Search</Button>

      {hasFilters ? (
        <Button
          type="button"
          variant="ghost"
          onClick={() => {
            setQuery('');
            router.push(basePath);
          }}
        >
          Clear
        </Button>
      ) : null}
    </form>
  );
}
