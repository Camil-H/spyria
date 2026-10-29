CREATE TABLE "machine_counts" (
	"workspace_id" text PRIMARY KEY,
	"machines" integer NOT NULL,
	"claude_code" integer NOT NULL,
	"codex" integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE "machine_counts" ADD CONSTRAINT "machine_counts_workspace_id_workspaces_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("workspace_id");--> statement-breakpoint
INSERT INTO "machine_counts" ("workspace_id", "machines", "claude_code", "codex")
SELECT "workspace_id", count(*),
  count(*) FILTER (WHERE "capacity"->'signedIn' ? 'claude-code'),
  count(*) FILTER (WHERE "capacity"->'signedIn' ? 'codex')
FROM "runtime_hosts"
WHERE "owner_id" IS NOT NULL AND "removed_at" IS NULL
GROUP BY "workspace_id";--> statement-breakpoint
ALTER PUBLICATION "spyria_zero" ADD TABLE "machine_counts";
