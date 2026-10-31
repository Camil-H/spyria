ALTER TABLE "runtime_hosts" ADD COLUMN "host_version" text;--> statement-breakpoint
ALTER TABLE "runtime_hosts" ADD COLUMN "protocol_version" integer DEFAULT 0 NOT NULL;