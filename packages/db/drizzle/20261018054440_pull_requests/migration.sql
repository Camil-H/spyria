CREATE TABLE "github_webhook_deliveries" (
	"workspace_id" text,
	"delivery_id" text,
	"received_at" timestamp with time zone NOT NULL,
	CONSTRAINT "github_webhook_deliveries_pkey" PRIMARY KEY("workspace_id","delivery_id")
);
--> statement-breakpoint
ALTER TABLE "github_webhook_deliveries" ADD CONSTRAINT "github_webhook_deliveries_MGZJOa7aeFzl_fkey" FOREIGN KEY ("workspace_id") REFERENCES "github_apps"("workspace_id") ON DELETE CASCADE;