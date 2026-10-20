CREATE TABLE "workspace_role_permissions" (
	"workspace_id" text,
	"role_id" text,
	"permission" text,
	CONSTRAINT "workspace_role_permissions_pkey" PRIMARY KEY("workspace_id","role_id","permission")
);
--> statement-breakpoint
CREATE TABLE "workspace_roles" (
	"workspace_id" text,
	"id" text,
	"name" text NOT NULL,
	"built_in" boolean NOT NULL,
	CONSTRAINT "workspace_roles_pkey" PRIMARY KEY("workspace_id","id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_roles_name_index" ON "workspace_roles" ("workspace_id",lower("name"));--> statement-breakpoint
INSERT INTO "workspace_roles" ("workspace_id", "id", "name", "built_in")
SELECT "workspace_id", "built_in_role"."id", "built_in_role"."name", true FROM "workspaces"
CROSS JOIN (VALUES ('admin', 'Admin'), ('member', 'Member')) AS "built_in_role" ("id", "name");--> statement-breakpoint
INSERT INTO "workspace_role_permissions" ("workspace_id", "role_id", "permission")
SELECT "workspace_id", 'admin', "permission" FROM "workspaces"
CROSS JOIN unnest(ARRAY['members.invite', 'members.manage', 'roles.manage', 'sso.manage', 'github.manage', 'tools.manage',
  'runtimes.manage', 'costs.view', 'budgets.manage', 'audit.view']) AS "permission";--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_W6V6Me0w2fna_fkey" FOREIGN KEY ("workspace_id","role") REFERENCES "workspace_roles"("workspace_id","id");--> statement-breakpoint
ALTER TABLE "workspace_role_permissions" ADD CONSTRAINT "workspace_role_permissions_YYXfGqC0q9PS_fkey" FOREIGN KEY ("workspace_id","role_id") REFERENCES "workspace_roles"("workspace_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "workspace_roles" ADD CONSTRAINT "workspace_roles_workspace_id_workspaces_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("workspace_id");--> statement-breakpoint
ALTER PUBLICATION "spyria_zero" ADD TABLE "workspace_roles", "workspace_role_permissions";