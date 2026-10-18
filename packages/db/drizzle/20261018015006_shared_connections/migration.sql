DELETE FROM "workspace_connections";--> statement-breakpoint
CREATE TABLE "connection_restrictions" (
	"workspace_id" text,
	"connection_id" text,
	"user_id" text,
	"allowed_tools" jsonb NOT NULL,
	CONSTRAINT "connection_restrictions_pkey" PRIMARY KEY("workspace_id","connection_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "workspace_connections" DROP CONSTRAINT "workspace_connections_T91JnibJ3VLf_fkey";--> statement-breakpoint
ALTER TABLE "workspace_connections" ADD COLUMN "id" text;--> statement-breakpoint
ALTER TABLE "workspace_connections" ADD COLUMN "name" text NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace_connections" ADD COLUMN "gateway_name" text NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace_connections" ADD COLUMN "url" text NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace_connections" ADD COLUMN "header_name" text;--> statement-breakpoint
ALTER TABLE "workspace_connections" ADD COLUMN "tools" jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace_connections" ADD COLUMN "allowed_tools" jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace_connections" DROP COLUMN "user_id";--> statement-breakpoint
ALTER TABLE "workspace_connections" DROP COLUMN "tool";--> statement-breakpoint
ALTER TABLE "workspace_connections" DROP COLUMN "access";--> statement-breakpoint
ALTER TABLE "workspace_connections" DROP COLUMN "position";--> statement-breakpoint
ALTER TABLE "workspace_connections" ADD PRIMARY KEY ("workspace_id","id");--> statement-breakpoint
ALTER TABLE "workspace_connections" ADD CONSTRAINT "workspace_connections_gateway_name_key" UNIQUE("gateway_name");--> statement-breakpoint
ALTER TABLE "connection_restrictions" ADD CONSTRAINT "connection_restrictions_Dtv7aelAqLO1_fkey" FOREIGN KEY ("workspace_id","connection_id") REFERENCES "workspace_connections"("workspace_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "connection_restrictions" ADD CONSTRAINT "connection_restrictions_or6kv4FyHFrO_fkey" FOREIGN KEY ("workspace_id","user_id") REFERENCES "memberships"("workspace_id","user_id");--> statement-breakpoint
ALTER TABLE "workspace_connections" ADD CONSTRAINT "workspace_connections_workspace_id_workspaces_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("workspace_id");--> statement-breakpoint
ALTER PUBLICATION "hq_zero" ADD TABLE "connection_restrictions";
