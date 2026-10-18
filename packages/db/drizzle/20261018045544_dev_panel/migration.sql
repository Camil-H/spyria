DROP TABLE "changes";--> statement-breakpoint
DROP TABLE "commits";--> statement-breakpoint
DROP TABLE "files";--> statement-breakpoint
DROP TABLE "terminal_lines";--> statement-breakpoint
ALTER TABLE "runtimes" ADD COLUMN "workspace_snapshot" text;