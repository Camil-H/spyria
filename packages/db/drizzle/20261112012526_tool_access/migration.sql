CREATE TABLE "connection_access" (
	"workspace_id" text,
	"connection_id" text,
	"id" text,
	"role_id" text,
	"user_id" text,
	"level" text NOT NULL,
	"tool_changes" jsonb NOT NULL,
	CONSTRAINT "connection_access_pkey" PRIMARY KEY("workspace_id","connection_id","id"),
	CONSTRAINT "connection_access_subject" CHECK (num_nonnulls("role_id", "user_id") = 1),
	CONSTRAINT "connection_access_level" CHECK ("level" in ('none', 'read', 'write'))
);
--> statement-breakpoint
CREATE TABLE "tool_approvals" (
	"workspace_id" text,
	"user_id" text,
	"connection_id" text,
	"server_approval" text,
	"tool_approvals" jsonb NOT NULL,
	CONSTRAINT "tool_approvals_pkey" PRIMARY KEY("workspace_id","user_id","connection_id"),
	CONSTRAINT "tool_approvals_server_approval" CHECK ("server_approval" in ('never', 'always', 'guest'))
);
--> statement-breakpoint
DROP TABLE "connection_restrictions";--> statement-breakpoint
ALTER TABLE "workspace_connections" ADD COLUMN "is_reviewed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace_connections" ALTER COLUMN "is_reviewed" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "workspace_connections" DROP COLUMN "allowed_tools";--> statement-breakpoint
CREATE INDEX "connection_access_workspace_id_user_id_index" ON "connection_access" ("workspace_id","user_id");--> statement-breakpoint
ALTER TABLE "connection_access" ADD CONSTRAINT "connection_access_WNl84f8CFVZU_fkey" FOREIGN KEY ("workspace_id","connection_id") REFERENCES "workspace_connections"("workspace_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "connection_access" ADD CONSTRAINT "connection_access_2p5ZmUNQVYh8_fkey" FOREIGN KEY ("workspace_id","role_id") REFERENCES "workspace_roles"("workspace_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "connection_access" ADD CONSTRAINT "connection_access_f7TgzULFd5vz_fkey" FOREIGN KEY ("workspace_id","user_id") REFERENCES "memberships"("workspace_id","user_id");--> statement-breakpoint
ALTER TABLE "tool_approvals" ADD CONSTRAINT "tool_approvals_O9iClJL83Qtw_fkey" FOREIGN KEY ("workspace_id","connection_id") REFERENCES "workspace_connections"("workspace_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tool_approvals" ADD CONSTRAINT "tool_approvals_cOxWj3KyzHvH_fkey" FOREIGN KEY ("workspace_id","user_id") REFERENCES "memberships"("workspace_id","user_id");--> statement-breakpoint
ALTER PUBLICATION "spyria_zero" ADD TABLE "connection_access", "tool_approvals";