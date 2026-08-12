import { Badge, Card, PageHeader, TableWrap } from '@/components/ui';
import { requireTenantContext } from '@/server/auth/session';
import { getAccountTree } from '@/server/services/account-service';

export const metadata = { title: 'Chart of Accounts — LedgerBase' };
export const dynamic = 'force-dynamic';

type TreeNode = Awaited<ReturnType<typeof getAccountTree>>[number];

const TYPE_LABELS: Record<string, string> = {
  asset: 'Assets',
  liability: 'Liabilities',
  equity: 'Equity',
  revenue: 'Revenue',
  expense: 'Expenses',
};

export default async function AccountsPage() {
  const ctx = await requireTenantContext();
  const tree = await getAccountTree(ctx);

  // Grouped by type so the chart reads in the order of the accounting
  // equation rather than as one flat list of codes.
  const byType = new Map<string, TreeNode[]>();
  for (const node of tree) {
    byType.set(node.type, [...(byType.get(node.type) ?? []), node]);
  }

  const order = ['asset', 'liability', 'equity', 'revenue', 'expense'];

  return (
    <>
      <PageHeader
        title="Chart of Accounts"
        description="The account structure every transaction posts against"
      />

      <div className="space-y-5">
        {order.map((type) => {
          const nodes = byType.get(type);
          if (!nodes || nodes.length === 0) return null;

          return (
            <div key={type}>
              <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {TYPE_LABELS[type]}
              </h2>
              <TableWrap>
                <table className="data-table">
                  <thead>
                    <tr>
                      <th style={{ width: '110px' }}>Code</th>
                      <th>Name</th>
                      <th style={{ width: '180px' }}>Classification</th>
                      <th style={{ width: '200px' }}>Notes</th>
                    </tr>
                  </thead>
                  <tbody>
                    {nodes.flatMap((node) => renderRows(node, 0))}
                  </tbody>
                </table>
              </TableWrap>
            </div>
          );
        })}

        {tree.length === 0 ? (
          <Card>
            <p className="py-8 text-center text-sm text-muted-foreground">
              No accounts configured yet.
            </p>
          </Card>
        ) : null}
      </div>
    </>
  );
}

/** Renders a node and its children, indenting by depth. */
function renderRows(node: TreeNode, depth: number): React.ReactElement[] {
  const rows: React.ReactElement[] = [
    <tr key={node.id}>
      <td className="tabular text-muted-foreground">{node.code}</td>
      <td>
        <span style={{ paddingLeft: depth * 18 }} className="inline-block">
          <span
            className={
              node.isPostable ? 'text-foreground' : 'font-medium text-muted-foreground'
            }
          >
            {node.name}
          </span>
        </span>
      </td>
      <td className="text-muted-foreground">
        {node.subtype.replace(/_/g, ' ')}
      </td>
      <td>
        <div className="flex flex-wrap gap-1">
          {node.isControlAccount ? <Badge tone="accent">Control</Badge> : null}
          {!node.isPostable ? <Badge tone="neutral">Summary</Badge> : null}
          {node.role ? <Badge tone="warning">{node.role.replace(/_/g, ' ')}</Badge> : null}
          {node.isArchived ? <Badge tone="negative">Archived</Badge> : null}
        </div>
      </td>
    </tr>,
  ];

  for (const child of node.children as TreeNode[]) {
    rows.push(...renderRows(child, depth + 1));
  }
  return rows;
}
