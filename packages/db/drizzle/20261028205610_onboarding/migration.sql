CREATE TABLE "member_onboarding" (
	"workspace_id" text,
	"user_id" text,
	"task" text,
	"completed_at" timestamp with time zone,
	"skipped_at" timestamp with time zone,
	CONSTRAINT "member_onboarding_pkey" PRIMARY KEY("workspace_id","user_id","task")
);
--> statement-breakpoint
CREATE TABLE "workspace_onboarding" (
	"workspace_id" text,
	"task" text,
	"completed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "workspace_onboarding_pkey" PRIMARY KEY("workspace_id","task")
);
--> statement-breakpoint
ALTER TABLE "member_onboarding" ADD CONSTRAINT "member_onboarding_yCETkLVxb9FQ_fkey" FOREIGN KEY ("workspace_id","user_id") REFERENCES "memberships"("workspace_id","user_id");--> statement-breakpoint
ALTER TABLE "workspace_onboarding" ADD CONSTRAINT "workspace_onboarding_workspace_id_workspaces_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("workspace_id");--> statement-breakpoint
ALTER PUBLICATION "spyria_zero" ADD TABLE "workspace_onboarding", "member_onboarding";--> statement-breakpoint
ALTER PUBLICATION "spyria_zero" ADD TABLE "sso_domains" ("workspace_id", "domain", "verified_at");--> statement-breakpoint
ALTER PUBLICATION "spyria_zero" ADD TABLE "github_apps" ("workspace_id", "updated_at");--> statement-breakpoint
ALTER PUBLICATION "spyria_zero" ADD TABLE "github_connections" ("workspace_id", "user_id", "needs_reconnection");
