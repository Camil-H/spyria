UPDATE "runtimes" SET "host_online" = true FROM "runtime_hosts" WHERE "runtime_hosts"."workspace_id" = "runtimes"."workspace_id" AND "runtime_hosts"."id" = "runtimes"."host_id" AND "runtime_hosts"."status" = 'online';--> statement-breakpoint
ALTER PUBLICATION "hq_zero" DROP TABLE "runtimes";--> statement-breakpoint
ALTER PUBLICATION "hq_zero" ADD TABLE "runtimes" ("workspace_id", "chat_id", "id", "host_id", "state", "failure", "host_online", "image", "last_active_at", "created_at", "state_changed_at");
