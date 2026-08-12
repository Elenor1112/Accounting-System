'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { Button, Input } from './ui';

/**
 * Date-range controls for reports. Navigates rather than fetching, so every
 * report view is a shareable URL and the figures are always computed server
 * side from the ledger.
 */
export function ReportControls({
  basePath,
  from,
  to,
  mode = 'range',
  extra,
}: {
  basePath: string;
  from: string;
  to: string;
  mode?: 'range' | 'asOf';
  extra?: Record<string, string | undefined>;
}) {
  const router = useRouter();
  const [localFrom, setLocalFrom] = useState(from);
  const [localTo, setLocalTo] = useState(to);

  const apply = (overrides: Record<string, string> = {}) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(extra ?? {})) {
      if (value) params.set(key, value);
    }
    params.set('from', overrides.from ?? localFrom);
    params.set('to', overrides.to ?? localTo);
    router.push(`${basePath}?${params.toString()}`);
  };

  const presets: Array<{ label: string; range: () => { from: string; to: string } }> = [
    {
      label: 'This month',
      range: () => {
        const now = new Date();
        const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
        const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0));
        return { from: iso(start), to: iso(end) };
      },
    },
    {
      label: 'This quarter',
      range: () => {
        const now = new Date();
        const q = Math.floor(now.getUTCMonth() / 3);
        const start = new Date(Date.UTC(now.getUTCFullYear(), q * 3, 1));
        const end = new Date(Date.UTC(now.getUTCFullYear(), q * 3 + 3, 0));
        return { from: iso(start), to: iso(end) };
      },
    },
    {
      label: 'This year',
      range: () => {
        const year = new Date().getUTCFullYear();
        return { from: `${year}-01-01`, to: `${year}-12-31` };
      },
    },
  ];

  return (
    <div className="mb-4 flex flex-wrap items-end gap-2">
      {mode === 'range' ? (
        <>
          <div>
            <label className="label-base" htmlFor="report-from">
              From
            </label>
            <Input
              id="report-from"
              type="date"
              value={localFrom}
              onChange={(e) => setLocalFrom(e.target.value)}
              className="w-auto"
            />
          </div>
          <div>
            <label className="label-base" htmlFor="report-to">
              To
            </label>
            <Input
              id="report-to"
              type="date"
              value={localTo}
              onChange={(e) => setLocalTo(e.target.value)}
              className="w-auto"
            />
          </div>
        </>
      ) : (
        <div>
          <label className="label-base" htmlFor="report-asof">
            As at
          </label>
          <Input
            id="report-asof"
            type="date"
            value={localTo}
            onChange={(e) => setLocalTo(e.target.value)}
            className="w-auto"
          />
        </div>
      )}

      <Button onClick={() => apply()}>Apply</Button>

      <div className="ml-auto flex gap-1.5">
        {presets.map((preset) => (
          <Button
            key={preset.label}
            size="sm"
            variant="ghost"
            onClick={() => {
              const range = preset.range();
              setLocalFrom(range.from);
              setLocalTo(range.to);
              apply(range);
            }}
          >
            {preset.label}
          </Button>
        ))}
      </div>
    </div>
  );
}

function iso(date: Date): string {
  return date.toISOString().slice(0, 10);
}
