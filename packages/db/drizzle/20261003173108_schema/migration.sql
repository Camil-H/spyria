CREATE TABLE "browser_pages" (
	"workspace_id" text,
	"chat_id" text,
	"url" text,
	"title" text NOT NULL,
	"body_text" text NOT NULL,
	CONSTRAINT "browser_pages_pkey" PRIMARY KEY("workspace_id","chat_id","url")
);
--> statement-breakpoint
CREATE TABLE "changes" (
	"workspace_id" text,
	"chat_id" text,
	"path" text,
	"additions" integer NOT NULL,
	"deletions" integer NOT NULL,
	"diff_lines" jsonb NOT NULL,
	CONSTRAINT "changes_pkey" PRIMARY KEY("workspace_id","chat_id","path")
);
--> statement-breakpoint
CREATE TABLE "chat_participants" (
	"workspace_id" text,
	"chat_id" text,
	"user_id" text,
	"role" text NOT NULL,
	CONSTRAINT "chat_participants_pkey" PRIMARY KEY("workspace_id","chat_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "chats" (
	"workspace_id" text,
	"id" text,
	"project_id" text,
	"type" text NOT NULL,
	"mode" text,
	"owner_kind" text NOT NULL,
	"owner_user_id" text,
	"owner_service_identity_id" text,
	"name" text NOT NULL,
	"model" text,
	"reasoning_effort" text,
	"git_branch" text,
	"origin_chat_id" text,
	"archived" boolean NOT NULL,
	CONSTRAINT "chats_pkey" PRIMARY KEY("workspace_id","id"),
	CONSTRAINT "chats_owner_matches_kind" CHECK (("owner_kind" = 'user' and "owner_user_id" is not null and "owner_service_identity_id" is null) or ("owner_kind" = 'service_identity' and "owner_service_identity_id" is not null and "owner_user_id" is null))
);
--> statement-breakpoint
CREATE TABLE "commits" (
	"workspace_id" text,
	"chat_id" text,
	"sha" text,
	"message" text NOT NULL,
	"author_id" text NOT NULL,
	"committed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "commits_pkey" PRIMARY KEY("workspace_id","chat_id","sha")
);
--> statement-breakpoint
CREATE TABLE "events" (
	"workspace_id" text,
	"chat_id" text NOT NULL,
	"id" text,
	"seq" integer NOT NULL,
	"type" text NOT NULL,
	"actor" text,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "events_pkey" PRIMARY KEY("workspace_id","id"),
	CONSTRAINT "events_chat_id_seq_unique" UNIQUE("chat_id","seq")
);
--> statement-breakpoint
CREATE TABLE "files" (
	"workspace_id" text,
	"chat_id" text,
	"path" text,
	"kind" text NOT NULL,
	CONSTRAINT "files_pkey" PRIMARY KEY("workspace_id","chat_id","path")
);
--> statement-breakpoint
CREATE TABLE "identities" (
	"workspace_id" text,
	"issuer" text,
	"subject" text,
	"user_id" text NOT NULL,
	CONSTRAINT "identities_pkey" PRIMARY KEY("workspace_id","issuer","subject")
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"workspace_id" text,
	"id" text,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"run_at" timestamp with time zone NOT NULL,
	"attempts" integer NOT NULL,
	"state" text NOT NULL,
	CONSTRAINT "jobs_pkey" PRIMARY KEY("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "llm_credentials" (
	"workspace_id" text,
	"id" text,
	"user_id" text NOT NULL,
	"provider" text NOT NULL,
	"last4" text NOT NULL,
	"secret_ref" text NOT NULL,
	CONSTRAINT "llm_credentials_pkey" PRIMARY KEY("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"workspace_id" text,
	"user_id" text,
	"role" text NOT NULL,
	"display_name" text NOT NULL,
	CONSTRAINT "memberships_pkey" PRIMARY KEY("workspace_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"workspace_id" text,
	"chat_id" text NOT NULL,
	"id" text,
	"seq" integer NOT NULL,
	"kind" text NOT NULL,
	"author_id" text,
	"body" text NOT NULL,
	"detail" text,
	"reply_to_id" text,
	"created_at" timestamp with time zone NOT NULL,
	"edited_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "messages_pkey" PRIMARY KEY("workspace_id","id"),
	CONSTRAINT "messages_chat_id_seq_unique" UNIQUE("chat_id","seq")
);
--> statement-breakpoint
CREATE TABLE "plan_steps" (
	"workspace_id" text,
	"chat_id" text,
	"position" integer,
	"title" text NOT NULL,
	"status" text NOT NULL,
	CONSTRAINT "plan_steps_pkey" PRIMARY KEY("workspace_id","chat_id","position")
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"workspace_id" text,
	"id" text,
	"name" text NOT NULL,
	"archived" boolean NOT NULL,
	CONSTRAINT "projects_pkey" PRIMARY KEY("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "read_markers" (
	"workspace_id" text,
	"chat_id" text,
	"user_id" text,
	"last_read_seq" integer NOT NULL,
	CONSTRAINT "read_markers_pkey" PRIMARY KEY("workspace_id","user_id","chat_id")
);
--> statement-breakpoint
CREATE TABLE "service_identities" (
	"workspace_id" text,
	"id" text,
	"name" text NOT NULL,
	CONSTRAINT "service_identities_pkey" PRIMARY KEY("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"workspace_id" text,
	"id" text,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "sessions_pkey" PRIMARY KEY("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "sources" (
	"workspace_id" text,
	"chat_id" text,
	"name" text,
	"origin" text NOT NULL,
	CONSTRAINT "sources_pkey" PRIMARY KEY("workspace_id","chat_id","name")
);
--> statement-breakpoint
CREATE TABLE "terminal_lines" (
	"workspace_id" text,
	"chat_id" text,
	"position" integer,
	"text" text NOT NULL,
	CONSTRAINT "terminal_lines_pkey" PRIMARY KEY("workspace_id","chat_id","position")
);
--> statement-breakpoint
CREATE TABLE "tool_connections" (
	"workspace_id" text,
	"user_id" text,
	"tool" text,
	"status" text NOT NULL,
	CONSTRAINT "tool_connections_pkey" PRIMARY KEY("workspace_id","user_id","tool")
);
--> statement-breakpoint
CREATE TABLE "usage_entries" (
	"workspace_id" text,
	"chat_id" text,
	"user_id" text,
	"tokens" integer NOT NULL,
	"cost_cents" integer NOT NULL,
	CONSTRAINT "usage_entries_pkey" PRIMARY KEY("workspace_id","chat_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY,
	"email" text NOT NULL UNIQUE
);
--> statement-breakpoint
CREATE TABLE "workspace_connections" (
	"workspace_id" text,
	"user_id" text,
	"tool" text,
	"access" text NOT NULL,
	CONSTRAINT "workspace_connections_pkey" PRIMARY KEY("workspace_id","user_id","tool")
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"workspace_id" text PRIMARY KEY,
	"name" text NOT NULL,
	"created_by" text NOT NULL
);
--> statement-breakpoint
CREATE INDEX "jobs_state_run_at_index" ON "jobs" ("state","run_at");--> statement-breakpoint
ALTER TABLE "browser_pages" ADD CONSTRAINT "browser_pages_workspace_id_chat_id_chats_workspace_id_id_fkey" FOREIGN KEY ("workspace_id","chat_id") REFERENCES "chats"("workspace_id","id");--> statement-breakpoint
ALTER TABLE "changes" ADD CONSTRAINT "changes_workspace_id_chat_id_chats_workspace_id_id_fkey" FOREIGN KEY ("workspace_id","chat_id") REFERENCES "chats"("workspace_id","id");--> statement-breakpoint
ALTER TABLE "chat_participants" ADD CONSTRAINT "chat_participants_1eaBIKlSavtm_fkey" FOREIGN KEY ("workspace_id","chat_id") REFERENCES "chats"("workspace_id","id");--> statement-breakpoint
ALTER TABLE "chat_participants" ADD CONSTRAINT "chat_participants_T8dmJy7zh6nz_fkey" FOREIGN KEY ("workspace_id","user_id") REFERENCES "memberships"("workspace_id","user_id");--> statement-breakpoint
ALTER TABLE "chats" ADD CONSTRAINT "chats_workspace_id_project_id_projects_workspace_id_id_fkey" FOREIGN KEY ("workspace_id","project_id") REFERENCES "projects"("workspace_id","id");--> statement-breakpoint
ALTER TABLE "chats" ADD CONSTRAINT "chats_iiNiPXwLfxXz_fkey" FOREIGN KEY ("workspace_id","owner_user_id") REFERENCES "memberships"("workspace_id","user_id");--> statement-breakpoint
ALTER TABLE "chats" ADD CONSTRAINT "chats_FEkcSURTyRc9_fkey" FOREIGN KEY ("workspace_id","owner_service_identity_id") REFERENCES "service_identities"("workspace_id","id");--> statement-breakpoint
ALTER TABLE "chats" ADD CONSTRAINT "chats_workspace_id_origin_chat_id_chats_workspace_id_id_fkey" FOREIGN KEY ("workspace_id","origin_chat_id") REFERENCES "chats"("workspace_id","id");--> statement-breakpoint
ALTER TABLE "commits" ADD CONSTRAINT "commits_workspace_id_chat_id_chats_workspace_id_id_fkey" FOREIGN KEY ("workspace_id","chat_id") REFERENCES "chats"("workspace_id","id");--> statement-breakpoint
ALTER TABLE "commits" ADD CONSTRAINT "commits_PgUbOxfnZYKI_fkey" FOREIGN KEY ("workspace_id","author_id") REFERENCES "memberships"("workspace_id","user_id");--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_workspace_id_chat_id_chats_workspace_id_id_fkey" FOREIGN KEY ("workspace_id","chat_id") REFERENCES "chats"("workspace_id","id");--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_workspace_id_chat_id_chats_workspace_id_id_fkey" FOREIGN KEY ("workspace_id","chat_id") REFERENCES "chats"("workspace_id","id");--> statement-breakpoint
ALTER TABLE "identities" ADD CONSTRAINT "identities_eIXAJt821ZMi_fkey" FOREIGN KEY ("workspace_id","user_id") REFERENCES "memberships"("workspace_id","user_id");--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_workspace_id_workspaces_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("workspace_id");--> statement-breakpoint
ALTER TABLE "llm_credentials" ADD CONSTRAINT "llm_credentials_UUt7TxskVuNc_fkey" FOREIGN KEY ("workspace_id","user_id") REFERENCES "memberships"("workspace_id","user_id");--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_workspace_id_workspaces_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("workspace_id");--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id");--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_workspace_id_chat_id_chats_workspace_id_id_fkey" FOREIGN KEY ("workspace_id","chat_id") REFERENCES "chats"("workspace_id","id");--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_Ps26ckhBb1cg_fkey" FOREIGN KEY ("workspace_id","author_id") REFERENCES "memberships"("workspace_id","user_id");--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_workspace_id_reply_to_id_messages_workspace_id_id_fkey" FOREIGN KEY ("workspace_id","reply_to_id") REFERENCES "messages"("workspace_id","id");--> statement-breakpoint
ALTER TABLE "plan_steps" ADD CONSTRAINT "plan_steps_workspace_id_chat_id_chats_workspace_id_id_fkey" FOREIGN KEY ("workspace_id","chat_id") REFERENCES "chats"("workspace_id","id");--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_workspace_id_workspaces_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("workspace_id");--> statement-breakpoint
ALTER TABLE "read_markers" ADD CONSTRAINT "read_markers_workspace_id_chat_id_chats_workspace_id_id_fkey" FOREIGN KEY ("workspace_id","chat_id") REFERENCES "chats"("workspace_id","id");--> statement-breakpoint
ALTER TABLE "read_markers" ADD CONSTRAINT "read_markers_94CbVBHMKb3y_fkey" FOREIGN KEY ("workspace_id","user_id") REFERENCES "memberships"("workspace_id","user_id");--> statement-breakpoint
ALTER TABLE "service_identities" ADD CONSTRAINT "service_identities_workspace_id_workspaces_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("workspace_id");--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_2hh7S2reKhGn_fkey" FOREIGN KEY ("workspace_id","user_id") REFERENCES "memberships"("workspace_id","user_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "sources" ADD CONSTRAINT "sources_workspace_id_chat_id_chats_workspace_id_id_fkey" FOREIGN KEY ("workspace_id","chat_id") REFERENCES "chats"("workspace_id","id");--> statement-breakpoint
ALTER TABLE "terminal_lines" ADD CONSTRAINT "terminal_lines_workspace_id_chat_id_chats_workspace_id_id_fkey" FOREIGN KEY ("workspace_id","chat_id") REFERENCES "chats"("workspace_id","id");--> statement-breakpoint
ALTER TABLE "tool_connections" ADD CONSTRAINT "tool_connections_4LjMoJm85a4k_fkey" FOREIGN KEY ("workspace_id","user_id") REFERENCES "memberships"("workspace_id","user_id");--> statement-breakpoint
ALTER TABLE "usage_entries" ADD CONSTRAINT "usage_entries_workspace_id_chat_id_chats_workspace_id_id_fkey" FOREIGN KEY ("workspace_id","chat_id") REFERENCES "chats"("workspace_id","id");--> statement-breakpoint
ALTER TABLE "usage_entries" ADD CONSTRAINT "usage_entries_IDWiWwU5ZZsW_fkey" FOREIGN KEY ("workspace_id","user_id") REFERENCES "memberships"("workspace_id","user_id");--> statement-breakpoint
ALTER TABLE "workspace_connections" ADD CONSTRAINT "workspace_connections_T91JnibJ3VLf_fkey" FOREIGN KEY ("workspace_id","user_id") REFERENCES "memberships"("workspace_id","user_id");--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_created_by_users_id_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id");