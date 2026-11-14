CREATE TABLE "tool_disconnects" (
	"workspace_id" text,
	"user_id" text,
	"count" integer NOT NULL,
	CONSTRAINT "tool_disconnects_pkey" PRIMARY KEY("workspace_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "tool_disconnects" ADD CONSTRAINT "tool_disconnects_WpICaP0DQBb0_fkey" FOREIGN KEY ("workspace_id","user_id") REFERENCES "memberships"("workspace_id","user_id");