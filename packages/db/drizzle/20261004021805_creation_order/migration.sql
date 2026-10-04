ALTER TABLE "chats" ADD COLUMN "created_at" timestamp with time zone NOT NULL DEFAULT now();--> statement-breakpoint
ALTER TABLE "chats" ALTER COLUMN "created_at" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "created_at" timestamp with time zone NOT NULL DEFAULT now();--> statement-breakpoint
ALTER TABLE "projects" ALTER COLUMN "created_at" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "created_at" timestamp with time zone NOT NULL DEFAULT now();--> statement-breakpoint
ALTER TABLE "workspaces" ALTER COLUMN "created_at" DROP DEFAULT;
