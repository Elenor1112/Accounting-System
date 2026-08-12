# Build a Production-Ready Configurable Accounting Module

You are acting as a **Principal Software Architect, Senior Full-Stack Engineer, Accounting Systems Architect, Product Designer, and QA Engineer**.

We are building a **general-purpose accounting module that will be sold and deployed for multiple different clients and industries**.

This is NOT an Elenor-specific accounting system.

The final product must be a **reusable, configurable, multi-tenant accounting platform** where the accounting engine remains universal while each client/company can customize configuration, workflows, fields, permissions, branding, taxes, currencies, chart of accounts, document templates, branches, and optional business modules.

The system must be production-ready.

Do not build mocks, fake functionality, placeholder buttons, static demo data, or UI-only features.

---




# 2. PRODUCT VISION

Build a product that can work for:

- Marketing agencies
- Construction companies
- Retail businesses
- Restaurants
- Consulting firms
- SaaS companies
- Professional services
- Manufacturing businesses
- Freelancers
- General SMEs

The accounting engine must remain industry-neutral.

Example:

A marketing agency may configure:

- Projects
- Clients
- Retainers
- Project profitability

A construction company may configure:

- Projects
- Contractors
- Purchase orders
- Materials
- Project costing

A retailer may configure:

- Products
- Inventory
- Suppliers
- POS

A restaurant may configure:

- Branches
- Suppliers
- Ingredients
- Daily sales
- Cost of goods

The underlying accounting system remains the same.

---

# 3. CORE ARCHITECTURAL PRINCIPLE

The **general ledger is the financial source of truth**.

Do NOT build the system around invoices, expenses, or UI forms.

Build the accounting engine around proper **double-entry bookkeeping**.

Every financial event must eventually produce balanced journal entries.

Example:

Customer pays 100,000 EGP:

Debit:
Bank                         100,000

Credit:
Accounts Receivable          100,000

The accounting engine must enforce:

TOTAL DEBITS = TOTAL CREDITS

No posted transaction can violate this rule.

---

# 4. CORE MODULE STRUCTURE

Create the following main areas:

Accounting
├── Dashboard
├── Sales
│   ├── Customers
│   ├── Quotes
│   ├── Invoices
│   ├── Credit Notes
│   └── Payments
├── Purchases
│   ├── Vendors
│   ├── Purchase Orders
│   ├── Bills
│   ├── Debit Notes
│   └── Payments
├── Expenses
│   ├── Expenses
│   ├── Expense Categories
│   └── Reimbursements
├── Banking
│   ├── Bank Accounts
│   ├── Cash Accounts
│   ├── Transfers
│   └── Reconciliation
├── Accounting
│   ├── Chart of Accounts
│   ├── Journal Entries
│   ├── General Ledger
│   ├── Trial Balance
│   └── Fiscal Periods
├── Taxes
│   ├── Tax Rates
│   ├── Tax Transactions
│   └── Tax Reports
├── Reports
│   ├── Profit & Loss
│   ├── Balance Sheet
│   ├── Cash Flow
│   ├── General Ledger
│   ├── Trial Balance
│   ├── AR Aging
│   ├── AP Aging
│   └── Budget vs Actual
├── Budgeting
│   ├── Budgets
│   └── Budget vs Actual
├── Contacts
│   ├── Customers
│   └── Vendors
└── Settings
    ├── Company
    ├── Branches
    ├── Fiscal Year
    ├── Currency
    ├── Taxes
    ├── Numbering
    ├── Document Templates
    ├── Approval Workflows
    ├── Custom Fields
    └── Permissions

Adapt this structure to the existing application's navigation and architecture.

---

# 5. MULTI-TENANCY

The module must support multiple organizations/companies.

Never allow financial data from one tenant/company to leak into another.

Every relevant accounting entity must be tenant-aware.

At minimum support:

Organization
→ Companies
→ Branches

A user may have access to:

- One organization
- Multiple companies
- Specific branches

All database queries must enforce tenant/company boundaries server-side.

Never rely on frontend filtering for security.

---

# 6. COMPANY CONFIGURATION

Each company must be configurable.

Support:

- Company name
- Legal name
- Logo
- Address
- Phone
- Email
- Tax/VAT identification
- Base currency
- Fiscal year
- Date format
- Number format
- Timezone
- Country
- Default tax settings
- Invoice numbering
- Bill numbering
- Journal numbering
- Payment numbering
- Branches

Do not hardcode country-specific accounting assumptions into the core.

---

# 7. CHART OF ACCOUNTS

Build a proper configurable Chart of Accounts.

Account types:

- Asset
- Liability
- Equity
- Revenue
- Expense

Support hierarchical accounts:

Example:

1000 Assets
├── 1100 Current Assets
│   ├── 1110 Cash
│   ├── 1120 Bank
│   └── 1130 Accounts Receivable
└── 1200 Fixed Assets

Users should be able to:

- Create account
- Edit account
- Archive account
- Create child account
- Assign account code
- Assign account type
- Set parent
- Add description
- Set default behavior where appropriate

Prevent deletion of accounts that are referenced by posted transactions.

Use archive/deactivation instead.

Provide configurable default chart-of-accounts templates.

Examples:

- General Business
- Retail
- Services
- Construction
- Restaurant

These are templates, not hardcoded business logic.

---

# 8. DOUBLE-ENTRY ACCOUNTING ENGINE

This is the most important component.

Create proper models for:

- JournalEntry
- JournalEntryLine
- Account
- AccountingPeriod
- Transaction

Journal entries must support:

- Entry number
- Date
- Description
- Reference
- Source type
- Source ID
- Currency
- Exchange rate
- Status
- Created by
- Approved by
- Posted by
- Created timestamp
- Posted timestamp

Journal lines must contain:

- Account
- Debit
- Credit
- Currency
- Exchange rate
- Base amount
- Description
- Customer/vendor/project/branch dimensions where applicable

Validation:

- Debit >= 0
- Credit >= 0
- A line cannot have both debit and credit
- A valid journal entry must have at least two lines
- Total debit must equal total credit
- Posted entries cannot be edited
- Posted entries cannot be deleted

Use database transactions to guarantee atomicity.

---

# 9. TRANSACTION LIFECYCLE

Support:

Draft
→ Pending Approval
→ Approved
→ Posted

Also:

Posted
→ Reversed

Do not allow users to silently mutate financial history.

If a posted transaction is wrong:

Create a reversal transaction.

Maintain a full audit trail.

---

# 10. INVOICES

Invoices must be generic.

Support:

- Customer
- Invoice number
- Issue date
- Due date
- Currency
- Exchange rate
- Line items
- Quantity
- Unit price
- Discount
- Tax
- Subtotal
- Total
- Amount paid
- Balance due
- Notes
- Terms
- Attachments
- Branch
- Optional project
- Optional custom fields

Statuses:

Draft
Sent
Partially Paid
Paid
Overdue
Cancelled

Invoice numbering must be configurable.

Example:

INV-{YYYY}-{####}

Do not hardcode numbering.

---

# 11. PAYMENTS

Support:

- Customer payments
- Vendor payments
- Expense payments
- Other receipts
- Other payments

Payment methods:

- Cash
- Bank transfer
- Card
- Cheque
- Online payment
- Custom methods

Payment must be linked to the correct accounting accounts.

Support:

- Full payment
- Partial payment
- Multiple invoice allocation
- Unapplied payments

---

# 12. ACCOUNTS RECEIVABLE

Create a complete AR system.

Support:

- Customer balances
- Outstanding invoices
- Overdue invoices
- Partial payments
- Aging

Aging:

- Current
- 1–30 days
- 31–60 days
- 61–90 days
- 90+ days

Customer statement:

Opening balance
+
Invoices
-
Payments
+
Adjustments
=
Closing balance

---

# 13. ACCOUNTS PAYABLE

Build the equivalent AP system.

Support:

- Vendors
- Bills
- Vendor balances
- Payments
- Partial payments
- Aging
- Vendor statements

---

# 14. EXPENSES

Create a generic expense system.

Expense fields:

- Employee/user
- Vendor
- Category
- Amount
- Currency
- Date
- Description
- Receipt
- Branch
- Project
- Custom fields

Lifecycle:

Draft
→ Submitted
→ Pending Approval
→ Approved
→ Paid
→ Posted

Do not automatically post an expense before approval if approval is required.

---

# 15. BANKING

Support:

- Bank accounts
- Cash accounts
- Account balances
- Deposits
- Withdrawals
- Transfers
- Bank transactions
- Reconciliation

Transfers must create proper accounting entries.

Example:

Bank A → Bank B

Debit:
Bank B

Credit:
Bank A

No fake balance manipulation.

---

# 16. BANK RECONCILIATION

Build a reconciliation interface where users can:

- See unreconciled transactions
- Match bank transactions
- Match payments
- Match deposits
- Create adjustment entries
- Mark transactions as reconciled
- See reconciliation history

Never alter the source transaction merely because it was reconciled.

---

# 17. TAX ENGINE

Do not hardcode one country's tax system.

Create configurable:

Tax
- Name
- Code
- Rate
- Type
- Inclusive/exclusive
- Active/inactive
- Effective date

Support multiple taxes where applicable.

The architecture should allow future country-specific tax modules.

---

# 18. MULTI-CURRENCY

Support:

- Company base currency
- Transaction currency
- Exchange rate
- Base currency amount
- Currency gain/loss

Never lose the original transaction currency.

Example:

Invoice:
USD 1,000

Base currency:
EGP equivalent at transaction rate

Store both.

Do not simply overwrite the original amount.

---

# 19. BRANCHES

Support multiple branches.

Transactions may optionally belong to:

- Company
- Branch

Allow reporting by:

- Entire company
- Branch
- Multiple branches

---

# 20. CUSTOM FIELDS

This is critical because the product must be sellable to different businesses.

Allow administrators to create custom fields for entities such as:

- Customers
- Vendors
- Invoices
- Bills
- Expenses
- Payments
- Projects
- Transactions

Field types:

- Text
- Number
- Currency
- Date
- Boolean
- Select
- Multi-select
- User
- Customer
- Vendor
- File

Do not modify the database schema every time a client creates a custom field.

Use a robust metadata/custom-field architecture.

---

# 21. CUSTOM WORKFLOWS

Create configurable workflow definitions.

Example:

Invoice:

Draft
→ Finance Review
→ Manager Approval
→ Sent
→ Paid

Another company:

Draft
→ Approved
→ Sent
→ Paid

Workflow engine should support:

- Statuses
- Transitions
- Required permissions
- Approval roles
- Amount thresholds
- Conditions
- Notifications

Example:

If invoice > 50,000:

Require Finance Manager approval.

If invoice > 250,000:

Require Management approval.

These rules must be configurable.

---

# 22. RBAC

Use the existing RBAC system if available.

Permissions should be granular.

Examples:

accounting.dashboard.view

accounting.accounts.view

accounting.accounts.manage

accounting.transactions.view

accounting.transactions.create

accounting.transactions.post

accounting.transactions.reverse

accounting.invoices.view

accounting.invoices.create

accounting.invoices.approve

accounting.invoices.send

accounting.payments.create

accounting.expenses.create

accounting.expenses.approve

accounting.reports.view

accounting.reports.export

accounting.settings.manage

Never trust frontend permissions.

Enforce permissions server-side.

---

# 23. AUDIT LOG

Every financially important action must be auditable.

Record:

- User
- Action
- Entity
- Entity ID
- Timestamp
- Previous value
- New value
- IP/device information if the existing system supports it
- Reason where required

Examples:

"User changed invoice amount"

"User approved expense"

"User posted journal entry"

"User reversed payment"

Financial records must have immutable history.

---

# 24. REPORTING ENGINE

Build reports from accounting data rather than duplicated balances.

Required reports:

### Profit & Loss

Revenue
-
Expenses
=
Net Profit

### Balance Sheet

Assets
=
Liabilities + Equity

### Trial Balance

Account
Debit
Credit
Balance

### General Ledger

Account activity over a date range.

### Cash Flow

Operating
Investing
Financing

### AR Aging

### AP Aging

### Budget vs Actual

Reports must support:

- Date range
- Company
- Branch
- Account
- Customer
- Vendor
- Currency where appropriate
- Export

---

# 25. BUDGETING

Support:

- Budgets
- Budget periods
- Account allocations
- Branch allocations
- Department/project dimensions if configured
- Actual vs budget
- Variance

Example:

Marketing budget:
100,000

Actual:
125,000

Variance:
+25,000

---

# 26. DOCUMENT TEMPLATES

Invoices, bills, receipts and statements should use configurable templates.

Support:

- Logo
- Company details
- Colors
- Fonts
- Footer
- Terms
- Custom fields
- Tax information
- Numbering

Do not hardcode one company's branding.

---

# 27. DASHBOARD

Create a professional accounting dashboard.

Widgets:

- Revenue
- Expenses
- Net profit
- Cash
- Accounts receivable
- Accounts payable
- Overdue invoices
- Upcoming bills
- Cash flow
- Revenue trend
- Expense trend
- Recent transactions
- Outstanding approvals

Everything must use real database data.

No fake numbers.

---

# 28. UI/UX

The UI should feel like a serious modern financial product.

Design inspiration:

- Linear
- Stripe Dashboard
- Ramp
- QuickBooks
- Xero
- modern enterprise SaaS

But do not copy their UI.

Prioritize:

- Information density
- Clear hierarchy
- Fast navigation
- Search
- Filtering
- Sorting
- Bulk actions
- Keyboard accessibility
- Responsive design
- Empty states
- Loading states
- Error states
- Confirmation states

Financial tables should be optimized for large datasets.

---

# 29. SEARCH

Global accounting search should support:

- Invoice number
- Customer
- Vendor
- Transaction
- Journal entry
- Payment
- Account
- Reference

Use server-side search.

---

# 30. PERFORMANCE

Assume a real client may eventually have:

- 100,000+ transactions
- 50,000+ invoices
- 10,000+ customers
- Multiple branches
- Multiple users

Do not load entire datasets into the frontend.

Use:

- Pagination
- Server-side filtering
- Server-side sorting
- Proper indexes
- Efficient queries
- Aggregation queries
- Database constraints

---

# 31. DATABASE DESIGN

Design the schema carefully before implementing.

At minimum consider models/entities for:

- Organization
- Company
- Branch
- User
- Role
- Permission
- Account
- AccountingPeriod
- JournalEntry
- JournalEntryLine
- Customer
- Vendor
- Invoice
- InvoiceLine
- Payment
- PaymentAllocation
- Bill
- BillLine
- Expense
- ExpenseCategory
- BankAccount
- BankTransaction
- Reconciliation
- Tax
- Currency
- ExchangeRate
- Budget
- BudgetLine
- Workflow
- WorkflowStep
- Approval
- CustomField
- CustomFieldValue
- DocumentTemplate
- AuditLog

Adapt this to the existing schema.

Do not blindly create duplicate entities.

---

# 32. DATA INTEGRITY

Use database constraints wherever possible.

Important invariants:

- Journal entries must balance.
- Posted journal entries cannot be edited.
- Posted journal entries cannot be deleted.
- Invoice totals must equal their lines.
- Payment allocations cannot exceed payment amount.
- Payment allocations cannot exceed invoice balance.
- Accounting periods can be locked.
- Locked periods cannot receive normal postings.
- Archived accounts cannot receive new transactions.
- Tenant boundaries must always be enforced.

---

# 33. ACCOUNTING PERIODS

Support:

- Fiscal years
- Accounting periods
- Open/closed status
- Period locking

Example:

January 2026 → Closed

No user should be able to accidentally post into January after closure.

Adjustments should use the correct controlled process.

---

# 34. REVERSALS

Never delete financial history.

Example:

Original:

Debit Expense 10,000
Credit Bank 10,000

Reversal:

Debit Bank 10,000
Credit Expense 10,000

Link the reversal to the original entry.

Show both in the audit trail.

---

# 35. API ARCHITECTURE

Build clean APIs/services around business logic.

Do not put accounting logic directly into React components.

Use service/domain layers where appropriate.

For example:

AccountingService
InvoiceService
PaymentService
ExpenseService
JournalService
ReconciliationService
ReportingService

All financial mutations must go through server-side services.

---

# 36. TESTING

Do not consider this feature complete without tests.

Write unit tests for:

- Debit/credit balancing
- Invoice calculations
- Tax calculations
- Discounts
- Partial payments
- Payment allocation
- AR balances
- AP balances
- Currency conversion
- Reversals
- Accounting periods
- Workflow approvals
- Permission checks
- Tenant isolation

Write integration tests for important accounting flows.

Example:

Create invoice
→ Post invoice
→ Record payment
→ Verify AR
→ Verify bank
→ Verify revenue
→ Verify journal entries
→ Verify reports

Also test:

Company A cannot access Company B financial data.

---

# 37. SEED DATA

Create development/demo seed data only where the application's architecture supports it.

Seed:

- Example company
- Example chart of accounts
- Customers
- Vendors
- Invoices
- Bills
- Expenses
- Payments
- Journal entries

Clearly separate seed/demo data from production data.

Never hardcode demo numbers into UI components.

---

# 38. EXTENSIBILITY

Design the module so future modules can connect to accounting.

For example:

Inventory:

Inventory Sale
→ Revenue + COGS + Inventory

Payroll:

Payroll
→ Salary Expense + Payroll Liability

POS:

POS Sale
→ Cash/Card + Revenue + Tax

Projects:

Project Invoice
→ AR + Revenue

Do not implement every industry module now.

Build the accounting engine so they can integrate later.

---

# 39. CONFIGURATION VS CUSTOM CODE

A major product requirement:

A new client should NOT require rewriting the accounting engine.

Whenever a requirement can reasonably be solved through configuration, make it configurable.

Examples:

- Currency
- Tax
- Account structure
- Invoice numbering
- Approval flow
- Roles
- Permissions
- Custom fields
- Document templates
- Branches
- Fiscal year

Avoid creating client-specific conditionals like:

if company === "ClientA"

This must NEVER become the architecture.

---

# 40. SECURITY

Treat this as financial software.

Implement:

- Server-side authorization
- Tenant isolation
- Input validation
- Database constraints
- Secure file uploads
- Audit logs
- Rate limiting where appropriate
- CSRF protection where relevant
- Secure API endpoints
- No sensitive financial data exposed unnecessarily
- No client-side-only authorization

---

# 41. IMPLEMENTATION PROCESS

Work in this order:

### Phase 1
Repository audit.

### Phase 2
Architecture and database design.

### Phase 3
Core accounting engine.

### Phase 4
Chart of accounts.

### Phase 5
Journal entries and ledger.

### Phase 6
Customers/vendors.

### Phase 7
Invoices and bills.

### Phase 8
Payments and expenses.

### Phase 9
Banking and reconciliation.

### Phase 10
Taxes and currencies.

### Phase 11
Reports.

### Phase 12
Customization engine.

### Phase 13
Workflow/approval engine.

### Phase 14
Dashboard.

### Phase 15
Audit/security hardening.

### Phase 16
Testing.

---

# 42. IMPORTANT DEVELOPMENT RULES

Do NOT:

- Create mock APIs.
- Create fake financial balances.
- Hardcode accounting numbers.
- Hardcode one country.
- Hardcode one industry.
- Hardcode one company's workflow.
- Hardcode permissions.
- Hardcode invoice numbering.
- Duplicate existing infrastructure.
- Modify unrelated application functionality.
- Delete existing functionality.
- Simplify accounting logic just to make UI easier.

Do:

- Reuse existing architecture.
- Keep accounting logic server-side.
- Use real database persistence.
- Use proper transactions.
- Use immutable posted financial records.
- Use configurable business rules.
- Keep tenant isolation strict.
- Keep the accounting core independent from industry-specific modules.

---

# 43. DEFINITION OF DONE

The module is NOT complete merely because the screens exist.

It is complete only when:

1. A company can be created.
2. A chart of accounts can be configured.
3. Users/roles can be configured.
4. Customers and vendors can be created.
5. An invoice can be created.
6. The invoice can be approved.
7. The invoice can be posted.
8. Posting creates correct journal entries.
9. A payment can be recorded.
10. Payment updates AR.
11. Payment creates correct journal entries.
12. Expenses can be submitted.
13. Expenses can be approved.
14. Expenses create correct accounting entries.
15. Bills work correctly.
16. AP works correctly.
17. Bank accounts work.
18. Transfers work.
19. Reconciliation works.
20. Taxes work through configuration.
21. Multi-currency architecture works.
22. Accounting periods can be locked.
23. Posted entries cannot be modified.
24. Reversals work.
25. Reports calculate from the ledger.
26. Custom fields work.
27. Workflows work.
28. Permissions work server-side.
29. Tenant isolation is tested.
30. Audit logs work.
31. No mock financial data remains.
32. Existing application functionality still works.

---

# 44. FINAL PRODUCT STANDARD

Do not think of this as:

"Add an accounting page."

Think of it as:

"Build a reusable financial infrastructure product that can be configured and deployed for different businesses."

The final architecture should allow us to sell the same accounting module to multiple clients while changing:

- Branding
- Company structure
- Chart of accounts
- Tax configuration
- Currency
- Branches
- Roles
- Permissions
- Approval workflows
- Custom fields
- Document templates
- Optional business modules

without rewriting the accounting engine.

Before writing code, inspect the existing project and produce a concise implementation plan and architecture map.

Then implement it incrementally.

After each major phase:

1. Run type checks.
2. Run linting.
3. Run relevant tests.
4. Check database migrations.
5. Verify existing functionality.
6. Fix regressions before proceeding.

Do not stop at the UI.

Build the actual accounting engine underneath it.