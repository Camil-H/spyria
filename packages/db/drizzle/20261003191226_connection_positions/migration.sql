ALTER TABLE "tool_connections" ADD COLUMN "position" integer NOT NULL DEFAULT 0;--> statement-breakpoint
ALTER TABLE "tool_connections" ALTER COLUMN "position" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "workspace_connections" ADD COLUMN "position" integer NOT NULL DEFAULT 0;--> statement-breakpoint
ALTER TABLE "workspace_connections" ALTER COLUMN "position" DROP DEFAULT;
