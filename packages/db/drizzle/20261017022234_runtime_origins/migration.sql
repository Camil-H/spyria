CREATE TABLE "runtime_origins" (
	"workspace_id" text,
	"chat_id" text NOT NULL,
	"runtime_chat_id" text,
	"message_id" text NOT NULL,
	"started_by" text NOT NULL,
	CONSTRAINT "runtime_origins_pkey" PRIMARY KEY("workspace_id","runtime_chat_id")
);
--> statement-breakpoint
ALTER TABLE "runtime_origins" ADD CONSTRAINT "runtime_origins_workspace_id_chat_id_chats_workspace_id_id_fkey" FOREIGN KEY ("workspace_id","chat_id") REFERENCES "chats"("workspace_id","id");--> statement-breakpoint
ALTER TABLE "runtime_origins" ADD CONSTRAINT "runtime_origins_LxTF6TU0R9qs_fkey" FOREIGN KEY ("workspace_id","runtime_chat_id") REFERENCES "chats"("workspace_id","id");--> statement-breakpoint
ALTER TABLE "runtime_origins" ADD CONSTRAINT "runtime_origins_6xs8QR0CnyyT_fkey" FOREIGN KEY ("workspace_id","message_id") REFERENCES "messages"("workspace_id","id");--> statement-breakpoint
ALTER TABLE "runtime_origins" ADD CONSTRAINT "runtime_origins_X9y7yxzzCq2c_fkey" FOREIGN KEY ("workspace_id","started_by") REFERENCES "memberships"("workspace_id","user_id");--> statement-breakpoint
ALTER PUBLICATION "spyria_zero" ADD TABLE "runtime_origins";