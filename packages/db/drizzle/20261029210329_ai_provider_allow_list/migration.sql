ALTER TABLE "workspaces" ADD COLUMN "ai_provider_allow_list" jsonb;--> statement-breakpoint
INSERT INTO "workspace_role_permissions" ("workspace_id", "role_id", "permission")
SELECT "workspace_id", 'admin', 'providers.manage' FROM "workspace_roles" WHERE "id" = 'admin'
ON CONFLICT DO NOTHING;
