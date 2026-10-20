ALTER TABLE "runtime_hosts" ADD COLUMN "owner_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "runtime_hosts_one_machine_per_member" ON "runtime_hosts" ("workspace_id","owner_id") WHERE "removed_at" is null;--> statement-breakpoint
ALTER TABLE "runtime_hosts" ADD CONSTRAINT "runtime_hosts_J8opGRJBt3iQ_fkey" FOREIGN KEY ("workspace_id","owner_id") REFERENCES "memberships"("workspace_id","user_id");--> statement-breakpoint
ALTER PUBLICATION "spyria_zero" DROP TABLE "runtime_hosts";--> statement-breakpoint
ALTER PUBLICATION "spyria_zero" ADD TABLE "runtime_hosts" ("workspace_id", "id", "name", "claim_expires_at", "status", "capacity", "running_runtimes", "last_seen_at", "created_by", "owner_id", "created_at", "removed_at");
