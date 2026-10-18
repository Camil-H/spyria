CREATE TABLE "workspace_sso" (
	"workspace_id" text PRIMARY KEY,
	"preset" text NOT NULL,
	"issuer" text NOT NULL,
	"client_id" text NOT NULL,
	"encrypted_client_secret" text NOT NULL,
	"domains" text[] NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "identities_issuer_subject_index" ON "identities" ("issuer","subject");--> statement-breakpoint
ALTER TABLE "workspace_sso" ADD CONSTRAINT "workspace_sso_workspace_id_workspaces_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("workspace_id");