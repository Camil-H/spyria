CREATE TABLE "member_sign_outs" (
	"workspace_id" text,
	"user_id" text,
	"signed_out_at" timestamp with time zone NOT NULL,
	CONSTRAINT "member_sign_outs_pkey" PRIMARY KEY("workspace_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "member_sign_outs" ADD CONSTRAINT "member_sign_outs_GwJWlPHZNmDw_fkey" FOREIGN KEY ("workspace_id","user_id") REFERENCES "memberships"("workspace_id","user_id") ON DELETE CASCADE;