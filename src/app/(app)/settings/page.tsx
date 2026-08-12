import { Badge, Card, PageHeader, SectionTitle, TableWrap } from '@/components/ui';
import * as fmt from '@/lib/format';
import { requireTenantContext } from '@/server/auth/session';
import {
  getCompany,
  listBranches,
  listCompanyUsers,
  listRoles,
} from '@/server/services/company-service';
import { listWorkflows } from '@/server/services/workflow-service';

export const metadata = { title: 'Settings — LedgerBase' };
export const dynamic = 'force-dynamic';

export default async function SettingsPage() {
  const ctx = await requireTenantContext();

  const [company, branches, users, roles, workflows] = await Promise.all([
    getCompany(ctx),
    listBranches(ctx),
    listCompanyUsers(ctx),
    listRoles(ctx),
    listWorkflows(ctx),
  ]);

  return (
    <>
      <PageHeader
        title="Settings"
        description="Configuration that adapts the engine to this business — no code changes required"
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <SectionTitle>Company</SectionTitle>
          <dl className="space-y-1.5 text-sm">
            <Row label="Name" value={company.name} />
            <Row label="Legal name" value={company.legalName ?? '—'} />
            <Row label="Base currency" value={company.baseCurrencyCode} />
            <Row
              label="Fiscal year starts"
              value={new Date(Date.UTC(2000, company.fiscalYearStartMonth - 1, 1)).toLocaleString(
                'en-US',
                { month: 'long', timeZone: 'UTC' },
              )}
            />
            <Row label="Timezone" value={company.timezone} />
            <Row label="Country" value={company.countryCode ?? '—'} />
            <Row label="Tax identifier" value={company.taxIdentifier ?? '—'} />
          </dl>
          <p className="mt-3 border-t border-border pt-2 text-xs text-subtle-foreground">
            Base currency cannot be changed once entries are posted — doing so would
            reinterpret every historical base amount.
          </p>
        </Card>

        <Card>
          <SectionTitle>Branches</SectionTitle>
          {branches.length === 0 ? (
            <p className="py-4 text-sm text-muted-foreground">
              No branches configured. Transactions belong to the company as a whole.
            </p>
          ) : (
            <ul className="divide-y divide-border text-sm">
              {branches.map((branch) => (
                <li key={branch.id} className="flex items-center justify-between py-2">
                  <span>
                    <span className="tabular text-muted-foreground">{branch.code}</span>{' '}
                    {branch.name}
                  </span>
                  <Badge tone={branch.isActive ? 'positive' : 'neutral'}>
                    {branch.isActive ? 'Active' : 'Inactive'}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <div className="mt-4">
        <SectionTitle>Users and roles</SectionTitle>
        <TableWrap>
          <table className="data-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Email</th>
                <th>Role</th>
                <th>Branch access</th>
                <th>Last sign-in</th>
              </tr>
            </thead>
            <tbody>
              {users.map((user) => (
                <tr key={user.membershipId}>
                  <td className="font-medium">{user.name}</td>
                  <td className="text-muted-foreground">{user.email}</td>
                  <td>
                    <Badge tone="accent">{user.roleName}</Badge>
                  </td>
                  <td className="text-muted-foreground">
                    {user.branchIds.length === 0
                      ? 'All branches'
                      : `${user.branchIds.length} branch(es)`}
                  </td>
                  <td className="text-muted-foreground">
                    {user.lastLoginAt ? fmt.dateTime(user.lastLoginAt) : 'Never'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card>
          <SectionTitle>Roles</SectionTitle>
          <ul className="divide-y divide-border text-sm">
            {roles.map((role) => (
              <li key={role.id} className="py-2">
                <div className="flex items-center justify-between">
                  <span className="font-medium">{role.name}</span>
                  <span className="text-xs text-muted-foreground">
                    {role.permissions.includes('*')
                      ? 'All permissions'
                      : `${role.permissions.length} permissions`}
                  </span>
                </div>
                {role.description ? (
                  <p className="text-xs text-muted-foreground">{role.description}</p>
                ) : null}
              </li>
            ))}
          </ul>
        </Card>

        <Card>
          <SectionTitle>Approval workflows</SectionTitle>
          {workflows.length === 0 ? (
            <p className="py-4 text-sm text-muted-foreground">
              No workflows configured. Documents post as soon as someone with the right
              permission approves them.
            </p>
          ) : (
            <ul className="divide-y divide-border text-sm">
              {workflows.map((workflow) => (
                <li key={workflow.id} className="py-2">
                  <div className="flex items-center justify-between">
                    <span className="font-medium">{workflow.name}</span>
                    <Badge tone="neutral">{fmt.humanise(workflow.documentType)}</Badge>
                  </div>
                  <ol className="mt-1 space-y-0.5">
                    {workflow.steps.map((step) => (
                      <li key={step.id} className="text-xs text-muted-foreground">
                        {step.stepOrder}. {step.name}
                        {step.approverRoleKey ? ` — ${step.approverRoleKey}` : ''}
                        {step.minAmount
                          ? ` (over ${fmt.money(step.minAmount, {
                              currency: ctx.baseCurrencyCode,
                              precision: ctx.currencyPrecision,
                            })})`
                          : ''}
                      </li>
                    ))}
                  </ol>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-foreground">{value}</dd>
    </div>
  );
}
