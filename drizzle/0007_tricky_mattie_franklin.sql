CREATE TABLE "products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"sku" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"category" text,
	"unit" text DEFAULT 'each' NOT NULL,
	"kind" text DEFAULT 'inventory' NOT NULL,
	"average_cost" numeric(20, 6) DEFAULT '0' NOT NULL,
	"quantity_on_hand" numeric(20, 6) DEFAULT '0' NOT NULL,
	"selling_price" numeric(20, 6) DEFAULT '0' NOT NULL,
	"inventory_account_id" uuid,
	"cogs_account_id" uuid,
	"revenue_account_id" uuid,
	"tax_id" uuid,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "products_id_company_key" UNIQUE("id","company_id"),
	CONSTRAINT "products_avg_cost_nonneg_ck" CHECK ("products"."average_cost" >= 0),
	CONSTRAINT "products_qty_nonneg_ck" CHECK ("products"."quantity_on_hand" >= 0),
	CONSTRAINT "products_selling_price_nonneg_ck" CHECK ("products"."selling_price" >= 0)
);
--> statement-breakpoint
CREATE TABLE "stock_movements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"movement_date" date NOT NULL,
	"movement_type" text NOT NULL,
	"quantity" numeric(20, 6) NOT NULL,
	"unit_cost" numeric(20, 6) DEFAULT '0' NOT NULL,
	"total_cost" numeric(20, 6) DEFAULT '0' NOT NULL,
	"quantity_after" numeric(20, 6) NOT NULL,
	"average_cost_after" numeric(20, 6) DEFAULT '0' NOT NULL,
	"source_type" text DEFAULT 'manual' NOT NULL,
	"source_id" uuid,
	"journal_entry_id" uuid,
	"branch_id" uuid,
	"notes" text,
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_movements_qty_nonzero_ck" CHECK ("stock_movements"."quantity" <> 0),
	CONSTRAINT "stock_movements_unit_cost_nonneg_ck" CHECK ("stock_movements"."unit_cost" >= 0),
	CONSTRAINT "stock_movements_qty_after_nonneg_ck" CHECK ("stock_movements"."quantity_after" >= 0)
);
--> statement-breakpoint
CREATE TABLE "depreciation_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"period_end" date NOT NULL,
	"amount" numeric(20, 6) NOT NULL,
	"accumulated_after" numeric(20, 6) NOT NULL,
	"net_book_value_after" numeric(20, 6) NOT NULL,
	"journal_entry_id" uuid,
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "depreciation_entries_amount_positive_ck" CHECK ("depreciation_entries"."amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "fixed_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"asset_number" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"category" text,
	"acquisition_date" date NOT NULL,
	"cost" numeric(20, 6) NOT NULL,
	"residual_value" numeric(20, 6) DEFAULT '0' NOT NULL,
	"useful_life_months" integer NOT NULL,
	"method" text DEFAULT 'straight_line' NOT NULL,
	"accumulated_depreciation" numeric(20, 6) DEFAULT '0' NOT NULL,
	"depreciated_to" date,
	"status" text DEFAULT 'active' NOT NULL,
	"disposal_date" date,
	"disposal_proceeds" numeric(20, 6),
	"asset_account_id" uuid,
	"accumulated_account_id" uuid,
	"expense_account_id" uuid,
	"branch_id" uuid,
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fixed_assets_id_company_key" UNIQUE("id","company_id"),
	CONSTRAINT "fixed_assets_cost_positive_ck" CHECK ("fixed_assets"."cost" > 0),
	CONSTRAINT "fixed_assets_residual_nonneg_ck" CHECK ("fixed_assets"."residual_value" >= 0),
	CONSTRAINT "fixed_assets_residual_lte_cost_ck" CHECK ("fixed_assets"."residual_value" <= "fixed_assets"."cost"),
	CONSTRAINT "fixed_assets_life_positive_ck" CHECK ("fixed_assets"."useful_life_months" > 0),
	CONSTRAINT "fixed_assets_accum_within_depreciable_ck" CHECK ("fixed_assets"."accumulated_depreciation" >= 0
          AND "fixed_assets"."accumulated_depreciation" <= ("fixed_assets"."cost" - "fixed_assets"."residual_value"))
);
--> statement-breakpoint
ALTER TABLE "document_lines" ADD COLUMN "product_id" uuid;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_inventory_account_id_accounts_id_fk" FOREIGN KEY ("inventory_account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_cogs_account_id_accounts_id_fk" FOREIGN KEY ("cogs_account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_revenue_account_id_accounts_id_fk" FOREIGN KEY ("revenue_account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_product_company_fk" FOREIGN KEY ("product_id","company_id") REFERENCES "public"."products"("id","company_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "depreciation_entries" ADD CONSTRAINT "depreciation_entries_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "depreciation_entries" ADD CONSTRAINT "depreciation_entries_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "depreciation_entries" ADD CONSTRAINT "depreciation_entries_asset_company_fk" FOREIGN KEY ("asset_id","company_id") REFERENCES "public"."fixed_assets"("id","company_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_asset_account_id_accounts_id_fk" FOREIGN KEY ("asset_account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_accumulated_account_id_accounts_id_fk" FOREIGN KEY ("accumulated_account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_expense_account_id_accounts_id_fk" FOREIGN KEY ("expense_account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "products_company_sku_key" ON "products" USING btree ("company_id","sku");--> statement-breakpoint
CREATE INDEX "products_company_active_idx" ON "products" USING btree ("company_id","is_active");--> statement-breakpoint
CREATE INDEX "products_company_name_idx" ON "products" USING btree ("company_id","name");--> statement-breakpoint
CREATE INDEX "stock_movements_product_idx" ON "stock_movements" USING btree ("company_id","product_id","movement_date");--> statement-breakpoint
CREATE INDEX "stock_movements_source_idx" ON "stock_movements" USING btree ("company_id","source_type","source_id");--> statement-breakpoint
CREATE INDEX "stock_movements_date_idx" ON "stock_movements" USING btree ("company_id","movement_date");--> statement-breakpoint
CREATE UNIQUE INDEX "depreciation_entries_asset_period_key" ON "depreciation_entries" USING btree ("asset_id","period_end");--> statement-breakpoint
CREATE INDEX "depreciation_entries_company_period_idx" ON "depreciation_entries" USING btree ("company_id","period_end");--> statement-breakpoint
CREATE UNIQUE INDEX "fixed_assets_company_number_key" ON "fixed_assets" USING btree ("company_id","asset_number");--> statement-breakpoint
CREATE INDEX "fixed_assets_company_status_idx" ON "fixed_assets" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "document_lines_product_idx" ON "document_lines" USING btree ("company_id","product_id");