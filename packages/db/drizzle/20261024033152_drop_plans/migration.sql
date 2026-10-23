DELETE FROM "messages" "message" WHERE ("message"."step" ->> 'type' = 'plan' OR ("message"."step" ->> 'type' = 'question' AND "message"."step" ->> 'kind' = 'plan'))
  AND NOT EXISTS (SELECT 1 FROM "messages" "other" WHERE "other"."workspace_id" = "message"."workspace_id" AND "message"."id" IN ("other"."reply_to_id", "other"."thread_root_id"))
  AND NOT EXISTS (SELECT 1 FROM "runtime_origins" "origin" WHERE "origin"."workspace_id" = "message"."workspace_id" AND "origin"."message_id" = "message"."id")
  AND NOT EXISTS (SELECT 1 FROM "thread_read_markers" "marker" WHERE "marker"."workspace_id" = "message"."workspace_id" AND "marker"."thread_root_id" = "message"."id")
  AND NOT EXISTS (SELECT 1 FROM "message_attachments" "attachment" WHERE "attachment"."workspace_id" = "message"."workspace_id" AND "attachment"."message_id" = "message"."id");--> statement-breakpoint
DROP TABLE "plan_steps";--> statement-breakpoint
ALTER PUBLICATION "spyria_zero" DROP TABLE "chats";--> statement-breakpoint
ALTER TABLE "chats" DROP COLUMN "is_planning";--> statement-breakpoint
ALTER PUBLICATION "spyria_zero" ADD TABLE "chats" ("workspace_id", "id", "project_id", "type", "visibility", "mode", "owner_kind", "owner_user_id", "owner_service_identity_id", "name", "model", "reasoning_effort", "subagent_policy", "harness", "local_session", "git_branch", "repository", "base_branch", "origin_chat_id", "agent_turn_message_id", "archived", "created_at");
