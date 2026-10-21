DROP INDEX "messages_workspace_id_reply_to_id_index";--> statement-breakpoint
CREATE INDEX "messages_workspace_id_reply_to_id_index" ON "messages" ("workspace_id","reply_to_id");--> statement-breakpoint
DROP INDEX "messages_workspace_id_thread_root_id_index";--> statement-breakpoint
CREATE INDEX "messages_workspace_id_thread_root_id_index" ON "messages" ("workspace_id","thread_root_id");