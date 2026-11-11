CREATE TABLE "account_identities" (
	"issuer" text,
	"subject" text,
	"user_id" text NOT NULL,
	CONSTRAINT "account_identities_pkey" PRIMARY KEY("issuer","subject")
);
--> statement-breakpoint
DROP TABLE "sso_domains";--> statement-breakpoint
DROP FUNCTION refuse_domain_of_invited_workspace();--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "opened_through_workspace_sso" boolean DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE "sessions" SET "opened_through_workspace_sso" = true
  WHERE "workspace_id" IN (SELECT "workspace_id" FROM "workspace_sso");--> statement-breakpoint
DROP TRIGGER workspaces_join_by_fixed ON "workspaces";--> statement-breakpoint
DROP FUNCTION refuse_join_by_change();--> statement-breakpoint
ALTER TABLE "workspaces" DROP COLUMN "join_by";--> statement-breakpoint
CREATE INDEX "account_identities_user_id_index" ON "account_identities" ("user_id");--> statement-breakpoint
ALTER TABLE "account_identities" ADD CONSTRAINT "account_identities_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id");
