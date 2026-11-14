ALTER TABLE "jobs" ADD COLUMN "serial_key" text;--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_one_queued_per_serial_key" ON "jobs" ("workspace_id","serial_key") WHERE "serial_key" is not null and "state" = 'queued';--> statement-breakpoint
CREATE INDEX "jobs_running_serial_key" ON "jobs" ("workspace_id","serial_key") WHERE "serial_key" is not null and "state" = 'running';