CREATE TABLE "deleted_message_texts" (
	"workspace_id" text,
	"chat_id" text NOT NULL,
	"message_id" text,
	"body" text NOT NULL,
	"deleted_by" text NOT NULL,
	"deleted_at" timestamp with time zone NOT NULL,
	CONSTRAINT "deleted_message_texts_pkey" PRIMARY KEY("workspace_id","message_id")
);
--> statement-breakpoint
CREATE INDEX "deleted_message_texts_workspace_id_deleted_at_index" ON "deleted_message_texts" ("workspace_id","deleted_at");--> statement-breakpoint
ALTER TABLE "deleted_message_texts" ADD CONSTRAINT "deleted_message_texts_tTgfAVYRSxoB_fkey" FOREIGN KEY ("workspace_id","chat_id") REFERENCES "chats"("workspace_id","id");--> statement-breakpoint
ALTER TABLE "deleted_message_texts" ADD CONSTRAINT "deleted_message_texts_3Nx86RU1h2UM_fkey" FOREIGN KEY ("workspace_id","deleted_by") REFERENCES "memberships"("workspace_id","user_id");