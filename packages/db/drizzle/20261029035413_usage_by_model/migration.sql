DELETE FROM "usage_entries";--> statement-breakpoint
ALTER TABLE "usage_entries" ADD COLUMN "model" text NOT NULL;--> statement-breakpoint
ALTER TABLE "usage_entries" DROP CONSTRAINT "usage_entries_pkey";--> statement-breakpoint
ALTER TABLE "usage_entries" ADD PRIMARY KEY ("workspace_id","month","chat_id","user_id","model");--> statement-breakpoint
INSERT INTO "usage_entries" ("workspace_id", "month", "chat_id", "user_id", "model", "tokens", "cost_micros", "calls")
SELECT "workspace_id", to_char("called_at" at time zone 'UTC', 'YYYY-MM'), "chat_id", "prompter_id",
  "provider" || '/' || "model", sum("input_tokens" + "output_tokens"), sum("cost_micros"), count(*)
FROM "model_calls"
WHERE exists (SELECT 1 FROM "chats" WHERE "chats"."workspace_id" = "model_calls"."workspace_id" AND "chats"."id" = "model_calls"."chat_id")
  AND exists (SELECT 1 FROM "memberships"
    WHERE "memberships"."workspace_id" = "model_calls"."workspace_id" AND "memberships"."user_id" = "model_calls"."prompter_id")
GROUP BY 1, 2, 3, 4, 5;
