INSERT INTO "workspace_role_permissions" ("workspace_id", "role_id", "permission")
SELECT "workspace_id", 'admin', 'audit.manage' FROM "workspace_roles" WHERE "id" = 'admin'
ON CONFLICT DO NOTHING;
