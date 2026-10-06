CREATE TABLE "member_gateway_keys" (
	"workspace_id" text,
	"user_id" text,
	"virtual_key_id" text NOT NULL,
	CONSTRAINT "member_gateway_keys_pkey" PRIMARY KEY("workspace_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "chats" ADD COLUMN "agent_turn_prompter_id" text;--> statement-breakpoint
ALTER TABLE "chats" ADD COLUMN "agent_turn_failure" text;--> statement-breakpoint
ALTER TABLE "runtimes" ADD COLUMN "api_key" text;--> statement-breakpoint
ALTER TABLE "runtimes" ADD COLUMN "llm_token_hash" text;--> statement-breakpoint
ALTER TABLE "member_gateway_keys" ADD CONSTRAINT "member_gateway_keys_ZnC0Q45Z6VHm_fkey" FOREIGN KEY ("workspace_id","user_id") REFERENCES "memberships"("workspace_id","user_id");--> statement-breakpoint
UPDATE "runtimes" SET
  "api_key" = (SELECT "value" FROM "placeholder_secrets" WHERE "placeholder_secrets"."workspace_id" = "runtimes"."workspace_id" AND "placeholder_secrets"."ref" = "runtimes"."api_key_ref"),
  "llm_token_hash" = (SELECT encode(sha256(convert_to("value", 'UTF8')), 'hex') FROM "placeholder_secrets" WHERE "placeholder_secrets"."workspace_id" = "runtimes"."workspace_id" AND "placeholder_secrets"."ref" = "runtimes"."llm_token_ref");--> statement-breakpoint
ALTER PUBLICATION "hq_zero" DROP TABLE "chats";--> statement-breakpoint
ALTER PUBLICATION "hq_zero" ADD TABLE "chats" ("workspace_id", "id", "project_id", "type", "mode", "owner_kind", "owner_user_id", "owner_service_identity_id", "name", "model", "reasoning_effort", "git_branch", "origin_chat_id", "agent_turn_message_id", "archived", "created_at");
