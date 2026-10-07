DELETE FROM "usage_entries";--> statement-breakpoint
CREATE TABLE "model_calls" (
	"workspace_id" text,
	"id" text,
	"chat_id" text NOT NULL,
	"prompter_id" text NOT NULL,
	"owner_id" text,
	"model" text NOT NULL,
	"provider" text NOT NULL,
	"input_tokens" integer NOT NULL,
	"output_tokens" integer NOT NULL,
	"cost_micros" integer NOT NULL,
	"status" text NOT NULL,
	"called_at" timestamp with time zone NOT NULL,
	CONSTRAINT "model_calls_pkey" PRIMARY KEY("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "usage_sync_marks" (
	"workspace_id" text PRIMARY KEY,
	"logs_since" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "usage_entries" ADD COLUMN "month" text;--> statement-breakpoint
ALTER TABLE "usage_entries" ADD COLUMN "cost_micros" bigint NOT NULL;--> statement-breakpoint
ALTER TABLE "usage_entries" ADD COLUMN "calls" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "usage_entries" DROP COLUMN "cost_cents";--> statement-breakpoint
ALTER TABLE "usage_entries" DROP CONSTRAINT "usage_entries_pkey";--> statement-breakpoint
ALTER TABLE "usage_entries" ADD PRIMARY KEY ("workspace_id","month","chat_id","user_id");--> statement-breakpoint
DROP INDEX "jobs_one_queued_sweep";--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_one_queued_sweep" ON "jobs" ("workspace_id","type") WHERE ("type" like '%.sweep' or "type" = 'usage.sync') and "state" = 'queued';--> statement-breakpoint
ALTER TABLE "model_calls" ADD CONSTRAINT "model_calls_workspace_id_workspaces_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("workspace_id");--> statement-breakpoint
ALTER TABLE "usage_sync_marks" ADD CONSTRAINT "usage_sync_marks_workspace_id_workspaces_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("workspace_id");