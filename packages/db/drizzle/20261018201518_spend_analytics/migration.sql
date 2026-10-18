ALTER TABLE "model_calls" ADD COLUMN "turn_id" text;--> statement-breakpoint
ALTER TABLE "model_calls" ADD COLUMN "session_id" text;--> statement-breakpoint
CREATE INDEX "model_calls_prompter_index" ON "model_calls" ("workspace_id","prompter_id","called_at");--> statement-breakpoint
CREATE INDEX "model_calls_chat_index" ON "model_calls" ("workspace_id","chat_id","called_at");