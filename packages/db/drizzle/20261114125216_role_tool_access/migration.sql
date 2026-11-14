DELETE FROM "connection_access" WHERE "user_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "connection_access" DROP CONSTRAINT "connection_access_f7TgzULFd5vz_fkey";--> statement-breakpoint
ALTER TABLE "connection_access" DROP CONSTRAINT "connection_access_subject";--> statement-breakpoint
ALTER TABLE "connection_access" DROP CONSTRAINT "connection_access_pkey";--> statement-breakpoint
DROP INDEX "connection_access_workspace_id_user_id_index";--> statement-breakpoint
ALTER TABLE "connection_access" DROP COLUMN "id";--> statement-breakpoint
ALTER TABLE "connection_access" DROP COLUMN "user_id";--> statement-breakpoint
ALTER TABLE "connection_access" ALTER COLUMN "role_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "connection_access" ADD PRIMARY KEY ("workspace_id","connection_id","role_id");
