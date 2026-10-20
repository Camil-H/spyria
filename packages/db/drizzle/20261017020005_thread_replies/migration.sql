CREATE TABLE "thread_read_markers" (
	"workspace_id" text,
	"chat_id" text NOT NULL,
	"user_id" text,
	"thread_root_id" text,
	"last_read_seq" integer NOT NULL,
	CONSTRAINT "thread_read_markers_pkey" PRIMARY KEY("workspace_id","user_id","thread_root_id")
);
--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "thread_root_id" text;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_3vmeRlAcBGif_fkey" FOREIGN KEY ("workspace_id","thread_root_id") REFERENCES "messages"("workspace_id","id");--> statement-breakpoint
ALTER TABLE "thread_read_markers" ADD CONSTRAINT "thread_read_markers_togPiyHMBi5U_fkey" FOREIGN KEY ("workspace_id","chat_id") REFERENCES "chats"("workspace_id","id");--> statement-breakpoint
ALTER TABLE "thread_read_markers" ADD CONSTRAINT "thread_read_markers_FzeOFqBMpoKT_fkey" FOREIGN KEY ("workspace_id","user_id") REFERENCES "memberships"("workspace_id","user_id");--> statement-breakpoint
ALTER TABLE "thread_read_markers" ADD CONSTRAINT "thread_read_markers_0MLRhzHVzBMC_fkey" FOREIGN KEY ("workspace_id","thread_root_id") REFERENCES "messages"("workspace_id","id");--> statement-breakpoint
ALTER PUBLICATION "spyria_zero" ADD TABLE "thread_read_markers";