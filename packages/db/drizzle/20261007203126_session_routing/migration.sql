CREATE TABLE "routing_decisions" (
	"workspace_id" text,
	"chat_id" text NOT NULL,
	"id" text,
	"conversation_id" text,
	"role" text NOT NULL,
	"member_id" text NOT NULL,
	"inputs_digest" text,
	"classifier_output" jsonb,
	"model" text NOT NULL,
	"reason" text NOT NULL,
	"cost_micros" integer NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "routing_decisions_pkey" PRIMARY KEY("workspace_id","id")
);
--> statement-breakpoint
ALTER TABLE "chats" ADD COLUMN "default_model" text;--> statement-breakpoint
ALTER TABLE "chats" ADD COLUMN "subagent_policy" text DEFAULT 'auto' NOT NULL;--> statement-breakpoint
ALTER TABLE "chats" ADD COLUMN "agent_model" text;--> statement-breakpoint
ALTER TABLE "model_calls" ADD COLUMN "role" text;--> statement-breakpoint
ALTER TABLE "runtimes" ADD COLUMN "llm_switch_token_hash" text;--> statement-breakpoint
ALTER TABLE "routing_decisions" ADD CONSTRAINT "routing_decisions_4alXUacnKj9B_fkey" FOREIGN KEY ("workspace_id","chat_id") REFERENCES "chats"("workspace_id","id");--> statement-breakpoint
UPDATE "chats" SET "model" = NULL, "reasoning_effort" = NULL WHERE "model" NOT LIKE '%/%';--> statement-breakpoint
ALTER PUBLICATION "hq_zero" DROP TABLE "chats";--> statement-breakpoint
ALTER PUBLICATION "hq_zero" ADD TABLE "chats" ("workspace_id", "id", "project_id", "type", "mode", "owner_kind", "owner_user_id", "owner_service_identity_id", "name", "model", "reasoning_effort", "default_model", "subagent_policy", "git_branch", "origin_chat_id", "agent_turn_message_id", "archived", "created_at");
