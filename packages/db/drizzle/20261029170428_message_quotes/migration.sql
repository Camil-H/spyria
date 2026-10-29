ALTER TABLE "messages" ADD COLUMN "quoted_message_id" text;--> statement-breakpoint
CREATE INDEX "messages_workspace_id_quoted_message_id_index" ON "messages" ("workspace_id","quoted_message_id");--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_Ol4c5GLLZdnM_fkey" FOREIGN KEY ("workspace_id","quoted_message_id") REFERENCES "messages"("workspace_id","id");