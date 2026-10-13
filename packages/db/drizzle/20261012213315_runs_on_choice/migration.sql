ALTER PUBLICATION "hq_zero" DROP TABLE "chats";--> statement-breakpoint
ALTER TABLE "chats" DROP COLUMN IF EXISTS "plan_first";--> statement-breakpoint
ALTER TABLE "chats" ALTER COLUMN "local_session" DROP NOT NULL;--> statement-breakpoint
ALTER PUBLICATION "hq_zero" ADD TABLE "chats" ("workspace_id", "id", "project_id", "type", "mode", "owner_kind", "owner_user_id", "owner_service_identity_id", "name", "model", "reasoning_effort", "default_model", "subagent_policy", "harness", "local_session", "git_branch", "origin_chat_id", "agent_turn_message_id", "archived", "created_at");
