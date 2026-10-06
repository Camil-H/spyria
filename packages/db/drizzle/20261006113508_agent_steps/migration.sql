ALTER TABLE "messages" ADD COLUMN "step" jsonb;--> statement-breakpoint
UPDATE "messages" SET "kind" = 'step', "step" = jsonb_build_object('type', 'command', 'command', "body", 'exitCode', null, 'durationMilliseconds', null, 'output', coalesce("detail", ''), 'truncatedLines', 0) WHERE "kind" = 'tool-call';
