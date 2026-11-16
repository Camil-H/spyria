DELETE FROM "budget_alerts";--> statement-breakpoint
CREATE TABLE "role_budgets" (
	"workspace_id" text,
	"role_id" text,
	"period" text,
	"limit_micros" bigint NOT NULL,
	CONSTRAINT "role_budgets_pkey" PRIMARY KEY("workspace_id","role_id","period"),
	CONSTRAINT "role_budgets_period" CHECK ("period" in ('day', 'week', 'month')),
	CONSTRAINT "role_budgets_limit_micros" CHECK ("limit_micros" > 0)
);
--> statement-breakpoint
DROP TABLE "budgets";--> statement-breakpoint
ALTER TABLE "budget_alerts" ADD COLUMN "period" text NOT NULL;--> statement-breakpoint
ALTER TABLE "budget_alerts" ADD COLUMN "starts_on" text NOT NULL;--> statement-breakpoint
ALTER TABLE "budget_alerts" DROP COLUMN "month";--> statement-breakpoint
ALTER TABLE "budget_alerts" ALTER COLUMN "member_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "role_budgets" ADD CONSTRAINT "role_budgets_HYlG1eUnteYw_fkey" FOREIGN KEY ("workspace_id","role_id") REFERENCES "workspace_roles"("workspace_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "budget_alerts" ADD CONSTRAINT "budget_alerts_period" CHECK ("period" in ('day', 'week', 'month'));