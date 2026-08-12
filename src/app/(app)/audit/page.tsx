import { and, desc, eq } from 'drizzle-orm';

import { DataTable, Pagination, type Column } from '@/components/data-table';
import { Badge, PageHeader } from '@/components/ui';
import { db } from '@/db';
import { auditLogs, users } from '@/db/schema';
import * as fmt from '@/lib/format';
import { requirePermission } from '@/server/auth/context';
import { PERMISSIONS } from '@/server/auth/permissions';
import { requireTenantContext } from '@/server/auth/session';

export const metadata = { title: 'Audit Log — LedgerBase' };
export const dynamic = 'force-dynamic';

const PAGE_SIZE = 50;

export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const params = await searchParams;
  const ctx = await requireTenantContext();
  requirePermission(ctx, PERMISSIONS.audit.view);

  const page = Math.max(1, Number(params.page ?? '1'));

  const rows = await db
    .select({
      id: auditLogs.id,
      action: auditLogs.action,
      entityType: auditLogs.entityType,
      entityId: auditLogs.entityId,
      reason: auditLogs.reason,
      createdAt: auditLogs.createdAt,
      actorName: users.name,
      newValues: auditLogs.newValues,
    })
    .from(auditLogs)
    .leftJoin(users, eq(users.id, auditLogs.actorId))
    .where(and(eq(auditLogs.companyId, ctx.companyId)))
    .orderBy(desc(auditLogs.createdAt))
    .limit(PAGE_SIZE + 1)
    .offset((page - 1) * PAGE_SIZE);

  const hasMore = rows.length > PAGE_SIZE;
  const visible = hasMore ? rows.slice(0, PAGE_SIZE) : rows;

  type Row = (typeof visible)[number];

  const columns: Column<Row>[] = [
    {
      key: 'when',
      header: 'When',
      width: '170px',
      render: (row) => (
        <span className="text-muted-foreground">{fmt.dateTime(row.createdAt)}</span>
      ),
    },
    {
      key: 'actor',
      header: 'User',
      render: (row) => row.actorName ?? 'System',
    },
    {
      key: 'action',
      header: 'Action',
      render: (row) => (
        <Badge tone={toneFor(row.action)}>{row.action.replace(/[._]/g, ' ')}</Badge>
      ),
    },
    {
      key: 'entity',
      header: 'Entity',
      render: (row) => (
        <span className="text-muted-foreground">{fmt.humanise(row.entityType)}</span>
      ),
    },
    {
      key: 'detail',
      header: 'Detail',
      render: (row) => {
        const values = row.newValues as Record<string, unknown> | null;
        const summary = values
          ? Object.entries(values)
              .slice(0, 3)
              .map(([key, value]) => `${key}: ${String(value)}`)
              .join(' · ')
          : '';
        return (
          <span className="text-xs text-muted-foreground">
            {row.reason ? <span className="text-foreground">{row.reason} </span> : null}
            {summary}
          </span>
        );
      },
    },
  ];

  return (
    <>
      <PageHeader
        title="Audit Log"
        description="Every financially meaningful action, written in the same transaction as the change it describes"
      />

      <DataTable
        rows={visible}
        columns={columns}
        getRowKey={(row) => row.id}
        empty={{ title: 'No audit entries yet' }}
      />

      <Pagination basePath="/audit" searchParams={params} page={page} hasMore={hasMore} />
    </>
  );
}

function toneFor(action: string) {
  if (action.includes('reversed') || action.includes('voided') || action.includes('deleted')) {
    return 'negative' as const;
  }
  if (action.includes('posted') || action.includes('approved')) return 'positive' as const;
  return 'neutral' as const;
}
