UPDATE "users" SET "email" = lower(btrim("email"));--> statement-breakpoint
CREATE TABLE "invitations" (
	"workspace_id" text,
	"id" text,
	"email" text NOT NULL,
	"role" text NOT NULL,
	"invited_by" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"accepted_at" timestamp with time zone,
	CONSTRAINT "invitations_pkey" PRIMARY KEY("workspace_id","id"),
	CONSTRAINT "invitations_email_normalized" CHECK ("email" = lower(btrim("email")))
);
--> statement-breakpoint
CREATE TABLE "workspace_events" (
	"workspace_id" text,
	"id" text,
	"type" text NOT NULL,
	"actor_id" text,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "workspace_events_pkey" PRIMARY KEY("workspace_id","id")
);
--> statement-breakpoint
ALTER TABLE "memberships" ADD COLUMN "removed_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "invitations_one_pending_per_email" ON "invitations" ("workspace_id","email") WHERE "revoked_at" is null and "accepted_at" is null;--> statement-breakpoint
CREATE INDEX "invitations_email_index" ON "invitations" ("email");--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_workspace_id_workspaces_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("workspace_id");--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_dhezOQEmFv1k_fkey" FOREIGN KEY ("workspace_id","invited_by") REFERENCES "memberships"("workspace_id","user_id");--> statement-breakpoint
ALTER TABLE "workspace_events" ADD CONSTRAINT "workspace_events_workspace_id_workspaces_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("workspace_id");--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_email_normalized" CHECK ("email" = lower(btrim("email")));--> statement-breakpoint
ALTER PUBLICATION "spyria_zero" ADD TABLE "invitations";
