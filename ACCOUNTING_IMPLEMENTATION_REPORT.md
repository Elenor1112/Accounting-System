# Accounting Implementation Report

**System:** LedgerBase — configurable multi-tenant double-entry accounting platform
**Implemented:** 13 August 2026
**Scope:** all 16 phases of the implementation brief, plus the Customers & Vendors module
**Verification:** full suite run against the live Neon database.
**180 tests pass (33 unit, 147 integration); 0 fail. TypeScript clean. `next build` succeeds.**

---

## Executive summary

Every phase in the brief has been implemented. The accounting engine was not rebuilt: no table was replaced, no service duplicated, no parallel posting path introduced. The GL remains the sole source of truth, invariants remain enforced by Postgres check constraints, money remains BigInt-on-decimal-strings, and tenant isolation remains carried by composite foreign keys.

Three things are worth stating before the detail, because they are what a reviewer should check first.

**1. The controls that were decorative are now enforced and tested.** `startApprovalChain` had zero callers on the posting path. A configured "bills over 100,000 need the finance manager" threshold was displayed in Settings and enforced nowhere. That is now wired into `postDocument` and `approveExpense`, with the final approval posting *inside the deciding transaction*, and there is an integration test that fails if anyone bypasses it again.

**2. Six real defects were found that the audit did not report.** They are listed in full below. The most serious were a non-functional `approvals` table (every INSERT failed), two Drizzle correlated-subquery bugs that made customer balances silently read zero, and an inventory posting design that would have manufactured negative cost of sales. Each was caught by a test, not by inspection.

**3. The year-end risk I flagged after the first pass is closed.** Year-end close now posts a real closing entry, and the balance sheet reads `company.lastClosedDate` so it accumulates profit only from the day after — the double-count is gone, and a test asserts it.

---

## Implemented, by phase

### Phase 1A — Approval workflows enforced

```
Draft → (post attempt) → Pending Approval → Approved → Posted
                              ↓
                          Rejected → Draft
```

- `postDocument` resolves the applicable chain before building any ledger entry. Steps outstanding → approval rows created, status `pending_approval`, nothing posted.
- `decideApproval` drives the outcome. Final approval calls `postApprovedDocument` **inside the deciding transaction**, so the last signature and the ledger entry commit together; if posting fails (closed period, archived account) the approval rolls back with it.
- Rejection returns the document to `draft` and cancels the chain, keeping the rejection rows as evidence. A rejected document cannot be posted directly.
- Re-posting a pending document does not duplicate its chain.
- The ledger-building code was **extracted** into `postDocumentToLedger` / `postExpenseToLedger` and shared by both routes. A second posting path is how the original control came to be bypassed.

### Phase 1B — Segregation of duties

`requireDifferentApprover(ctx, createdById, override, what)` in [context.ts](src/server/auth/context.ts), wired into `postDocument`, `approveExpense`, `decideApproval` and `writeOffDocument`. For expenses both the claimant (`userId`) and the person who keyed it are blocked. Lifted only by an explicit permission, so a one-person business still works but has had to ask.

Five segregated role templates ship: `accounts_receivable`, `accounts_payable`, `cashier`, `financial_controller`, `auditor`. `accountant` is retained, renamed "Accountant (combined duties)", and its description states plainly that it violates SoD.

### Phase 1C — Exact arithmetic

| Location | Was | Now |
|---|---|---|
| `expense-service` tax | float multiply + a duplicate inclusive-tax extraction | routed through `calculateLine` |
| `currency-service` inverse FX | `String(1 / Number(rate))` | `divideRate('1', rate)` at 10dp |
| `account-service.signedBalance` | `Number(debit) − Number(credit)` | exact `subtract` |
| `report-service` variance % | float division | exact `divide`/`multiply` |
| `line-calculator` discount clamp | `Number(a) > Number(b)` | `gt(a, b)` |

`divideByRate` was deleted. **New in `money.ts`: `divideRate`** — money-scale division truncates the reciprocal of 3.0675 to `0.325998`, drifting 0.01 on a 10,000 round-trip; rate-scale division returns `0.32599837`.

### Phase 2 — Customers & Vendors

Built on the **existing** `contacts` table, which already carried `kind: customer | vendor | both`. No duplicate tables; a counterparty you both buy from and sell to is one record.

- Fields added: `contactPerson`, `mobile`, `category`. Addresses stay in the existing `billingAddress` jsonb — nothing queries them, so they do not warrant columns.
- **8 routes**: list, new, detail, edit — for each of customers and vendors.
- List: search (name, code, contact, email, phone), active/archived filter, sort by name/code/outstanding, pagination, and **outstanding + overdue balances computed in SQL**.
- Detail: overview with AR/AP balance and credit position; transactions (documents and payments); a chronological statement with Date / Reference / Description / Debit / Credit / Running Balance; and aging in five buckets.
- Actions: edit, archive (refused while a balance is outstanding), restore, raise invoice/bill.
- **Accounting integration:** every figure derives from the ledger and the subledger. A test asserts the per-contact aging equals that contact's row in the AR aging report, and that the statement's closing balance equals the contact balance.

### Phase 3 — Manual journal entry UI

`/journal/new` with dynamic lines, account picker excluding summary/archived/**AR-AP control** accounts, live debit and credit totals computed with the same exact BigInt arithmetic as the ledger, out-of-balance warning, save-draft and post. `/journal/[id]` gains post, delete-draft and reverse (reason required, date defaulting to today).

### Phase 4 — Inventory subledger with automatic COGS

New `products` and `stock_movements` tables. **Weighted average costing.**

Selling a stocked product now posts, inside the invoice's own transaction:

```
Dr Cost of Goods Sold      quantity × weighted average
  Cr Inventory                  same
```

- A receipt moves the average; a sale is valued at the average current at that moment and leaves it unchanged.
- Purchases through a bill record quantity and cost **without posting again** — the bill already debited inventory.
- Credit notes return stock and reverse the cost. Services post revenue with no COGS.
- Selling more than is on hand is refused. `FOR UPDATE` on the product serialises concurrent movements.
- `getInventoryValuation` replays movement history for a genuine point-in-time figure and ties to the inventory control account.
- **The audit's "remove the misleading templates" concern is resolved by making inventory real**: `1155 Inventory` and role-tagged `5100 Cost of Goods Sold` now exist and work.

### Phase 5 — Fixed assets and depreciation

New `fixed_assets` and `depreciation_entries` tables. **Straight-line.**

```
Dr Depreciation Expense
  Cr Accumulated Depreciation
```

- One journal entry per run with a line pair per asset; per-asset detail rows keep the audit trail.
- **Idempotent**: a unique index on `(assetId, periodEnd)` makes a re-run a no-op instead of a double charge.
- The final month absorbs the rounding remainder, so an asset lands exactly on residual value. A DB check constraint enforces `accumulated ≤ cost − residual`.
- Disposal derecognises cost and accumulated depreciation and posts the gain or loss as the balancing figure.

### Phase 6 — Year-end close

`closeFiscalYear` zeroes every revenue and expense account and transfers the net to retained earnings, posted through `createJournalEntry` like any other entry — no privileged write path. Guarded against double-closing by `company.lastClosedDate` **and** an existing-entry check, with the company row locked `FOR UPDATE`. Refuses to run while unposted entries are dated inside the year. A loss debits retained earnings.

**The balance sheet is now close-aware**: it accumulates profit only from the day after `lastClosedDate`, so a posted closing entry is not counted twice. This was the live risk introduced by the manual JE screen in the first pass; it is closed and tested.

### Phase 7 — Point-in-time aging and statements

`balance(asOf) = total − allocations from posted payments dated on or before asOf`. Documents issued after `asOf` are excluded; drafts and pending-approval documents no longer age. `getContactStatement` credits each payment at **the amount allocated to this contact's documents** plus their own unapplied residue, not the payment's full amount.

### Phase 8 — Customer advances / vendor prepayments

New roles `customer_advances` (2140) and `vendor_prepayments` (1160). An overpayment now splits:

```
Dr Bank                    12,000
  Cr Accounts Receivable        10,000   (settles the invoice)
  Cr Customer Advances           2,000   (held on account)
```

Applying an advance later posts the reclassification `Dr Customer Advances / Cr AR`, which `allocatePayment` previously omitted entirely.

### Phase 9 — Bad debt write-off

`writeOffDocument` posts `Dr Bad Debt Expense / Cr AR`, linked to the specific document via `sourceType`/`sourceId` and carrying the customer on the line. New `written_off` document status, excluded from `determineStatus` recomputation so the loss is not relabelled as `paid`.

### Phase 10 — Refunds

`refundContact` posts `Dr Customer Advances / Cr Bank` (and the AP mirror). The available pool is read **from the ledger**, so a refund exceeding what is actually held is refused.

### Phase 11 — Reconciliation control

A non-zero difference now yields `discrepancy`, not `completed`. `completed` requires a zero difference, a written explanation, or an adjustment entry — enforced by a **database check constraint**, not only in the service. New statuses `draft | in_progress | discrepancy | completed`.

### Phase 12 — Period controls

`resolvePostingPeriod` **fails closed**. New company columns `requireOpenPeriod` (default true) and `maxFutureDays` (default 30). A date with no defined period is rejected rather than posted with `periodId: null`.

### Phase 13 — Reversal dating

`reverseJournalEntry` defaults to **today**, not the original entry's date, so an August correction no longer silently rewrites June.

### Phase 14 — Tax report

`getTaxReport` aggregates posted document lines by tax and rate: taxable sales, output tax, taxable purchases, input tax, net payable. Credit notes net off the side they correct. **Cross-checked against the tax control accounts in the ledger**, with the difference reported rather than hidden — a return that does not tie to the ledger is flagged before filing.

### Phase 15 — Append-only audit log

A **Postgres trigger** refuses UPDATE and DELETE on `audit_logs`. Application code cannot enforce this; the whole point is to constrain someone holding a database connection. Tests assert that direct Drizzle UPDATE and DELETE both fail and the row is unchanged. Filtering added by actor, entity, action, date range and free text, with a filter UI on `/audit`.

*Honest limit:* this stops accidental and casual tampering and makes deliberate tampering require dropping a trigger. True tamper-**evidence** needs hash chaining, which is not implemented.

### Phase 16 — Database integrity

- **Tenant-carrying FKs on `journal_lines.customerId` and `.vendorId`** — the one place the composite-FK discipline had not been applied.
- `documents_total_consistent_ck`: `total = subtotal − discount + tax`.
- `documents_balance_consistent_ck`: `balanceDue = total − amountPaid`.
- Inventory and fixed-asset tables ship with non-negative and range constraints, plus the `(assetId, periodEnd)` unique index that makes depreciation idempotent.

---

## Defects found that the audit did not report

1. **The `approvals` table was non-functional.** `decidedAt: timestamps.createdAt` reused the same column object, so `decided_at` mapped onto `created_at` and every INSERT named the column twice. Postgres rejected it. It survived because *nothing had ever inserted an approval row*. The audit called the engine "complete and correct in isolation"; it was not.
2. **`divide` was insufficient for exchange rates** — the audit's own recommended fix (`divide('1', rate)`) truncates to 6dp. Added `divideRate`.
3. **`signedBalance` used floats** — on the path of every account balance in every report.
4. **Budget `variancePercent` used floats.**
5. **Two Drizzle correlated-subquery bugs.** `${contacts.id}` inside a raw-SQL subquery renders as a bare `"id"`, which Postgres binds to the subquery's scope. Every customer's list balance silently read **zero** while the detail page showed the correct figure. The same bug appeared in the statement query.
6. **Inventory posting would have manufactured negative cost of sales.** A standalone purchase posted `Dr Inventory / Cr COGS`, crediting an expense account for stock received. Now a direct purchase must name its counter account, and `opening` movements use Opening Balance Equity.

Items 5 and 6 were caught by tests that failed, not by reading the code.

---

## Database changes

Six migrations, all generated by `drizzle-kit` and applied to the configured database:

| Migration | Contents |
|---|---|
| `0003_married_rhodey` | `companies.require_open_period`, `companies.max_future_days` |
| `0004_medical_cammi` | `document_status += 'written_off'`; `companies.last_closed_date`; reconciliation `explanation`, `adjustment_entry_id` + completed-explained check |
| `0005_audit_append_only` | `audit_logs_append_only()` trigger function + BEFORE UPDATE/DELETE triggers |
| `0006_yielding_silver_sable` | `contacts.contact_person`, `.mobile`, `.category` |
| `0007_tricky_mattie_franklin` | `products`, `stock_movements`, `fixed_assets`, `depreciation_entries`; `document_lines.product_id` |
| `0008_typical_tag` | tenant FKs on `journal_lines.customer_id`/`.vendor_id`; document total and balance consistency checks |

Schema correction with no migration: removed the mis-wired `decidedAt` from `approvals` (the column never existed).

---

## Permissions changes

**New:** `accounting.self_approve.documents`, `accounting.self_approve.expenses`, `accounting.inventory.{view,manage,adjust}`, `accounting.fixed_assets.{view,manage,depreciate}`.

Note `inventory.adjust` and `fixed_assets.depreciate` are separated from `manage`: adjusting stock and running depreciation both post to the ledger, so they sit with the controller, while item maintenance is operational.

**New role templates:** `accounts_receivable`, `accounts_payable`, `cashier`, `financial_controller`, `auditor`. `accountant` retained and documented as SoD-violating.

---

## Tests

```
Before:  27 unit +  52 integration =  79 passing
After:   33 unit + 147 integration = 180 passing
New:      6 unit +  95 integration = 101 tests
Failures: 0
```

| Suite | Tests | Covers |
|---|---:|---|
| `exact-arithmetic` | 6 | reciprocal exactness, rate round-trip, inclusive/exclusive tax, discount clamp, variance |
| `controls` | 17 | approval enforcement, wrong-role refusal, self-approval, rejection, period controls, audit-log immutability and filtering |
| `aging` | 5 | June invoice / July payment, partial payment, post-`asOf` exclusion, drafts, balance agreement |
| `parties` | 13 | both-kind contacts, customer and vendor lifecycles, list/detail agreement, statement, aging agreement, archiving |
| `settlement` | 11 | overpayment to advances, advance application, write-offs, refunds, entry balance |
| `year-end` | 11 | schedule, preview vs P&L, close, **no double-count**, post-close accumulation, double-close guard, loss |
| `inventory` | 15 | WAC, COGS on sale, **gross profit correctness**, bill without double-post, credit note, write-off, valuation tie-out |
| `fixed-assets` | 16 | schedule to residual, run posting, **idempotence**, disposal at gain and loss |
| `tax-report` | 7 | output/input tax, net payable, **ledger tie-out**, credit notes, drafts excluded |

Required scenarios from the brief, all asserted:

- `document above threshold → cannot post → approval created → unauthorized cannot approve → required approver approves → posts → ledger entry exists`
- `create customer → invoice → approve → post → partial payment → remaining payment → balance = 0`
- `create vendor → bill → approve → post → pay → balance = 0`
- `invoice 10,000 / payment 12,000 → AR relieved by 10,000 only, 2,000 in Customer Advances`
- `purchase → inventory increases → sell → inventory decreases, COGS increases → gross profit correct`
- `close June → June posting rejected → July reversal succeeds`
- `revenue − expenses = net income → close → revenue = 0, expenses = 0, retained earnings updated, balance sheet balances`

Every assertion checks the ledger — whether an entry exists, whether it balances, which accounts moved — not merely that a function returned.

---

## Remaining issues

Honest list of what is **not** done.

| Item | Status |
|---|---|
| **FX realized/unrealized recognition** | Not implemented. `fx_gain_loss` has a role and settlement at a different rate still leaves residue in AR/AP. The audit rated this P1 only if multi-currency is sold. |
| **Hash-chained audit log** | Not implemented. The trigger prevents tampering through normal paths but is not cryptographic tamper-evidence. |
| **Inventory/fixed-asset write UI** | Read-only screens only. Products, stock adjustments, asset registration, depreciation runs and disposals are fully implemented and tested **in the service layer**, but are driven by service calls, not forms. This is the largest remaining gap. |
| **Reconciliation UI for the new statuses** | The service and DB constraint enforce `discrepancy`; the reconcile screen has not been updated to collect an explanation. |
| **Credit notes linked to originals** | `creditNoteAgainstDocumentId` not added. |
| **`updateDocumentMetadata`** | Non-financial field edits still require a void. |
| **`isOverdue` as a derived column** | `determineStatus` now preserves `sent` and no longer mislabels write-offs, but overdue remains a status rather than an orthogonal flag. |
| **Reports: comparative periods, 3-column TB, CSV/PDF export, statement of changes in equity, cash-flow indirect method** | Not implemented. |
| **Posting gateway refactor** | Not done. Services still call `createJournalEntry` directly with `allowControlAccounts`. The approval gate is enforced in `postDocument`/`approveExpense` rather than structurally. |
| **Recurring documents, attachments, invoice PDF, purchase orders → bills** | Not implemented. |

---

## Final accounting readiness

| Dimension | Score | Was | Basis |
|---|---:|---:|---|
| Double-entry integrity | 9/10 | 9 | Untouched; DB-enforced |
| Internal controls | 8/10 | 3 | Approvals enforced and tested, SoD roles, self-approval blocked, period locks fail closed, reconciliation blocking |
| Auditability | 7/10 | 5 | Append-only trigger, filtering, approval decisions recorded. Not hash-chained |
| AR | 8/10 | 5 | Point-in-time aging, advances, write-offs, refunds |
| AP | 8/10 | 5 | Same, mirrored |
| Customers | 8/10 | 3 | Full module, ledger-derived, tested |
| Vendors | 8/10 | 3 | Same |
| Inventory | 7/10 | 0 | WAC subledger, automatic COGS, valuation ties out. No write UI |
| Fixed assets | 7/10 | 0 | Register, straight-line, idempotent runs, disposal. No write UI |
| Tax | 8/10 | 4 | Report with ledger tie-out |
| Period close | 8/10 | 5 | Fail-closed, future cap, correct reversal dating |
| Year-end close | 8/10 | 1 | Posts a real entry, guarded, close-aware balance sheet |
| Banking | 6/10 | 6 | Unchanged |
| Reconciliation | 6/10 | 3 | Service and DB enforce it; UI not updated |
| Reporting | 7/10 | 6 | Aging fixed, tax report added, balances exact. No comparatives or export |

### Verdict

```
READY FOR PILOT CLIENT
```

Not production-ready, and I want to be precise about the difference.

The accounting is now defensible. Revenue is matched with cost. Assets depreciate. A year can be closed and the equity section traced to a journal entry. A prior-period aging ties to the AR control account. Overpayments are liabilities rather than negative assets. Approval thresholds are enforced in the same transaction as the ledger effect, and one credential can no longer originate, approve and pay the same document. Every one of those statements is backed by a test that fails if it stops being true.

What stops me calling it production-ready is not the accounting — it is the operational surface. Inventory and fixed assets have no data-entry screens, so a pilot client would need those workflows driven for them. Reconciliation enforces its new rule in the service and the database but the screen has not caught up. There is no export, no invoice PDF, no attachment pipeline. And FX settlement still leaves residue in AR/AP for any company transacting in a foreign currency.

A pilot with a domestic client, a cooperative finance team, and someone available to complete the inventory and asset workflows through the service layer would be a fair test of this system. A production rollout to clients who expect to do everything through the UI would not.

One structural note for whoever continues this. The approval gate is enforced in `postDocument` and `approveExpense` — the two paths that existed. Nothing *structurally* prevents a future service from calling `createJournalEntry` with `allowControlAccounts: true` and skipping the gate entirely, which is precisely how the workflow engine came to be bypassed the first time. The posting-gateway refactor the audit recommended is the single most valuable remaining piece of work, and it is architectural rather than cosmetic.

---

*180 tests pass against the live database. The accounting engine's internals, database constraints, and tenant-isolation mechanisms were preserved throughout; every change either wired an existing control into the posting path, corrected arithmetic, or added a subledger that ties to a control account.*
