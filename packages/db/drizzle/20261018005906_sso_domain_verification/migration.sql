CREATE TABLE "sso_domains" (
	"workspace_id" text,
	"domain" text,
	"verified_at" timestamp with time zone,
	"verification_email" text,
	"verification_token_hash" text,
	"verification_expires_at" timestamp with time zone,
	CONSTRAINT "sso_domains_pkey" PRIMARY KEY("workspace_id","domain")
);
--> statement-breakpoint
INSERT INTO "sso_domains" ("workspace_id", "domain", "verified_at")
SELECT "workspace_sso"."workspace_id", "domain",
	CASE WHEN EXISTS (
		SELECT 1 FROM "workspace_events" WHERE "workspace_events"."workspace_id" = "workspace_sso"."workspace_id"
			AND "type" = 'sso.configured' AND "actor_id" IS NULL
	) THEN now() END
FROM "workspace_sso", unnest("domains") AS "domain";--> statement-breakpoint
ALTER TABLE "workspace_sso" DROP COLUMN "domains";--> statement-breakpoint
CREATE INDEX "sso_domains_domain_index" ON "sso_domains" ("domain");--> statement-breakpoint
CREATE UNIQUE INDEX "sso_domains_verification_token_hash_index" ON "sso_domains" ("verification_token_hash");--> statement-breakpoint
ALTER TABLE "sso_domains" ADD CONSTRAINT "sso_domains_workspace_id_workspace_sso_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace_sso"("workspace_id") ON DELETE CASCADE;