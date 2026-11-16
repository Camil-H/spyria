ALTER TABLE "chats" ADD COLUMN "agent_turn_reply_to_id" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "picked_up_at" timestamp with time zone;