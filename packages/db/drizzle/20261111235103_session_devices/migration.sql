ALTER TABLE "sessions" ADD COLUMN "user_agent" text DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE INDEX "sessions_member_index" ON "sessions" ("workspace_id","user_id");