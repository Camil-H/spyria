ALTER TABLE "jobs" ADD COLUMN "claimed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "finished_at" timestamp with time zone;--> statement-breakpoint
UPDATE "jobs" SET "finished_at" = "run_at" WHERE "state" IN ('done', 'failed');