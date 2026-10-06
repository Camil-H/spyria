ALTER TABLE "chats" ADD COLUMN "agent_turn_message_id" text;--> statement-breakpoint
ALTER TABLE "runtimes" ADD COLUMN "llm_token_ref" text;--> statement-breakpoint
ALTER TABLE "runtimes" ADD COLUMN "agent_conversation_id" text;