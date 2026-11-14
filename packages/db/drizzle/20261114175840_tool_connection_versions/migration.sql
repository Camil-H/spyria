CREATE TABLE "tool_connection_versions" (
	"workspace_id" text,
	"user_id" text,
	"version" integer NOT NULL,
	CONSTRAINT "tool_connection_versions_pkey" PRIMARY KEY("workspace_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "tool_connection_versions" ADD CONSTRAINT "tool_connection_versions_qggCdC8YhMeJ_fkey" FOREIGN KEY ("workspace_id","user_id") REFERENCES "memberships"("workspace_id","user_id");