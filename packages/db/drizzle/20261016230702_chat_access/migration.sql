CREATE TABLE "chat_roles" (
	"workspace_id" text,
	"id" text,
	"name" text NOT NULL,
	"permissions" text[] NOT NULL,
	"built_in" boolean NOT NULL,
	CONSTRAINT "chat_roles_pkey" PRIMARY KEY("workspace_id","id"),
	CONSTRAINT "chat_roles_permissions_read" CHECK ('chat.read' = any("permissions"))
);
--> statement-breakpoint
ALTER TABLE "chat_roles" ADD CONSTRAINT "chat_roles_workspace_id_workspaces_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("workspace_id");--> statement-breakpoint
INSERT INTO "chat_roles" ("workspace_id", "id", "name", "permissions", "built_in")
SELECT "workspaces"."workspace_id", "role"."id", "role"."name", "role"."permissions", true
FROM "workspaces" CROSS JOIN (VALUES
	('owner', 'Owner', ARRAY['chat.read', 'chat.post', 'session.configure', 'tools.manage', 'members.invite', 'members.manage', 'chat.admin']),
	('editor', 'Editor', ARRAY['chat.read', 'chat.post', 'session.configure', 'members.invite']),
	('prompter', 'Prompter', ARRAY['chat.read', 'chat.post']),
	('reader', 'Reader', ARRAY['chat.read'])
) AS "role" ("id", "name", "permissions");--> statement-breakpoint
ALTER PUBLICATION "spyria_zero" DROP TABLE "chats";--> statement-breakpoint
ALTER TABLE "chats" ADD COLUMN "visibility" text;--> statement-breakpoint
UPDATE "chats" SET "visibility" = CASE WHEN "type" = 'channel' THEN 'public' ELSE 'private' END;--> statement-breakpoint
ALTER TABLE "chats" ALTER COLUMN "visibility" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_participants" ADD COLUMN "role_id" text;--> statement-breakpoint
UPDATE "chat_participants" SET "role_id" = CASE WHEN "role" = 'Can prompt' THEN 'prompter' ELSE 'reader' END;--> statement-breakpoint
ALTER TABLE "chat_participants" DROP COLUMN "role";--> statement-breakpoint
INSERT INTO "chat_participants" ("workspace_id", "chat_id", "user_id", "role_id")
SELECT "workspace_id", "id", "owner_user_id", 'owner' FROM "chats" WHERE "owner_kind" = 'user'
ON CONFLICT ("workspace_id", "chat_id", "user_id") DO UPDATE SET "role_id" = 'owner';--> statement-breakpoint
ALTER TABLE "chat_participants" ALTER COLUMN "role_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_participants" ADD CONSTRAINT "chat_participants_ylkN3lOK63Td_fkey" FOREIGN KEY ("workspace_id","role_id") REFERENCES "chat_roles"("workspace_id","id");--> statement-breakpoint
ALTER PUBLICATION "spyria_zero" ADD TABLE "chats" ("workspace_id", "id", "project_id", "type", "visibility", "mode", "owner_kind", "owner_user_id", "owner_service_identity_id", "name", "model", "reasoning_effort", "subagent_policy", "harness", "local_session", "is_planning", "git_branch", "origin_chat_id", "agent_turn_message_id", "archived", "created_at");--> statement-breakpoint
ALTER PUBLICATION "spyria_zero" ADD TABLE "chat_roles";
