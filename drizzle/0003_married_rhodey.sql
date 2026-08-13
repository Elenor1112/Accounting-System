ALTER TABLE "companies" ADD COLUMN "require_open_period" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "max_future_days" integer DEFAULT 30 NOT NULL;