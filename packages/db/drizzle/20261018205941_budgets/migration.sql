CREATE TABLE "budget_alerts" (
	"workspace_id" text,
	"id" text,
	"member_id" text,
	"month" text NOT NULL,
	"threshold" integer NOT NULL,
	"reached_at" timestamp with time zone NOT NULL,
	CONSTRAINT "budget_alerts_pkey" PRIMARY KEY("workspace_id","id"),
	CONSTRAINT "budget_alerts_threshold" CHECK ("threshold" in (80, 100))
);
--> statement-breakpoint
CREATE TABLE "budgets" (
	"workspace_id" text NOT NULL,
	"member_id" text,
	"limit_micros" bigint NOT NULL,
	CONSTRAINT "budgets_scope_key" UNIQUE NULLS NOT DISTINCT("workspace_id","member_id"),
	CONSTRAINT "budgets_limit_micros" CHECK ("limit_micros" > 0)
);
--> statement-breakpoint
ALTER TABLE "budget_alerts" ADD CONSTRAINT "budget_alerts_workspace_id_workspaces_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("workspace_id");--> statement-breakpoint
ALTER TABLE "budget_alerts" ADD CONSTRAINT "budget_alerts_cstUFxQXHeIi_fkey" FOREIGN KEY ("workspace_id","member_id") REFERENCES "memberships"("workspace_id","user_id");--> statement-breakpoint
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_workspace_id_workspaces_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("workspace_id");--> statement-breakpoint
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_B4t8yjaLqPxh_fkey" FOREIGN KEY ("workspace_id","member_id") REFERENCES "memberships"("workspace_id","user_id");--> statement-breakpoint
ALTER PUBLICATION "hq_zero" ADD TABLE "budget_alerts";