DELETE FROM "tool_connections";--> statement-breakpoint
ALTER TABLE "tool_connections" DROP CONSTRAINT "tool_connections_workspace_id_user_id_position_unique";--> statement-breakpoint
ALTER TABLE "tool_connections" ADD COLUMN "connection_id" text;--> statement-breakpoint
ALTER TABLE "workspace_connections" ADD COLUMN "sign_in" text DEFAULT 'shared' NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace_connections" ALTER COLUMN "sign_in" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "workspace_connections" ADD COLUMN "setup_id" text;--> statement-breakpoint
ALTER TABLE "tool_connections" DROP COLUMN "tool";--> statement-breakpoint
ALTER TABLE "tool_connections" DROP COLUMN "position";--> statement-breakpoint
ALTER TABLE "tool_connections" ADD PRIMARY KEY ("workspace_id","user_id","connection_id");--> statement-breakpoint
UPDATE "workspace_connections" AS "duplicate" SET "name" = "duplicate"."name" || ' (' || "duplicate"."id" || ')'
WHERE EXISTS (
  SELECT 1 FROM "workspace_connections" AS "kept"
  WHERE "kept"."workspace_id" = "duplicate"."workspace_id" AND "kept"."name" = "duplicate"."name" AND "kept"."id" < "duplicate"."id"
);--> statement-breakpoint
ALTER TABLE "workspace_connections" ADD CONSTRAINT "workspace_connections_workspace_id_name_unique" UNIQUE("workspace_id","name");--> statement-breakpoint
CREATE INDEX "tool_connections_workspace_id_connection_id_index" ON "tool_connections" ("workspace_id","connection_id");--> statement-breakpoint
ALTER TABLE "tool_connections" ADD CONSTRAINT "tool_connections_A08BI1hSPkpX_fkey" FOREIGN KEY ("workspace_id","connection_id") REFERENCES "workspace_connections"("workspace_id","id") ON DELETE CASCADE;
