# Accounting System Audit

**System:** LedgerBase — configurable multi-tenant double-entry accounting platform
**Audited:** 13 August 2026
**Auditor perspective:** Senior accountant / financial controller who would personally sign the financial statements
**Method:** Full read of schema, migrations, services, reports, permissions and UI routes. Unit suite executed (27/27 pass). No code modified.

---

## Executive Summary

This is a genuinely well-built accounting *engine* wearing an incomplete accounting *system*. That distinction matters more than any single finding below.

The foundation is better than most commercial small-business accounting products I have reviewed. Money is `numeric(20,6)` moved as decimal strings and computed on BigInt — never a JS float. The general ledger is the only source of truth; no balance is stored and incremented, so a report structurally cannot disagree with the ledger. Critically, the core invariants are enforced by **Postgres check constraints**, not merely by application code: an unbalanced posted entry, a line carrying both a debit and a credit, a negative amount, or a journal line pointing at another tenant's account are all rejected by the database even from a hand-written `INSERT`. That is the right architecture, and it is rare.

What is missing is not polish. Three things stand between this and a real company's books:

1. **The approval workflow engine is fully built and never invoked.** `startApprovalChain` and `decideApproval` exist, are tested, and have zero callers outside the dashboard's read-only inbox. `postDocument` posts straight to the ledger on a single permission check. Every configured approval threshold — "invoices over 50,000 need the finance manager" — is decorative.
2. **Segregation of duties does not exist in practice.** The default `accountant` role can create, post, reverse, pay *and* reconcile. One person with routine credentials can originate a fictitious vendor bill, pay it to an account they control, and mark the bank line reconciled, leaving a clean trial balance.
3. **Inventory and fixed assets are account subtypes with no subledger behind them.** The COA templates offer Inventory and Accumulated Depreciation accounts; there is no item master, no stock movement table, no costing method (FIFO/WAC), and no depreciation engine. Any inventory or asset-holding business would be keeping those books by hand in a system that looks like it handles them.

There are also two real arithmetic defects — float contamination in expense tax and in inverse FX rates — inside a codebase whose entire stated premise is that money never becomes a JS number.

| Dimension | Score | Basis |
|---|---:|---|
| Production readiness | **4/10** | Engine is sound; approvals unenforced, no manual JE UI, no inventory/FA, document creation UI only just appearing |
| Accounting correctness | **7/10** | Double-entry, tax, AR/AP settlement and reversals are correct. Float defects in expense tax and FX; aging report misstates as-of history |
| Financial controls | **3/10** | Period locks and immutability are excellent. Approvals unenforced, no SoD, self-approval unrestricted |
| Reporting | **6/10** | TB/BS/P&L/GL correct and ledger-derived. Cash flow approximated; no tax return, no inventory valuation; aging historically wrong |
| Data integrity | **9/10** | Best area. DB-level invariants, composite tenant FKs, atomic transactions, immutable history |
| Scalability as a commercial product | **6/10** | Configuration-over-code is real and well executed. Gaps are whole modules, not rework of what exists |

**Verdict:** Do not put a real company's books on this yet. The gap is roughly one focused quarter of work, and almost none of it requires touching the engine — which is the best thing I can say about an incomplete accounting system.

---

## Critical Findings

### [CRITICAL] Approval workflows are built but never enforced

**Problem:** `workflow-service.ts` implements a complete, ordered, role-gated, amount-threshold approval chain (297 lines, including `startApprovalChain`, `decideApproval`, rejection cascade and role checks). Nothing calls it. A repository-wide search for callers returns exactly one hit: `listPendingApprovals` in the dashboard, which only *displays* an inbox that nothing ever populates.

`postDocument` ([document-service.ts:283](src/server/services/document-service.ts#L283)) checks a single permission (`invoices.approve` / `bills.approve`) and posts directly to the ledger. It never asks whether a workflow applies, never creates approval rows, and never checks whether required approvals were granted.

**Why it matters:** Approval configuration is the primary internal control a client will *believe* they have bought. An administrator configures "bills over 100,000 require the finance manager," sees the workflow saved in Settings, and reasonably concludes the control is live. It is not. A bookkeeper holding `bills.approve` posts a 5,000,000 bill with one click and no second signature. This is worse than having no workflow feature at all, because the UI actively misrepresents the control environment — an auditor testing controls would be told approvals are enforced and would find no evidence they ever ran.

**Accounting impact:** No enforced authorization over ledger entry. Every posted document is a single-person action regardless of amount. In an audit this is a material weakness in internal control over financial reporting; for a company subject to any external assurance it would need to be reported.

**Current implementation:** Engine complete and correct in isolation; zero integration into the posting path.

**Expected behaviour:** `postDocument` should, inside its existing transaction: resolve applicable steps via `getApplicableSteps`; if any apply and approvals are incomplete, set the document to `pending_approval` and create the approval rows rather than posting; only post once the chain is fully approved. `decideApproval` completing the final step should trigger the post.

**Recommended solution:** Wire `startApprovalChain` into `postDocument` and add a `postApprovedDocument` path invoked when `decideApproval` returns `complete: true`. Add an integration test asserting a document above threshold cannot reach `posted` without the required decisions — the absence of that test is why this shipped.

**Affected files:** [document-service.ts:283](src/server/services/document-service.ts#L283), [workflow-service.ts](src/server/services/workflow-service.ts), [expense-service.ts:192](src/server/services/expense-service.ts#L192), [invoices/actions.ts:28](src/app/(app)/invoices/actions.ts#L28)

**Priority:** P0

---

### [CRITICAL] No segregation of duties — one role can originate, post, pay and reconcile

**Problem:** The default `accountant` role template ([permissions.ts:99](src/server/auth/permissions.ts#L99)) grants `invoices.create` + `invoices.approve` + `bills.create` + `bills.approve` + `payments.create` + `transactions.post` + `transactions.reverse` + `banking.manage` + `banking.reconcile` + `contacts.manage` simultaneously. No permission check anywhere compares the acting user against the document's `createdById`.

**Why it matters:** This is the classic fraud triangle closed by a single credential. The complete attack: create a vendor contact (`contacts.manage`) → raise a bill against it (`bills.create`) → approve and post it (`bills.approve`) → pay it to a controlled bank account (`payments.create`) → import a statement and mark the payment reconciled (`banking.reconcile`). The trial balance balances perfectly at every step. The audit log faithfully records that one user did all five things, but nothing *prevented* it, and no report surfaces the pattern.

**Accounting impact:** Cash misappropriation with no compensating control. Every figure remains internally consistent, so detection depends entirely on someone reading the audit log — which no screen aggregates by actor.

**Current implementation:** `hasPermission` is a flat `includes` check ([permissions.ts:192](src/server/auth/permissions.ts#L192)). No maker-checker concept exists in the codebase.

**Expected behaviour:** Approving or posting a document should be refused when `ctx.userId === document.createdById`, unless a role explicitly holds a `*.self_approve` override. Bank reconciliation should be separable from payment creation. Role templates should ship segregated by default — the permissive combination should require deliberate configuration.

**Recommended solution:** (a) Add a self-approval guard in `postDocument`, `approveExpense` and `decideApproval`. (b) Split the shipped `accountant` template into `accounts_payable`, `accounts_receivable`, `cashier` and `financial_controller`, keeping `accountant` available but documented as SoD-violating. (c) Add a controller-facing report listing documents where creator and approver match.

**Affected files:** [permissions.ts:91-190](src/server/auth/permissions.ts#L91-L190), [document-service.ts:297](src/server/services/document-service.ts#L297), [expense-service.ts:192](src/server/services/expense-service.ts#L192)

**Priority:** P0

---

### [CRITICAL] Float arithmetic in expense tax and inverse FX rates

**Problem:** Two paths abandon the BigInt discipline the system is explicitly built on.

Expense tax ([expense-service.ts:97-99](src/server/services/expense-service.ts#L97-L99) and [:148](src/server/services/expense-service.ts#L148)):
```ts
taxAmount = tax.isInclusive
  ? subtract(amount, divideByRate(amount, tax.ratePercent))
  : money(String((Number(amount) * Number(tax.ratePercent)) / 100));
// and
const base = (Number(amountValue) * 100) / (100 + Number(ratePercent));
```

Inverse FX ([currency-service.ts:75-76](src/server/services/currency-service.ts#L75-L76)):
```ts
if (inverse && Number(inverse.rate) !== 0) {
  return String(1 / Number(inverse.rate));
}
```

**Why it matters:** `money.ts` opens with a 15-line comment explaining that binary floating point cannot represent 0.1 and that a ledger satisfying `sum(debit) = sum(credit)` cannot tolerate the drift. `line-calculator.ts` honours this exactly. These two paths do not — and they are on the posting path, not the display path.

The FX case is the more dangerous of the two. `1 / 3.0675` produces `0.32599837816462264` — an 17-significant-digit string handed to a `numeric(20,10)` column that truncates to `0.3259983782`. Every foreign-currency amount converted through an inverse rate is then computed from a rate that is not the true reciprocal. Round-tripping a value through both directions will not return the original.

**Accounting impact:** Expense tax can be off by a minor unit, splitting the expense/recoverable-tax/credit legs by amounts that must still sum exactly — the entry balances only because the credit is derived by addition, so the error silently lands in either the expense or the tax account and misstates recoverable input VAT on a filed return. For FX, every inverse-rate conversion carries a systematic rate error; with foreign AR/AP the reciprocal drift accumulates and cannot be reconciled to any published rate.

**Current implementation:** Float multiplication and division on money and rate values.

**Expected behaviour:** Use the existing exact helpers. Expense tax should reuse `calculateLine` from `line-calculator.ts`, which already implements both inclusive and exclusive tax correctly and is covered by passing unit tests. Inverse rates should use `divide('1', inverse.rate)` — `money.ts` already provides exact reciprocal division at rate scale.

**Recommended solution:** Replace both. Delete `divideByRate` and route expense tax through `calculateLine`, eliminating the duplicated (and less correct) second implementation of inclusive-tax extraction. Add unit tests asserting inclusive expense tax matches the line-calculator result, and that a rate round-trips.

**Affected files:** [expense-service.ts:97-99](src/server/services/expense-service.ts#L97-L99), [expense-service.ts:146-150](src/server/services/expense-service.ts#L146-L150), [currency-service.ts:75-77](src/server/services/currency-service.ts#L75-L77)

**Priority:** P0

---

### [CRITICAL] Inventory has no subledger — quantity, valuation and COGS do not exist

**Problem:** Inventory appears in the system only as an account subtype (`'inventory'` in [_shared.ts:81](src/db/schema/_shared.ts#L81)) and as accounts in the retail/restaurant/manufacturing COA templates. There is no product/item table, no stock movement or layer table, no costing method, and no COGS posting anywhere. `postDocument` credits the revenue account named on each invoice line and stops — it never posts the second entry a goods sale requires.

**Why it matters:** A retailer sells a widget for 10,000 that cost 6,000. Correct accounting requires two entries:
```
Dr Accounts Receivable   10,000      Dr Cost of Goods Sold    6,000
  Cr Sales Revenue       10,000        Cr Inventory           6,000
```
This system posts only the first. Revenue is recognised with no matching cost, and the inventory asset is never relieved.

**Accounting impact:** Gross profit is overstated by the full cost of every unit sold — the P&L shows 10,000 gross profit on a sale that earned 4,000. Inventory on the balance sheet is overstated by everything ever sold, growing without bound. The company overstates both profit and assets, files an overstated tax return, and the balance sheet becomes progressively more wrong with every sale. The matching principle is not partially implemented here; it is absent.

The Retail and Restaurant COA templates make this materially worse by presenting Inventory and COGS accounts, implying the capability exists.

**Current implementation:** Accounts only. The P&L will display a Cost of Sales section that is permanently zero unless someone posts manual entries — and there is no manual journal entry UI either (see below).

**Expected behaviour:** Either build the inventory subledger (item master, perpetual movements, weighted-average or FIFO costing, automatic COGS on sale, adjustments/write-offs with correct postings, inventory valuation report), or remove inventory accounts from the templates and state plainly that the product does not support inventory.

**Recommended solution:** Given the "general-purpose commercial product" framing, build it — perpetual with weighted average as the default (simpler to reason about than FIFO layers and adequate for most SMBs), with the costing method configurable per company. Until then, remove Inventory/COGS from the shipped templates so no client believes they are covered.

**Affected files:** [coa-templates.ts:378-430](src/server/services/coa-templates.ts#L378-L430), [document-service.ts:348-359](src/server/services/document-service.ts#L348-L359), new schema required

**Priority:** P0 (build) / P0 (remove the misleading templates immediately either way)

---

### [CRITICAL] No manual journal entry UI — the accountant's primary tool is missing

**Problem:** `createJournalEntry` is complete and correct in the service layer, but no route or server action exposes it. [src/app/(app)/journal/](src/app/(app)/journal/) contains only `page.tsx` (list) and `[id]/page.tsx` (detail). The only server actions in the app are logout, company switch, and the four document actions.

**Why it matters:** Accruals, prepayment amortisation, depreciation, payroll journals, opening balances, corrections, reclassifications and every year-end adjustment are manual journal entries. An accountant cannot close a month without them. There is also no UI to post owner capital contributions or withdrawals — Scenarios H and I from the brief have no execution path at all.

**Accounting impact:** Month-end and year-end close are impossible through the interface. The system can record operational transactions but cannot produce period-correct financial statements, because every adjusting entry that converts cash-basis activity into accrual-basis statements has no way in.

**Current implementation:** Service ready; no UI, no server action.

**Expected behaviour:** A journal entry form with dynamic lines, live debit/credit totals, a running out-of-balance indicator, account picker excluding control and non-postable accounts, save-as-draft and post actions, plus a reverse action on the detail screen.

**Recommended solution:** Build the form against the existing service — the hard part is done and correct. Add a "Drawings" account to the COA templates while there (see Major Findings).

**Affected files:** [src/app/(app)/journal/](src/app/(app)/journal/), new `actions.ts` required

**Priority:** P0

---

## Major Findings

### [MAJOR] AR/AP aging report is wrong for any date other than today

**Problem:** `getAgingReport` ([contact-service.ts:378](src/server/services/contact-service.ts#L378)) accepts an `asOf` parameter and uses it *only* to compute bucket boundaries (`asOf::date - dueDate::date`). The amount summed in every bucket is `documents.balanceDue` — the document's **current** balance, as of now.

**Why it matters:** Running "AR Aging as at 30 June" in August does not produce June's aging. Every invoice paid in July shows a zero balance and vanishes from the report; invoices raised in July appear in it. The report silently blends June's bucket arithmetic with August's balances.

**Accounting impact:** A prior-period aging cannot be tied to that period's AR control account balance, which is precisely the reconciliation the report exists to support. Bad-debt provisioning based on a historical aging would be computed from the wrong population. An auditor requesting the year-end aging would receive a document that reconciles to nothing.

**Current implementation:** Bucket dates historical, amounts current.

**Expected behaviour:** Balance as at `asOf` = document total (where `issueDate <= asOf`) less allocations applied on or before `asOf`. Requires joining `payment_allocations` to `payments` and filtering on `paymentDate <= asOf`, rather than reading the stored `balanceDue`. Documents issued after `asOf` must be excluded — they currently are not, which is a second defect in the same query.

**Recommended solution:** Rewrite as a point-in-time query against allocations. The same fix resolves `getContactBalance` and `getContactStatement`, which share the assumption. Note this is the one place the "never store a balance" principle was violated (`balanceDue` is stored, per the schema comment "so aging queries need no per-row subquery") — and it is exactly where correctness broke.

**Affected files:** [contact-service.ts:378-409](src/server/services/contact-service.ts#L378-L409), [contact-service.ts:199-228](src/server/services/contact-service.ts#L199-L228)

**Priority:** P1

---

### [MAJOR] No year-end close; retained earnings never posted

**Problem:** There is a `retained_earnings` account role ([coa-templates.ts:190](src/server/services/coa-templates.ts#L190)) and `period-service.ts` can close and lock periods, but no routine closes a fiscal year. Nothing zeroes revenue and expense accounts or transfers the result to retained earnings.

The balance sheet compensates by computing `accumulatedProfit` from all revenue less all expenses since inception ([report-service.ts:210](src/server/services/report-service.ts#L210)) and adding it to equity. This keeps the sheet balanced — genuinely good defensive design — but it is a reporting workaround, not a close.

**Why it matters:** Two consequences. First, if anyone ever *does* post a closing entry manually, the balance sheet will double-count it: once in the retained earnings account balance and again in the recomputed `accumulatedProfit`. The report has no notion of "already closed." Second, the P&L for the current year cannot be distinguished from prior years in the equity section — there is no "current year earnings" versus "retained earnings" split, which every set of statutory accounts requires.

**Accounting impact:** No statutory year-end. Retained earnings on the balance sheet is a computed figure that never appears in the ledger, so the equity section cannot be tied to any journal entry. Comparative statements across a year boundary will not agree with prior filings.

**Expected behaviour:** A `closeFiscalYear` routine posting one entry per year-end: debit each revenue account its balance, credit each expense account its balance, and the net to retained earnings. Then lock the year's periods. The balance sheet must compute `accumulatedProfit` only from movements *after* the last closed year-end.

**Recommended solution:** Implement `closeFiscalYear` in `period-service.ts` using `createJournalEntry` with `sourceType: 'year_end_close'`, and add a `lastClosedDate` on the company so the balance sheet knows where to start accumulating. Guard against double-closing.

**Affected files:** [period-service.ts](src/server/services/period-service.ts), [report-service.ts:193-238](src/server/services/report-service.ts#L193-L238)

**Priority:** P1

---

### [MAJOR] Posted documents cannot be corrected except by full void

**Problem:** There is no `updateDocument`. Once posted, the only remedy is `voidDocument`, which is refused outright if any payment has been applied ([document-service.ts:587](src/server/services/document-service.ts#L587)).

**Why it matters:** Immutability of the *ledger* is correct and I would not weaken it. But a partially-paid invoice with a typo in a line description, a wrong customer PO reference, or a misclassified revenue account has no correction path at all. The user must remove every allocation (breaking the payment's audit trail), void, re-key, and re-allocate.

**Accounting impact:** Practical rather than arithmetic, but it drives users to workarounds — most commonly leaving the error in place, or creating an unrelated credit note that does not link to the original. Non-financial field corrections should never require destroying a payment history.

**Expected behaviour:** Separate non-financial fields (reference, notes, terms, description) — editable post-posting with an audit entry — from financial fields (amounts, accounts, tax, dates), which require a credit note or reversal. Additionally, a proper credit-note-against-invoice link so a correction references what it corrects.

**Recommended solution:** Add `updateDocumentMetadata` for the safe field set with full before/after audit capture. Add `creditNoteAgainstDocumentId` to link credit notes to their original.

**Affected files:** [document-service.ts](src/server/services/document-service.ts), [documents.ts](src/db/schema/documents.ts)

**Priority:** P1

---

### [MAJOR] No fixed asset register or depreciation

**Problem:** `fixed_asset`, `accumulated_depreciation` and `depreciation_expense` subtypes exist and the templates create the accounts. There is no asset register, no useful-life or method configuration, and no depreciation posting.

**Why it matters:** Any company owning equipment must depreciate it. With no manual JE UI either (see above), there is currently no way to record depreciation at all.

**Accounting impact:** Fixed assets stay at cost indefinitely. Assets and profit are both overstated, growing every period. Disposals cannot compute gain or loss. This is a recurring monthly misstatement, not a one-off.

**Expected behaviour:** Asset register (cost, date, category, useful life, residual, method), a depreciation run posting `Dr Depreciation Expense / Cr Accumulated Depreciation` per period, and disposal handling that derecognises cost and accumulated depreciation and posts the gain or loss.

**Recommended solution:** Straight-line first (covers the large majority of SMB needs), reducing-balance second. Depends on the manual JE work landing first for the fallback path.

**Affected files:** New schema and service; [coa-templates.ts:105-120](src/server/services/coa-templates.ts#L105-L120)

**Priority:** P1

---

### [MAJOR] No tax return / VAT report

**Problem:** Tax is configured correctly (rate, inclusive/exclusive, per-tax accounts), calculated correctly by `line-calculator.ts`, and posted correctly to `sales_tax_payable` / `purchase_tax_receivable`. `summariseTaxes` groups tax by rate — and has no callers. There is no tax report screen.

**Why it matters:** Output tax less input tax for a period, broken down by rate, is the single report a business is legally obliged to produce. The data is all present and correctly posted; nothing assembles it.

**Accounting impact:** VAT/GST returns must be prepared by hand from the general ledger. The underlying postings are right, so this is missing output rather than wrong accounting — but it is a compliance blocker.

**Expected behaviour:** A tax report for a date range: output tax by rate with taxable base, input tax by rate with base, net payable/reclaimable, tying to the tax account balances in the ledger.

**Recommended solution:** New `getTaxReport` in `report-service.ts` aggregating `document_lines` by `taxId` over the period, cross-checked against the tax control account balances so a discrepancy is visible rather than silent.

**Affected files:** [report-service.ts](src/server/services/report-service.ts), [line-calculator.ts:130](src/lib/line-calculator.ts#L130), new route

**Priority:** P1

---

### [MAJOR] No FX revaluation; realized and unrealized gains never posted

**Problem:** `fx_gain_loss` has an account role. Nothing writes to it. Foreign-currency documents convert at the issue-date rate and are never revalued. When a foreign invoice is settled at a different rate, the difference is not recognised.

**Why it matters:** A USD 10,000 invoice raised at 30.00 (base 300,000) settled at 31.00 (base 310,000) produces a 10,000 realized FX gain. The payment credits AR at the payment-date rate while the invoice debited it at the issue-date rate, so the AR control account retains a 10,000 residue that belongs in the P&L and will never clear.

**Accounting impact:** AR/AP control accounts accumulate FX residue that cannot be reconciled to any open document — the subledger will not tie to the ledger for any company transacting in foreign currency. Profit is misstated by the unrecognised gain or loss. Note the transfer service correctly *refuses* cross-currency transfers with a good error message, so the gap is recognised in one place but not handled in the settlement path.

**Expected behaviour:** On settlement, post the difference between the document-rate and payment-rate base amounts to FX gain/loss. At period end, revalue open foreign balances and post unrealized movement.

**Recommended solution:** Add realized FX recognition in `createPayment` where document and payment rates differ; add a period-end revaluation routine. Multi-currency is partially built — base/transaction amounts are stored separately on every line, which is the hard part — so this is completing the design, not adding to it.

**Affected files:** [payment-service.ts:146-182](src/server/services/payment-service.ts#L146-L182), [report-service.ts](src/server/services/report-service.ts)

**Priority:** P1 if multi-currency is sold; P2 otherwise

---

### [MAJOR] Overpayments, write-offs and refunds have no path

**Problem:** `applyAllocations` refuses any allocation exceeding `balanceDue` ([payment-service.ts:256](src/server/services/payment-service.ts#L256)). A payment may exceed its allocations, leaving `unappliedAmount` — but that residue posts entirely against the AR control account, not to a customer-advance liability. There is no bad-debt write-off and no refund.

**Why it matters:** A customer paying 10,500 against a 10,000 invoice is routine. The system accepts the 10,500 (crediting AR in full) and allows 10,000 to be allocated, leaving 500 unapplied sitting *in AR as a credit balance*.

**Accounting impact:** AR contains a net credit balance for overpaid customers — a liability presented as a negative asset. The balance sheet understates both current assets and current liabilities. Correctly, an unapplied receipt is `Cr Customer Advances` (liability), reclassified to AR when applied. Separately, uncollectible receivables have no write-off route, so AR is overstated by known bad debt with no provision mechanism.

**Expected behaviour:** Unapplied receipts to a customer-advance liability account (new `customer_advances` / `vendor_prepayments` roles). A write-off posting `Dr Bad Debt Expense / Cr AR` against a specific invoice. A refund as a disbursement against an unapplied receipt or credit note.

**Recommended solution:** Add the two account roles and route unapplied amounts there; add `writeOffDocument` and refund handling.

**Affected files:** [payment-service.ts:146-207](src/server/services/payment-service.ts#L146-L207), [coa-templates.ts](src/server/services/coa-templates.ts)

**Priority:** P1

---

### [MAJOR] Reconciliation records an unexplained difference and closes anyway

**Problem:** `completeReconciliation` ([banking-service.ts:449](src/server/services/banking-service.ts#L449)) computes `statementBalance - ledgerBalance`, stores it, and marks the reconciliation `completed` regardless of value.

**Why it matters:** Storing rather than hiding the difference is the right instinct, and the comment says so. But a reconciliation with a non-zero unexplained difference is by definition not reconciled. Marking it `completed` means the screen shows a green state over an unexplained cash discrepancy.

**Accounting impact:** The control purpose of reconciliation — proving ledger cash equals real cash — is defeated. A missing or duplicated transaction is recorded as a number in a column nobody is required to clear. Cash could be misstated indefinitely with every reconciliation marked complete.

**Expected behaviour:** A non-zero difference should force `status: 'discrepancy'`, not `completed`, and require either an explanation or an adjusting entry. Genuine timing differences (outstanding cheques, deposits in transit) should be modelled as such rather than lumped into one residual.

**Recommended solution:** Block `completed` on non-zero difference unless an explicit `adjustmentEntryId` or `explanation` is supplied. Add outstanding-item tracking.

**Affected files:** [banking-service.ts:449-493](src/server/services/banking-service.ts#L449-L493)

**Priority:** P1

---

### [MAJOR] Backdating is unrestricted wherever no period exists

**Problem:** `resolvePostingPeriod` ([journal-service.ts:155](src/server/services/journal-service.ts#L155)) returns `null` when no fiscal period covers the date, and posting proceeds. The comment states this deliberately: "a company that has not set up a fiscal calendar can still post."

**Why it matters:** Periods are only auto-generated for years someone explicitly creates via `createFiscalYear`. Any date outside those years — 1998, 2049 — has no period, so the lock cannot apply and the entry posts with `periodId: null`.

**Accounting impact:** A user can post into a prior year that was never given periods, changing prior-year comparatives after filing. Entries with `periodId: null` also escape any period-based close report. The control is sound where periods exist and absent where they do not — the worst kind of gap, because it looks enforced.

**Expected behaviour:** Configurable per company: reject postings outside any defined period (correct default for an established client), or auto-create the period. Additionally cap future-dating — nothing currently prevents an entry dated 2099.

**Recommended solution:** Add `requireOpenPeriod` (default true) and `maxFutureDays` to company settings. Fail closed rather than open.

**Affected files:** [journal-service.ts:155-183](src/server/services/journal-service.ts#L155-L183), [tenancy.ts](src/db/schema/tenancy.ts)

**Priority:** P1

---

### [MAJOR] Void reverses into the original period, not an open one

**Problem:** `voidDocument` calls `reverseJournalEntry` without a `reversalDate`, which defaults to `original.entryDate` ([journal-service.ts:480](src/server/services/journal-service.ts#L480)). If that period is closed, the void fails; if open, the reversal lands in the original period.

**Why it matters:** Voiding a June invoice in August should post the reversal in August. Posting it back into June changes June's already-reported revenue.

**Accounting impact:** Where June is open, a reported month silently changes and the previously issued P&L no longer reproduces. Where June is closed, the user simply cannot void and receives an error naming a period rather than an explanation.

**Expected behaviour:** Reversals default to the current date (or the earliest open period on/after it), never the original date, unless a user with period authority explicitly chooses otherwise.

**Recommended solution:** Pass `reversalDate: today` from `voidDocument` and `voidPayment`; make the same the default in `reverseJournalEntry`.

**Affected files:** [journal-service.ts:480](src/server/services/journal-service.ts#L480), [document-service.ts:594](src/server/services/document-service.ts#L594), [payment-service.ts:420](src/server/services/payment-service.ts#L420)

**Priority:** P1

---

### [MAJOR] Document status machine loses `sent` and can misreport paid documents

**Problem:** `determineStatus` ([document-service.ts:458](src/server/services/document-service.ts#L458)) returns `'approved'` for any non-draft, non-terminal document with no payments and no overdue date. A document previously marked `sent` reverts to `approved` on the next balance refresh. Separately, a fully-paid document whose due date has passed is checked for `paid` first — correct — but a *partially* paid overdue document returns `partially_paid`, hiding that it is overdue.

**Why it matters:** `listOpenDocuments`, the aging report and the dashboard all filter on status. A partially-paid overdue invoice is excluded from overdue reporting.

**Accounting impact:** Overdue AR is understated by every partially-paid overdue invoice — typically the ones most at risk of non-collection. Collections work from an incomplete list.

**Expected behaviour:** Overdue should be a derived flag orthogonal to payment status, not a mutually exclusive state. `sent` should be preserved.

**Recommended solution:** Add `isOverdue` as a computed column or view; keep `status` for the payment lifecycle only.

**Affected files:** [document-service.ts:458-476](src/server/services/document-service.ts#L458-L476)

**Priority:** P1

---

### [MAJOR] Owner's drawings account missing from templates

**Problem:** Templates include `3100 Owner's Capital` ([coa-templates.ts:183](src/server/services/coa-templates.ts#L183)) but no drawings/distributions account.

**Why it matters:** Scenario I (owner withdrawal) requires `Dr Owner's Drawings / Cr Bank`. With no drawings account, withdrawals get debited directly to capital, losing the distinction between invested capital and amounts taken out — or worse, get coded to an expense, understating profit.

**Accounting impact:** Equity cannot be broken into contributions versus distributions, which every partnership and sole-trader set of accounts requires. If miscoded to expense, profit is understated and the tax return is wrong.

**Recommended solution:** Add `3200 Owner's Drawings` (equity, contra) to the general templates.

**Affected files:** [coa-templates.ts:183-199](src/server/services/coa-templates.ts#L183-L199)

**Priority:** P1

---

## Missing Features

### Must Have

| Feature | Why a real business needs it |
|---|---|
| Approval enforcement wired into posting | The control clients believe they configured; currently decorative |
| Segregation of duties + self-approval block | Without it, one credential completes a cash fraud undetected |
| Manual journal entry UI | No accruals, depreciation, prepayments, corrections or close is possible |
| Inventory subledger with COGS | Retailers overstate profit and assets on every single sale |
| Year-end close to retained earnings | No statutory year-end; equity untraceable to any entry |
| Tax/VAT return report | Legally required filing; data exists but nothing assembles it |
| Point-in-time aging | Prior-period AR cannot be reconciled or provisioned against |
| Fixed assets + depreciation | Monthly recurring misstatement of assets and profit |
| Customer advances for overpayments | Overpayments sit in AR as negative assets |
| Bad debt write-off | AR permanently overstated by known uncollectibles |
| Reconciliation discrepancy blocking | Green checkmark over unexplained cash difference |

### Should Have

Credit notes linked to their original invoice · recurring invoices and expenses · prepaid/accrued expense schedules with amortisation · FX realized/unrealized recognition · statement-of-changes-in-equity · trial balance with opening/movement/closing columns · comparative-period reports · CSV/PDF export (`reports.export` permission exists and nothing implements it) · attachment upload (column exists, no pipeline) · invoice PDF rendering (modelled, not rendered) · numbering-gap report · audit log filtering by actor/date/entity · purchase orders converting to bills · duplicate-invoice detection on vendor reference

### Nice to Have

Multi-line document-level discounts · customer credit limit enforcement (field exists, unenforced) · project/job costing (dimension exists on journal lines, no reporting) · budget vs actual by period rather than range · dashboard cash-flow forecast · email delivery of statements · bank feed import beyond manual CSV · cost centres

### Future / Advanced

Consolidation across companies · intercompany elimination · IFRS 16 leases · revenue recognition schedules (IFRS 15/ASC 606) · deferred tax · payroll subledger · multi-warehouse inventory with transfers · manufacturing BOM and WIP · XBRL/statutory e-filing · immutable audit log with hash chaining · SOX-style control attestation workflows

---

## Accounting Workflow Problems

**Invoice lifecycle.** `draft → approved (posted) → sent → partially_paid/paid` works and is atomic. But `pending_approval` is a valid status the posting path never produces, `postDocument` conflates approve-and-post into one irreversible action, and `sent` is lost on any balance refresh. There is no way to un-approve back to draft.

**Expense lifecycle.** The best-modelled workflow: `draft → pending_approval → approved (posted)`, with `submitExpense` genuinely separate from `approveExpense`, and `approveExpense` correctly crediting AP when no payment account is given so the employee liability reaches the ledger. It still permits self-approval, and the tax calculation is the float defect above.

**Payment lifecycle.** Correct and atomic — allocation, ledger entry and balance refresh in one transaction, with `FOR UPDATE` on the document so concurrent payments cannot both consume the same balance. Payments are created directly as `posted`; there is no draft or approval stage for outbound money, which is the transaction type most warranting one.

**Period close.** `setPeriodStatus` and `getPeriodReadiness` are correct — readiness reports unposted drafts before closing. But close does not require readiness, nothing prevents closing a period with unposted drafts in it, and there is no month-end checklist. Year-end close is absent entirely.

**Reconciliation.** Import, match, unmatch and complete all work, and matching correctly leaves the ledger untouched. Completion does not require a zero difference.

---

## Double-Entry Accounting Audit

| Transaction | Debit | Credit | Current Status | Problem |
|---|---|---|---|---|
| Credit sale (invoice) | AR | Revenue + Tax Payable | ✅ Correct | Tax aggregated per document, correct |
| Cash sale | Bank | Revenue + Tax | ⚠️ Two steps | No single cash-sale action; invoice then payment |
| COGS on sale | COGS | Inventory | ❌ **Missing** | Not posted at all — profit and assets overstated |
| Customer receipt | Bank | AR | ✅ Correct | Atomic with allocation |
| Partial receipt | Bank | AR | ✅ Correct | Allocation capped at balance correctly |
| Overpayment | Bank | AR *(should be Advances)* | ⚠️ Wrong account | Credit balance sits in AR as negative asset |
| Credit note (sales) | Revenue + Tax | AR | ✅ Correct | Sign flip via `controlOnDebit`; no link to original |
| Bad debt write-off | Bad Debt Expense | AR | ❌ **Missing** | AR overstated by known uncollectibles |
| Customer refund | AR/Advances | Bank | ❌ **Missing** | No path |
| Purchase on credit (bill) | Expense/Asset + Input Tax | AP | ✅ Correct | Mirror of invoice, correct |
| Inventory purchase | Inventory | AP | ⚠️ Account only | Posts to the account; no quantity or valuation tracked |
| Supplier payment | AP | Bank | ✅ Correct | |
| Supplier credit (debit note) | AP | Expense + Tax | ✅ Correct | |
| Expense paid from bank | Expense + Input Tax | Bank | ✅ Correct | Tax amount computed with floats |
| Reimbursable expense | Expense + Input Tax | AP | ✅ Correct | Good — liability reaches the ledger |
| Bank transfer | Destination | Source | ✅ Correct | Cross-currency correctly refused |
| Bank fee | Expense | Bank | ⚠️ Manual only | No UI to post it |
| Owner investment | Bank | Owner's Capital | ⚠️ No UI | Service could; no manual JE screen |
| Owner withdrawal | Drawings | Bank | ❌ **Missing** | No drawings account and no UI |
| Depreciation | Depreciation Expense | Accumulated Depreciation | ❌ **Missing** | No engine, no UI fallback |
| Accrual / prepayment | Expense/Asset | Accrued/Prepaid | ❌ **Missing** | No manual JE UI |
| FX gain/loss on settlement | AR/AP | FX Gain/Loss | ❌ **Missing** | Role exists, never written; AR residue |
| Year-end close | Revenue | Expenses + Retained Earnings | ❌ **Missing** | Balance sheet computes around it |
| Reversal of any entry | Mirror image | Mirror image | ✅ Correct | Exemplary — linked both ways, reason required |

---

## Financial Reports Audit

| Report | Exists | Correct | Problems | Required Changes |
|---|:-:|:-:|---|---|
| Trial Balance | ✅ | ✅ | No opening/movement/closing columns | Add three-column layout |
| Balance Sheet | ✅ | ⚠️ | Will double-count if a close entry is ever posted; no current-year/prior-year equity split | Make close-aware |
| Profit & Loss | ✅ | ⚠️ | Arithmetic correct; Cost of Sales permanently zero without COGS | Depends on inventory |
| General Ledger | ✅ | ✅ | Opening balance and running balance both correct | 500-row cap needs pagination |
| Cash Flow | ✅ | ⚠️ | Approximated from counterpart account; no working-capital adjustments (documented honestly) | Proper indirect method |
| AR Aging | ✅ | ❌ | `asOf` affects buckets but not amounts; post-`asOf` documents included | Point-in-time rewrite |
| AP Aging | ✅ | ❌ | Same defect | Same |
| Customer Statement | ✅ | ⚠️ | Uses payment total, not amounts allocated to this contact's documents | Base on allocations |
| Vendor Statement | ✅ | ⚠️ | Same | Same |
| Budget vs Actual | ✅ | ⚠️ | `variancePercent` computed with floats (display only) | Use exact division |
| Dashboard | ✅ | ✅ | Same ledger source as reports — genuinely consistent | Ignores branch scope in overdue queries |
| Tax Report | ❌ | — | Absent; `summariseTaxes` unused | Build |
| Inventory Valuation | ❌ | — | Absent | Depends on inventory |
| Fixed Asset Register | ❌ | — | Absent | Depends on fixed assets |
| Statement of Changes in Equity | ❌ | — | Absent | Build after year-end close |

**Report consistency:** verified good. Every report and the dashboard derive from `journal_lines` through `getAccountBalances`, with `postedEntryFilter()` applied consistently — and `LEDGER_STATUSES` correctly includes `reversed`, since a reversed entry's original lines must still count (excluding them would leave only the reversal side and misstate balances by the full amount). This is the single strongest design decision in the system: there is genuinely one source of truth. The exceptions are the document-derived reports (aging, statements, dashboard overdue counts) which read stored `balanceDue` — and that is precisely where the correctness defects are.

---

## Internal Controls Audit

**Approval controls — INADEQUATE.** Engine complete, never invoked. Single permission check gates unlimited posting. No self-approval restriction.

**Posting controls — PARTIAL.** `transactions.post` correctly separated from `transactions.create`, and the `bookkeeper` template correctly withholds it. But `invoices.approve` allows posting invoices of any amount, bypassing `transactions.post` entirely, so the separation is undermined by the document path.

**Editing controls — STRONG.** Posted entries cannot be edited; enforced in the service and reinforced by `journal_entries_balanced_ck` in Postgres. Corrections require linked reversals. This is exactly right.

**Deletion controls — STRONG.** `deleteDraftEntry` refuses posted and reversed entries. Documents are voided, never deleted, preserving number sequences. Accounts are archived, not deleted, with FK `onDelete: 'restrict'` throughout as a database-level backstop.

**Period locks — GOOD WITH A GAP.** Three-state model (`open`/`closed`/`locked`) with `locked` permanently irreversible is correct and well judged. The gap: dates with no defined period bypass the check entirely.

**Audit trail — GOOD STRUCTURE, GAPS IN COVERAGE.** `recordAudit` captures actor, action, entity, before/after values, reason, IP and user agent, and is called inside the same transaction as the change it records — so an audit row cannot survive a rolled-back mutation, nor vice versa. That is the correct design. Gaps: `unmatchBankTransaction` and `deleteWorkflow` write no audit row; there is no UI to filter the log by actor or date; and the log is mutable by anyone with database access (no hash chaining or append-only enforcement).

**Segregation of duties — ABSENT.** Covered above. The default `accountant` role holds every conflicting permission simultaneously.

**Tenant isolation — EXEMPLARY.** Composite foreign keys `(id, company_id)` carry the tenant into every journal line reference, so cross-tenant contamination is rejected by Postgres even from a hand-written `INSERT`. `TenantContext` is resolved from a membership row in the database rather than from the request, so a caller cannot assert a company it has no membership in. Integration tests confirm company A cannot read or post against company B. This is the strongest part of the system.

---

## Database & Data Integrity Audit

**Strengths — genuinely above commercial norm:**

- Money is `numeric(20,6)` universally. No float column anywhere in the schema. Values canonicalised at the column boundary so the database and application agree on representation, not merely on value.
- `journal_lines_one_side_ck` makes the both-sides-filled mistake structurally impossible.
- `journal_entries_balanced_ck` enforces `totalDebit = totalCredit` on posted entries in Postgres.
- `payments_allocation_within_amount_ck` and `payment_allocations_positive_ck` prevent over-allocation at the storage layer.
- `documents_amount_paid_ck` (`amountPaid <= total + 0.000001`) — the epsilon is a rounding tolerance at the sixth decimal, appropriate for `numeric(20,6)`.
- `payment_allocations_unique_key` on `(paymentId, documentId)` prevents duplicate allocation rows.
- Partial unique index on `(companyId, role)` where role is not null — correct handling of the sparse-role case.
- `onDelete: 'restrict'` on every financial FK: an account or company with posted history cannot be deleted.
- Interactive transactions via the Neon WebSocket pool driver (not the HTTP driver) — a deliberate choice, correctly justified, since posting spans header, lines and assertion.
- `FOR UPDATE` row locks on documents and payments during allocation prevent the concurrent double-allocation race.
- Indexes match the actual query patterns: `(companyId, entryDate, status)` for reports, `(companyId, accountId)` for ledger rollups.

**Weaknesses:**

- `documents.balanceDue` is stored and maintained by `refreshDocumentBalance` — the one violation of the system's own "never store a balance" rule, and the source of the aging defects. The schema comment justifies it as a query optimisation; it bought a correctness bug.
- `journal_lines.customerId`, `vendorId` and `projectId` have no foreign keys at all, tenant-carrying or otherwise. A line can reference a nonexistent or cross-tenant contact. Given how rigorous the composite FKs are elsewhere, this looks like an oversight rather than a decision.
- No check that `documents.total = subtotal - discountTotal + taxTotal`. Application-computed only; a service bug could store internally inconsistent totals.
- `journal_entries.periodId` is nullable, so entries can exist outside any period.
- `document_lines_qty_ck` enforces `quantity <> 0` but allows negative quantities, whose interaction with discount clamping is untested.
- No advisory lock or unique-per-period guard against posting two year-end closes.
- `updatedAt` is maintained by the application rather than a trigger, so a direct SQL update leaves it stale.

**Atomicity — verified correct.** Every composite operation is wrapped in a single transaction: `createDocument` (document + lines + audit); `postDocument` (journal entry + lines + document update + audit); `createPayment` (payment + allocations + journal entry + balance refresh + audit); `voidPayment` (allocation deletion + reversal + status + refreshes + audit). Services accept an optional `tx` so a caller composing several operations keeps one boundary. The invoice-succeeds-but-journal-entry-fails scenario from the brief cannot occur — `createJournalEntry` runs inside the caller's transaction and any failure rolls back the document with it. I found no partial-failure path.

---

## Edge Cases

| Case | Behaviour | Assessment |
|---|---|---|
| Zero-value document | Rejected at post: "a zero total cannot be posted" | ✅ Correct |
| Negative line amount | Rejected by `validateLines` with guidance to use the other side | ✅ Correct |
| Negative quantity | Allowed by `document_lines_qty_ck` | ⚠️ Untested with discount clamping |
| Zero quantity | Rejected by check constraint | ✅ Correct |
| Very large amounts | `numeric(20,6)` → 14 integer digits; BigInt has no overflow | ✅ Correct |
| Decimal rounding | BigInt half-away-from-zero; `allocate` distributes remainders to largest weights so parts sum exactly | ✅ Exemplary |
| Unbalanced entry | Rejected in service *and* by Postgres check | ✅ Defence in depth |
| Entry with one line | Rejected (minimum two) | ✅ Correct |
| Line with neither side | Rejected in service and by `journal_lines_one_side_ck` | ✅ Correct |
| Both debit and credit | Same | ✅ Correct |
| Post twice | `journalEntryId` presence check + `FOR UPDATE` | ✅ Correct |
| Reverse twice | `reversedByEntryId` checked first, with a message naming the actual cause | ✅ Correct |
| Reverse a draft | Rejected | ✅ Correct |
| Delete posted entry | Rejected with instruction to reverse | ✅ Correct |
| Post to archived account | Rejected by name and code | ✅ Correct |
| Post to summary account | Rejected: "post to one of its children" | ✅ Correct |
| Hand-post to AR/AP control | Rejected unless from the subledger | ✅ Excellent — protects subledger agreement |
| Cross-tenant account on a line | Rejected by composite FK in Postgres | ✅ Exemplary |
| Closed-period posting | Rejected naming the period and status | ✅ Correct |
| Posting to a date with no period | **Allowed** | ❌ Control gap |
| Future-dated entry | **Allowed with no limit** | ❌ No cap |
| Concurrent payments on one invoice | `FOR UPDATE` serialises; second sees updated balance | ✅ Correct |
| Over-allocate a payment | Rejected in service and by check constraint | ✅ Correct |
| Allocate to unposted document | Rejected | ✅ Correct |
| Allocate to void document | Rejected | ✅ Correct |
| Receipt allocated to a bill | Rejected on direction mismatch | ✅ Correct |
| Overpayment | Accepted; residue left in AR | ❌ Wrong account |
| Void document with payments | Rejected pending allocation removal | ✅ Correct |
| Archive contact with balance | Rejected with amount and document count | ✅ Correct |
| Malformed UUID in URL | Treated as not-found rather than a 500 | ✅ Good |
| Missing exchange rate | Rejected with instructions | ✅ Good |
| Inverse exchange rate | Computed with float division | ❌ Precision loss |
| Missing AR/AP role account | `resolveAccountByRole` throws | ✅ Fails closed |
| Transfer to same account | Rejected | ✅ Correct |
| Cross-currency transfer | Rejected with an explanation of what to do instead | ✅ Good judgement |
| Tax-inclusive rounding | Tax derived by subtraction so base + tax equals the shown price exactly | ✅ Exemplary |
| Discount exceeding line total | Clamped to the line | ⚠️ Clamp uses `Number()` comparison |

---

## Recommended Accounting Architecture

The existing architecture is sound and should be preserved, not redesigned. Its core decisions are correct:

1. **GL as sole source of truth**, with every report aggregating `journal_lines` at query time.
2. **Source documents describe intent; journal entries record effect.** The `sourceType`/`sourceId` linkage makes drill-down possible without duplicating balances.
3. **Invariants in the database**, so a bug in a service cannot corrupt the ledger.
4. **Money as decimal strings on BigInt**, never a float.
5. **Accounts resolved by role, not by hardcoded code**, so a client can renumber their chart without breaking posting.
6. **Configuration over code** — taxes, numbering, workflows, roles, COA templates, custom fields are all data.

Four changes I would require to complete it:

**Introduce a posting gateway.** Every service currently calls `createJournalEntry` directly with `allowControlAccounts: true`, so each one independently decides whether it may touch AR/AP. A single `postingGateway` module owning approval enforcement, period validation, self-approval checks and control-account authorisation would make it structurally impossible to add a new financial service that bypasses controls — which is exactly how the workflow engine came to be bypassed.

**Add a subledger abstraction.** AR, AP, inventory and fixed assets share one shape: a subledger maintaining detail that must always tie to a GL control account. A common interface with a mandatory `reconcileToControlAccount()` would give each subledger a tie-out proof, and would have surfaced the FX residue and overpayment problems as failing reconciliations rather than as silent drift.

**Never store a derived balance.** `documents.balanceDue` is the one exception the system made to its own rule, and it produced the aging defects. Replace it with a view or computed point-in-time query.

**Make the audit log append-only.** Revoke UPDATE and DELETE at the database role level and hash-chain each row against its predecessor. An audit trail that the audited party can rewrite is not evidence.

---

## Recommended Roadmap

### Phase 1 — Critical Accounting Corrections

| Item | Why | Dependencies | Complexity | Modules |
|---|---|---|---|---|
| Wire approvals into posting | The control clients believe exists | None | M | document, expense, workflow |
| Block self-approval | Closes the single-credential fraud path | None | S | context, document, expense |
| Ship segregated role templates | Default config should not violate SoD | None | S | permissions |
| Fix expense tax floats | Misstates recoverable input VAT | None | S | expense, line-calculator |
| Fix inverse FX floats | Systematic rate error on all conversions | None | S | currency |
| Manual journal entry UI | Close is impossible without it | None | M | app/journal |
| Add Drawings account | Owner withdrawals otherwise miscoded | None | S | coa-templates |
| Reject postings outside periods; cap future dates | Backdating gap that looks enforced | None | S | journal, tenancy |
| Reversals into open periods | Stops reported months changing | None | S | journal, document, payment |
| Block reconciliation on non-zero difference | Green checkmark over unexplained cash gap | None | S | banking |
| Remove inventory accounts from templates | Stop implying unsupported capability | None | S | coa-templates |

### Phase 2 — Core Accounting Completeness

| Item | Why | Dependencies | Complexity | Modules |
|---|---|---|---|---|
| Point-in-time aging and statements | Prior-period AR must reconcile | None | M | contact, report |
| Year-end close + close-aware balance sheet | No statutory year-end otherwise | Manual JE | M | period, report |
| Tax/VAT return report | Legally required filing | None | M | report |
| Customer advances / vendor prepayments | Overpayments out of AR | None | M | payment, coa-templates |
| Bad debt write-off | AR overstated by uncollectibles | None | S | document |
| Refunds | Common and currently impossible | Advances | M | payment |
| Credit notes linked to originals | Corrections must reference what they correct | None | S | document, schema |
| Overdue as derived flag | Partially-paid overdue AR is invisible | None | S | document, report |
| Non-financial metadata edit | Typos should not require voiding | None | S | document |
| FK constraints on line dimensions | Lines can reference nonexistent contacts | None | S | ledger schema |
| Append-only audit log | Audit trail must not be rewritable | None | M | audit, DB roles |

### Phase 3 — Professional Accounting Features

| Item | Why | Dependencies | Complexity | Modules |
|---|---|---|---|---|
| Inventory subledger + COGS | Retailers overstate profit and assets on every sale | Posting gateway | **L** | new inventory module, document, report |
| Fixed assets + depreciation | Recurring monthly misstatement | Manual JE | L | new asset module |
| FX realized/unrealized | AR/AP residue that never clears | None | M | payment, report |
| Prepaid/accrued schedules | Accrual basis requires them | Manual JE | M | new module |
| Recurring documents | High-volume manual re-keying | None | M | document |
| Export (CSV/PDF) | `reports.export` exists and does nothing | None | M | report, app |
| Invoice PDF rendering | Modelled but not rendered | None | M | new render pipeline |
| Comparative + 3-column reports | Every statutory statement needs them | Year-end close | M | report |
| Posting gateway refactor | Prevents the next bypassed control | Phase 1 | M | all services |
| Attachment upload | Column exists, no pipeline | None | M | documents, app |

### Phase 4 — Advanced / Enterprise

Multi-company consolidation with intercompany elimination · project/job costing reports on the existing dimension · IFRS 15 revenue recognition schedules · IFRS 16 leases · deferred tax · payroll subledger · multi-warehouse inventory · manufacturing BOM/WIP · bank feed integration · statutory e-filing · hash-chained audit with control attestation.

---

## If I Were the Senior Accountant Responsible for This System

**These are the exact things I would require to be fixed before allowing a real company to use it:**

1. **Wire the approval workflow into `postDocument` and `approveExpense`.** I will not sign off on a system that displays configured approval thresholds it does not enforce. Add the integration test that would have caught this.
2. **Block self-approval and ship role templates that segregate duties.** As delivered, one person with the default `accountant` role can create a vendor, bill it, approve it, pay it, and reconcile the payment. I need that path closed before any credentials are issued.
3. **Remove the float arithmetic from expense tax and inverse FX rates.** The system's own documentation explains why this is unacceptable; two functions ignore it. Both are on the posting path.
4. **Either build the inventory subledger with COGS, or remove inventory accounts from the COA templates.** I will not put a stock-holding business on books that recognise revenue with no cost of sale — profit and assets would be overstated on every transaction. If inventory is out of scope, the templates must stop advertising it.
5. **Build the manual journal entry screen.** Without it I cannot post an accrual, a prepayment, depreciation, or any adjusting entry, which means I cannot close a month or produce accrual-basis statements.
6. **Implement year-end close to retained earnings, and make the balance sheet close-aware.** Equity currently cannot be traced to any journal entry, and the sheet will double-count the moment a closing entry is posted.
7. **Fix the aging report to be genuinely point-in-time.** A year-end AR aging that reconciles to nothing is worse than no report, and bad-debt provisions computed from it would be wrong.
8. **Close the period-lock gap: reject postings to dates with no defined period, and cap future-dating.** A lock that silently does not apply outside configured years is not a lock.
9. **Route unapplied receipts to a customer advances liability, and add bad debt write-off.** Overpayments must not sit in AR as negative assets, and known uncollectibles must be provided for.
10. **Stop reconciliations from completing with an unexplained difference.** A completed reconciliation must mean the ledger agrees with the bank.
11. **Build the tax return report.** I cannot file from a general ledger by hand every quarter, and the data is already posted correctly.
12. **Make the audit log append-only.** An audit trail the audited party can edit is not evidence of anything.

Items 1–5 are absolute blockers. Items 6–9 must land before the first period close. Items 10–12 before the first external audit or tax filing.

I want to be clear about what this list is not: it is not a rejection of the architecture. The ledger design, the database-enforced invariants, the BigInt money arithmetic, the tenant isolation via composite foreign keys, the immutable-history-with-linked-reversals model, and the discipline of deriving every report from `journal_lines` are all correct, and several are better than what I have seen in shipping commercial products. The engine is trustworthy. What surrounds it is not yet finished, and two of the unfinished parts — unenforced approvals and absent segregation of duties — are exactly the ones a client would most confidently assume were working.

---

*Audit complete. No source code, schema, migrations or business logic were modified in producing this report.*
