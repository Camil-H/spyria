CREATE TABLE "domain_claims" (
	"workspace_id" text,
	"domain" text,
	"token" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"verified_at" timestamp with time zone,
	CONSTRAINT "domain_claims_pkey" PRIMARY KEY("workspace_id","domain"),
	CONSTRAINT "domain_claims_lowercase_domain" CHECK ("domain" = lower("domain"))
);
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "provider_workspace_id" text;--> statement-breakpoint
UPDATE "sessions" SET "provider_workspace_id" = "workspace_id" WHERE "opened_through_workspace_sso";--> statement-breakpoint
ALTER TABLE "sessions" DROP COLUMN "opened_through_workspace_sso";--> statement-breakpoint
CREATE UNIQUE INDEX "domain_claims_one_verified_per_domain" ON "domain_claims" ("domain") WHERE "verified_at" is not null;--> statement-breakpoint
CREATE INDEX "sessions_provider_workspace_index" ON "sessions" ("provider_workspace_id");--> statement-breakpoint
ALTER TABLE "domain_claims" ADD CONSTRAINT "domain_claims_workspace_id_workspace_sso_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspace_sso"("workspace_id") ON DELETE CASCADE;--> statement-breakpoint
CREATE FUNCTION provider_opens_workspace(provider_workspace_id text, opened_workspace_id text, opening_user_id text)
RETURNS boolean LANGUAGE sql STABLE AS $$
  with claimed as (
    select domain_claims.workspace_id from domain_claims join users on users.id = opening_user_id
    where domain_claims.domain = split_part(users.email, '@', 2) and domain_claims.verified_at is not null)
  select case
    when provider_workspace_id is null then
      not exists(select 1 from workspace_sso where workspace_sso.workspace_id = opened_workspace_id)
      and not exists(select 1 from claimed)
    when not exists(select 1 from workspace_sso where workspace_sso.workspace_id = provider_workspace_id) then false
    when opened_workspace_id = provider_workspace_id then
      exists(select 1 from claimed where claimed.workspace_id = provider_workspace_id)
      or not exists(select 1 from domain_claims
        where domain_claims.workspace_id = provider_workspace_id and domain_claims.verified_at is not null)
    else
      not exists(select 1 from workspace_sso where workspace_sso.workspace_id = opened_workspace_id)
      and exists(select 1 from claimed where claimed.workspace_id = provider_workspace_id)
  end
$$;
