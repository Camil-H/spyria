ALTER TABLE "browser_pages" ADD COLUMN "opened_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "browser_pages" ALTER COLUMN "opened_at" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "browser_pages" DROP COLUMN "body_text";
