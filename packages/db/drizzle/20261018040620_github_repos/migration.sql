CREATE TABLE "github_apps" (
	"workspace_id" text PRIMARY KEY,
	"app_id" text NOT NULL,
	"client_id" text NOT NULL,
	"encrypted_client_secret" text NOT NULL,
	"encrypted_private_key" text NOT NULL,
	"encrypted_webhook_secret" text NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "github_connections" (
	"workspace_id" text,
	"user_id" text,
	"login" text NOT NULL,
	"encrypted_access_token" text NOT NULL,
	"encrypted_refresh_token" text,
	"access_expires_at" timestamp with time zone,
	"needs_reconnection" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "github_connections_pkey" PRIMARY KEY("workspace_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "chats" ADD COLUMN "repository" text;--> statement-breakpoint
ALTER TABLE "chats" ADD COLUMN "base_branch" text;--> statement-breakpoint
ALTER TABLE "github_apps" ADD CONSTRAINT "github_apps_workspace_id_workspaces_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("workspace_id");--> statement-breakpoint
ALTER TABLE "github_connections" ADD CONSTRAINT "github_connections_NRbMuXzI0sJP_fkey" FOREIGN KEY ("workspace_id","user_id") REFERENCES "memberships"("workspace_id","user_id");--> statement-breakpoint
ALTER PUBLICATION "spyria_zero" DROP TABLE "chats";--> statement-breakpoint
ALTER PUBLICATION "spyria_zero" ADD TABLE "chats" ("workspace_id", "id", "project_id", "type", "visibility", "mode", "owner_kind", "owner_user_id", "owner_service_identity_id", "name", "model", "reasoning_effort", "subagent_policy", "harness", "local_session", "is_planning", "git_branch", "repository", "base_branch", "origin_chat_id", "agent_turn_message_id", "archived", "created_at");
