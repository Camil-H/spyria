CREATE TABLE "tool_calls" (
	"workspace_id" text,
	"chat_id" text NOT NULL,
	"id" text,
	"prompter_id" text NOT NULL,
	"owner_id" text NOT NULL,
	"server" text NOT NULL,
	"tool" text NOT NULL,
	"read_only" boolean,
	"decision" text NOT NULL,
	"decided_by" text,
	"status" text NOT NULL,
	"called_at" timestamp with time zone NOT NULL,
	CONSTRAINT "tool_calls_pkey" PRIMARY KEY("workspace_id","id")
);
--> statement-breakpoint
ALTER TABLE "tool_calls" ADD CONSTRAINT "tool_calls_workspace_id_chat_id_chats_workspace_id_id_fkey" FOREIGN KEY ("workspace_id","chat_id") REFERENCES "chats"("workspace_id","id");