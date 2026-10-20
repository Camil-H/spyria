ALTER TABLE "chats" ADD COLUMN "plan_first" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER PUBLICATION "spyria_zero" DROP TABLE "chats";--> statement-breakpoint
ALTER PUBLICATION "spyria_zero" ADD TABLE "chats" ("workspace_id", "id", "project_id", "type", "mode", "owner_kind", "owner_user_id", "owner_service_identity_id", "name", "model", "reasoning_effort", "default_model", "subagent_policy", "harness", "local_session", "plan_first", "git_branch", "origin_chat_id", "agent_turn_message_id", "archived", "created_at");
