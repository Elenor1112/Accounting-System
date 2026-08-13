ALTER TYPE "public"."document_status" ADD VALUE 'written_off';--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "last_closed_date" date;--> statement-breakpoint
ALTER TABLE "reconciliations" ADD COLUMN "explanation" text;--> statement-breakpoint
ALTER TABLE "reconciliations" ADD COLUMN "adjustment_entry_id" uuid;--> statement-breakpoint
ALTER TABLE "reconciliations" ADD CONSTRAINT "reconciliations_completed_explained_ck" CHECK ("reconciliations"."status" <> 'completed'
          OR "reconciliations"."difference" = 0
          OR "reconciliations"."explanation" IS NOT NULL
          OR "reconciliations"."adjustment_entry_id" IS NOT NULL);