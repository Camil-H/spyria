ALTER TABLE "chats" ADD COLUMN "context_tokens" integer;--> statement-breakpoint
ALTER TABLE "chats" ADD COLUMN "context_window" integer;--> statement-breakpoint
ALTER PUBLICATION "spyria_zero" DROP TABLE "chats";--> statement-breakpoint
ALTER PUBLICATION "spyria_zero" ADD TABLE "chats" ("workspace_id", "id", "project_id", "type", "visibility", "mode", "owner_kind", "owner_user_id", "owner_service_identity_id", "name", "model", "reasoning_effort", "subagent_policy", "harness", "local_session", "git_branch", "repository", "base_branch", "origin_chat_id", "agent_turn_message_id", "context_tokens", "context_window", "archived", "created_at");
