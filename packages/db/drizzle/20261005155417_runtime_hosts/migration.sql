CREATE TABLE "runtime_hosts" (
	"workspace_id" text,
	"id" text,
	"name" text NOT NULL,
	"claim_code_hash" text UNIQUE,
	"claim_expires_at" timestamp with time zone,
	"token_hash" text UNIQUE,
	"status" text NOT NULL,
	"capacity" jsonb,
	"running_runtimes" integer NOT NULL,
	"last_seen_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"removed_at" timestamp with time zone,
	CONSTRAINT "runtime_hosts_pkey" PRIMARY KEY("workspace_id","id")
);
--> statement-breakpoint
ALTER TABLE "runtime_hosts" ADD CONSTRAINT "runtime_hosts_ZKO4tV2XfLRR_fkey" FOREIGN KEY ("workspace_id","created_by") REFERENCES "memberships"("workspace_id","user_id");