ALTER TABLE "chats" ADD COLUMN "agent_turn_reply_to_id" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "picked_up_at" timestamp with time zone;--> statement-breakpoint
ALTER PUBLICATION "spyria_zero" DROP TABLE "chats";--> statement-breakpoint
ALTER PUBLICATION "spyria_zero" ADD TABLE "chats" ("workspace_id", "id", "project_id", "type", "visibility", "mode", "owner_kind", "owner_user_id", "owner_service_identity_id", "name", "model", "reasoning_effort", "subagent_policy", "harness", "local_session", "git_branch", "repository", "base_branch", "origin_chat_id", "agent_turn_message_id", "agent_turn_reply_to_id", "context_tokens", "context_window", "tool_servers_off", "archived", "created_at");
