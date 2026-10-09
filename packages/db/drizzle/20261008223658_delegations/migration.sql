CREATE TABLE "delegations" (
	"workspace_id" text,
	"chat_id" text NOT NULL,
	"id" text,
	"prompt_id" text NOT NULL,
	"conversation_id" text,
	"action_event_id" text,
	"task" text NOT NULL,
	"effort_hint" text NOT NULL,
	"directive" text,
	"policy" text NOT NULL,
	"classifier_output" jsonb,
	"model" text NOT NULL,
	"reason" text NOT NULL,
	"status" text NOT NULL,
	"escalated_from" text,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "delegations_pkey" PRIMARY KEY("workspace_id","id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "delegations_token_hash_index" ON "delegations" ("token_hash");--> statement-breakpoint
ALTER TABLE "delegations" ADD CONSTRAINT "delegations_workspace_id_chat_id_chats_workspace_id_id_fkey" FOREIGN KEY ("workspace_id","chat_id") REFERENCES "chats"("workspace_id","id");