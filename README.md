# LedgerBase

A configurable, multi-tenant, double-entry accounting platform. Built to be
deployed for different clients and industries without rewriting the engine —
what changes per client is configuration, not code.

## What makes it correct

The general ledger is the source of truth. Invoices, bills, payments and
expenses are *source documents*: they describe intent, then produce balanced
journal entries. No balance is ever stored and incremented; every figure in
every report is aggregated from `journal_lines` at query time, so a report
cannot disagree with the ledger it describes.

**The invariants live in Postgres, not just in application code**, so they hold
even if a bug bypasses the service layer:

| Invariant | Enforced by |
|---|---|
| A line carries a debit or a credit, never both, never neither | `journal_lines_one_side_ck` |
| Amounts are never negative | `journal_lines_debit_nonneg_ck` / `..._credit_nonneg_ck` |
| A posted entry has total debits = total credits | `journal_entries_balanced_ck` |
| A line cannot reference another company's account | composite FK `(id, company_id)` |
| Payment allocations cannot exceed the payment | `payments_allocation_within_amount_ck` |

`npm run db:verify` attempts each violation against the live database and
asserts Postgres rejects it.

**Money is never a JS number.** Amounts are `numeric(20,6)` moved through the
app as decimal strings and computed with BigInt arithmetic. Binary floating
point cannot represent `0.1`, so accumulating float amounts drifts — and a
ledger that must satisfy `sum(debit) = sum(credit)` fails by fractions of a
cent with no bug to point at.

**Tenant isolation is structural.** Every financial table carries `company_id`
directly, and journal lines use composite foreign keys that carry it into the
reference. Cross-tenant contamination is not prevented by remembering a `WHERE`
clause; it is rejected by the database even from a hand-written `INSERT`.

**Financial history is immutable.** Posted entries cannot be edited or deleted.
A mistake is corrected by a linked reversal — a mirror-image entry — so both
the error and the correction remain visible in the audit trail.

## Stack

Next.js 15 (App Router, server components) · Drizzle ORM · Neon Postgres ·
TypeScript · Tailwind.

The Neon **WebSocket/Pool** driver is used rather than the HTTP driver:
posting a journal entry requires an interactive transaction spanning the header,
its lines and the balance assertion.

## Getting started

```bash
npm install
cp .env.example .env.local        # add your Neon DATABASE_URL and AUTH_SECRET
npx tsx scripts/migrate.ts        # apply migrations
npm run db:seed                   # demo company with realistic activity
npm run dev
```

Sign in with `owner@demo.test` / `demo-password-123`.

> **Note:** use `scripts/migrate.ts`, not `drizzle-kit migrate`. The latter can
> exit having applied nothing against Neon, leaving the migration table written
> but the DDL missing.

## Scripts

| Command | Purpose |
|---|---|
| `npm run dev` / `build` / `start` | Next.js |
| `npm test` | Unit + integration suites |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run db:generate` | Generate a migration from schema changes |
| `npm run db:seed` | Provision the demo company |
| `npm run db:verify` | Prove the ledger constraints reject bad data |
| `npm run db:reset` | Drop and recreate the schema (needs `ALLOW_DB_RESET=1`) |

## Testing

79 tests. Integration tests run against **real Neon**, not a mock, because the
invariants under test (balanced entries, tenant-scoped foreign keys, period
locks, `FOR UPDATE` serialisation) live in Postgres — a mock would only prove
the mock behaves.

Each test builds its own isolated organization and tears it down afterwards, so
runs are safe against a shared development database.

Coverage includes the full cycle from spec §36: create invoice → post → record
payment → verify AR, bank, revenue, journal entries and reports; plus
tenant-isolation tests confirming company A cannot read or post against company
B's data.

## Architecture

```
src/
├── db/schema/          Tables, constraints, relations
│   ├── tenancy.ts      Organization → Company → Branch
│   ├── ledger.ts       Accounts, fiscal periods, journal entries and lines
│   ├── documents.ts    Invoices/bills, payments, expenses, banking, budgets
│   └── config.ts       Numbering, taxes, currencies, custom fields, workflows
├── server/
│   ├── auth/           Sessions, tenant context, permission catalogue
│   └── services/       All financial logic — the only path to a mutation
├── lib/                Money arithmetic, line calculation, formatting
├── components/         Shared UI
└── app/                Routes (server components calling services directly)
```

Financial logic lives in services, never in components. Pages are server
components that resolve a `TenantContext` and call services directly — no
client-side fetching of financial data, so no amount is computed or filtered in
the browser.

### Tenancy

`Organization → Company → Branch`. The **company** is the accounting boundary:
a chart of accounts, base currency, fiscal calendar and ledger belong to exactly
one. A user's access comes from a `membership` row, so one accountant can serve
several companies without duplicate logins.

Every service takes a `TenantContext` rather than a `companyId` argument. A
caller cannot pass a company id it did not earn through a membership — the id is
read from the database, not from the request.

### What is configuration, not code

A new client should never require engine changes. These are all data:

chart of accounts (7 industry templates) · document numbering patterns · taxes
(rate, inclusive/exclusive, accounts) · currencies and dated exchange rates ·
approval workflows with amount thresholds · custom fields · roles and
permissions · branches · fiscal calendar.

Accounts the engine must find by function (AR control, AP control, tax,
retained earnings) are resolved by **role**, not by hardcoded code, so a client
can renumber their entire chart without breaking invoice posting.

## Known gaps

Honest about what is not built:

- **Cash flow is classified indirectly**, from the counterpart account each cash
  entry touches. A full indirect statement needs working-capital adjustments a
  general engine cannot infer.
- **Document creation is API-complete but UI-light.** Invoices, bills, payments
  and expenses can be created, posted, allocated and voided through the
  services (and are exercised by tests and the seed), but the browser forms for
  composing a new document are not built — the screens are read and lifecycle
  actions.
- **Attachments** have a schema column but no upload pipeline.
- **Document templates** (branded PDFs) are modelled but not rendered.
- **Rate limiting** is not implemented.
