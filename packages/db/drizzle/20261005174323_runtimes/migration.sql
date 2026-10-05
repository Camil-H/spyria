CREATE TABLE "runtimes" (
	"workspace_id" text,
	"chat_id" text NOT NULL,
	"id" text,
	"host_id" text,
	"state" text NOT NULL,
	"failure" text,
	"image" text NOT NULL,
	"api_key_ref" text,
	"last_active_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"state_changed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "runtimes_pkey" PRIMARY KEY("workspace_id","id"),
	CONSTRAINT "runtimes_workspace_id_chat_id_unique" UNIQUE("workspace_id","chat_id")
);
--> statement-breakpoint
DROP INDEX "jobs_one_queued_session_sweep";--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_one_queued_sweep" ON "jobs" ("workspace_id","type") WHERE "type" like '%.sweep' and "state" = 'queued';--> statement-breakpoint
ALTER TABLE "runtimes" ADD CONSTRAINT "runtimes_workspace_id_chat_id_chats_workspace_id_id_fkey" FOREIGN KEY ("workspace_id","chat_id") REFERENCES "chats"("workspace_id","id");--> statement-breakpoint
ALTER TABLE "runtimes" ADD CONSTRAINT "runtimes_IWzUWcrQFW3H_fkey" FOREIGN KEY ("workspace_id","host_id") REFERENCES "runtime_hosts"("workspace_id","id");