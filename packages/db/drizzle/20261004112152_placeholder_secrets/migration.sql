CREATE TABLE "placeholder_secrets" (
	"workspace_id" text,
	"ref" text,
	"value" text NOT NULL,
	CONSTRAINT "placeholder_secrets_pkey" PRIMARY KEY("workspace_id","ref")
);
--> statement-breakpoint
ALTER TABLE "tool_connections" ADD CONSTRAINT "tool_connections_workspace_id_user_id_position_unique" UNIQUE("workspace_id","user_id","position");--> statement-breakpoint
ALTER TABLE "placeholder_secrets" ADD CONSTRAINT "placeholder_secrets_workspace_id_workspaces_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("workspace_id");