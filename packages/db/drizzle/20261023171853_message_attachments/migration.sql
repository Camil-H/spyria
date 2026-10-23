CREATE TABLE "message_attachments" (
	"workspace_id" text,
	"chat_id" text NOT NULL,
	"id" text,
	"uploader_id" text NOT NULL,
	"message_id" text,
	"name" text NOT NULL,
	"media_type" text NOT NULL,
	"size" integer NOT NULL,
	"content" bytea NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "message_attachments_pkey" PRIMARY KEY("workspace_id","id")
);
--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "attachments" jsonb DEFAULT '[]' NOT NULL;--> statement-breakpoint
CREATE INDEX "message_attachments_workspace_id_message_id_index" ON "message_attachments" ("workspace_id","message_id");--> statement-breakpoint
CREATE INDEX "message_attachments_workspace_id_uploader_id_created_at_index" ON "message_attachments" ("workspace_id","uploader_id","created_at") WHERE "message_id" is null;--> statement-breakpoint
ALTER TABLE "message_attachments" ADD CONSTRAINT "message_attachments_wUJlUhk27pLJ_fkey" FOREIGN KEY ("workspace_id","chat_id") REFERENCES "chats"("workspace_id","id");--> statement-breakpoint
ALTER TABLE "message_attachments" ADD CONSTRAINT "message_attachments_yBzSkfPwIAbL_fkey" FOREIGN KEY ("workspace_id","uploader_id") REFERENCES "memberships"("workspace_id","user_id");--> statement-breakpoint
ALTER TABLE "message_attachments" ADD CONSTRAINT "message_attachments_MpsSQJFxhMpn_fkey" FOREIGN KEY ("workspace_id","message_id") REFERENCES "messages"("workspace_id","id");