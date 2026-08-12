CREATE TYPE "public"."account_subtype" AS ENUM('cash', 'bank', 'accounts_receivable', 'inventory', 'other_current_asset', 'fixed_asset', 'accumulated_depreciation', 'other_asset', 'accounts_payable', 'credit_card', 'tax_payable', 'other_current_liability', 'long_term_liability', 'equity', 'retained_earnings', 'operating_revenue', 'other_income', 'cost_of_goods_sold', 'operating_expense', 'payroll_expense', 'depreciation_expense', 'other_expense');--> statement-breakpoint
CREATE TYPE "public"."account_type" AS ENUM('asset', 'liability', 'equity', 'revenue', 'expense');--> statement-breakpoint
CREATE TYPE "public"."document_status" AS ENUM('draft', 'pending_approval', 'approved', 'sent', 'partially_paid', 'paid', 'overdue', 'cancelled', 'void');--> statement-breakpoint
CREATE TYPE "public"."journal_status" AS ENUM('draft', 'pending_approval', 'approved', 'posted', 'reversed', 'void');--> statement-breakpoint
CREATE TABLE "branches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "companies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"legal_name" text,
	"slug" text NOT NULL,
	"logo_url" text,
	"email" text,
	"phone" text,
	"address_line1" text,
	"address_line2" text,
	"city" text,
	"state" text,
	"postal_code" text,
	"country_code" text,
	"tax_identifier" text,
	"base_currency_code" text DEFAULT 'USD' NOT NULL,
	"fiscal_year_start_month" integer DEFAULT 1 NOT NULL,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"date_format" text DEFAULT 'yyyy-MM-dd' NOT NULL,
	"currency_precision" integer DEFAULT 2 NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	"branch_ids" uuid[] DEFAULT '{}' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"permissions" text[] DEFAULT '{}' NOT NULL,
	"is_system" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"name" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"type" "account_type" NOT NULL,
	"subtype" "account_subtype" NOT NULL,
	"parent_id" uuid,
	"path" text NOT NULL,
	"depth" integer DEFAULT 0 NOT NULL,
	"is_control_account" boolean DEFAULT false NOT NULL,
	"is_postable" boolean DEFAULT true NOT NULL,
	"currency_code" text,
	"is_archived" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounts_id_company_key" UNIQUE("id","company_id")
);
--> statement-breakpoint
CREATE TABLE "fiscal_periods" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"fiscal_year" integer NOT NULL,
	"period_number" integer NOT NULL,
	"name" text NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"closed_at" timestamp with time zone,
	"closed_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fiscal_periods_id_company_key" UNIQUE("id","company_id"),
	CONSTRAINT "fiscal_periods_range_ck" CHECK ("fiscal_periods"."end_date" >= "fiscal_periods"."start_date")
);
--> statement-breakpoint
CREATE TABLE "journal_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"branch_id" uuid,
	"entry_number" text NOT NULL,
	"entry_date" date NOT NULL,
	"period_id" uuid,
	"description" text,
	"reference" text,
	"source_type" text DEFAULT 'manual' NOT NULL,
	"source_id" uuid,
	"currency_code" text NOT NULL,
	"exchange_rate" numeric(20, 10) DEFAULT '1' NOT NULL,
	"status" "journal_status" DEFAULT 'draft' NOT NULL,
	"total_debit" numeric(20, 6) DEFAULT '0' NOT NULL,
	"total_credit" numeric(20, 6) DEFAULT '0' NOT NULL,
	"reverses_entry_id" uuid,
	"reversed_by_entry_id" uuid,
	"created_by_id" uuid,
	"approved_by_id" uuid,
	"posted_by_id" uuid,
	"approved_at" timestamp with time zone,
	"posted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "journal_entries_id_company_key" UNIQUE("id","company_id"),
	CONSTRAINT "journal_entries_balanced_ck" CHECK ("journal_entries"."status" <> 'posted' OR "journal_entries"."total_debit" = "journal_entries"."total_credit"),
	CONSTRAINT "journal_entries_rate_positive_ck" CHECK ("journal_entries"."exchange_rate" > 0)
);
--> statement-breakpoint
CREATE TABLE "journal_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"entry_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"line_number" integer NOT NULL,
	"debit" numeric(20, 6) DEFAULT '0' NOT NULL,
	"credit" numeric(20, 6) DEFAULT '0' NOT NULL,
	"currency_code" text NOT NULL,
	"exchange_rate" numeric(20, 10) DEFAULT '1' NOT NULL,
	"base_debit" numeric(20, 6) DEFAULT '0' NOT NULL,
	"base_credit" numeric(20, 6) DEFAULT '0' NOT NULL,
	"description" text,
	"branch_id" uuid,
	"customer_id" uuid,
	"vendor_id" uuid,
	"project_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "journal_lines_debit_nonneg_ck" CHECK ("journal_lines"."debit" >= 0),
	CONSTRAINT "journal_lines_credit_nonneg_ck" CHECK ("journal_lines"."credit" >= 0),
	CONSTRAINT "journal_lines_one_side_ck" CHECK (("journal_lines"."debit" > 0 AND "journal_lines"."credit" = 0) OR ("journal_lines"."credit" > 0 AND "journal_lines"."debit" = 0))
);
--> statement-breakpoint
CREATE TABLE "contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"kind" text DEFAULT 'customer' NOT NULL,
	"code" text NOT NULL,
	"display_name" text NOT NULL,
	"legal_name" text,
	"email" text,
	"phone" text,
	"website" text,
	"tax_identifier" text,
	"billing_address" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"shipping_address" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"currency_code" text,
	"payment_terms_days" integer DEFAULT 30 NOT NULL,
	"credit_limit" numeric(20, 6),
	"receivable_account_id" uuid,
	"payable_account_id" uuid,
	"notes" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contacts_id_company_key" UNIQUE("id","company_id")
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid,
	"actor_id" uuid,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid,
	"previous_values" jsonb,
	"new_values" jsonb,
	"reason" text,
	"ip_address" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "branches" ADD CONSTRAINT "branches_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "companies" ADD CONSTRAINT "companies_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roles" ADD CONSTRAINT "roles_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fiscal_periods" ADD CONSTRAINT "fiscal_periods_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fiscal_periods" ADD CONSTRAINT "fiscal_periods_closed_by_id_users_id_fk" FOREIGN KEY ("closed_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_period_id_fiscal_periods_id_fk" FOREIGN KEY ("period_id") REFERENCES "public"."fiscal_periods"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_approved_by_id_users_id_fk" FOREIGN KEY ("approved_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_posted_by_id_users_id_fk" FOREIGN KEY ("posted_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_reverses_fk" FOREIGN KEY ("reverses_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_reversed_by_fk" FOREIGN KEY ("reversed_by_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_entry_company_fk" FOREIGN KEY ("entry_id","company_id") REFERENCES "public"."journal_entries"("id","company_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_account_company_fk" FOREIGN KEY ("account_id","company_id") REFERENCES "public"."accounts"("id","company_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_receivable_account_id_accounts_id_fk" FOREIGN KEY ("receivable_account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_payable_account_id_accounts_id_fk" FOREIGN KEY ("payable_account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "branches_company_code_key" ON "branches" USING btree ("company_id","code");--> statement-breakpoint
CREATE INDEX "branches_company_idx" ON "branches" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "companies_org_slug_key" ON "companies" USING btree ("organization_id","slug");--> statement-breakpoint
CREATE INDEX "companies_org_idx" ON "companies" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "organizations_slug_key" ON "organizations" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "memberships_user_company_key" ON "memberships" USING btree ("user_id","company_id");--> statement-breakpoint
CREATE INDEX "memberships_company_idx" ON "memberships" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "memberships_user_idx" ON "memberships" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "roles_org_key_key" ON "roles" USING btree ("organization_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_token_hash_key" ON "sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_key" ON "users" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_company_code_key" ON "accounts" USING btree ("company_id","code");--> statement-breakpoint
CREATE INDEX "accounts_company_type_idx" ON "accounts" USING btree ("company_id","type");--> statement-breakpoint
CREATE INDEX "accounts_company_path_idx" ON "accounts" USING btree ("company_id","path");--> statement-breakpoint
CREATE UNIQUE INDEX "fiscal_periods_company_year_num_key" ON "fiscal_periods" USING btree ("company_id","fiscal_year","period_number");--> statement-breakpoint
CREATE INDEX "fiscal_periods_company_dates_idx" ON "fiscal_periods" USING btree ("company_id","start_date","end_date");--> statement-breakpoint
CREATE UNIQUE INDEX "journal_entries_company_number_key" ON "journal_entries" USING btree ("company_id","entry_number");--> statement-breakpoint
CREATE INDEX "journal_entries_company_date_idx" ON "journal_entries" USING btree ("company_id","entry_date","status");--> statement-breakpoint
CREATE INDEX "journal_entries_source_idx" ON "journal_entries" USING btree ("company_id","source_type","source_id");--> statement-breakpoint
CREATE INDEX "journal_entries_period_idx" ON "journal_entries" USING btree ("period_id");--> statement-breakpoint
CREATE INDEX "journal_lines_entry_idx" ON "journal_lines" USING btree ("entry_id","line_number");--> statement-breakpoint
CREATE INDEX "journal_lines_company_account_idx" ON "journal_lines" USING btree ("company_id","account_id");--> statement-breakpoint
CREATE INDEX "journal_lines_customer_idx" ON "journal_lines" USING btree ("company_id","customer_id");--> statement-breakpoint
CREATE INDEX "journal_lines_vendor_idx" ON "journal_lines" USING btree ("company_id","vendor_id");--> statement-breakpoint
CREATE UNIQUE INDEX "contacts_company_code_key" ON "contacts" USING btree ("company_id","code");--> statement-breakpoint
CREATE INDEX "contacts_company_kind_idx" ON "contacts" USING btree ("company_id","kind","is_active");--> statement-breakpoint
CREATE INDEX "contacts_company_name_idx" ON "contacts" USING btree ("company_id","display_name");--> statement-breakpoint
CREATE INDEX "audit_logs_company_created_idx" ON "audit_logs" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_logs_entity_idx" ON "audit_logs" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "audit_logs_actor_idx" ON "audit_logs" USING btree ("actor_id");