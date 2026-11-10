ALTER PUBLICATION "spyria_zero" DROP TABLE "runtime_hosts";--> statement-breakpoint
ALTER PUBLICATION "spyria_zero" ADD TABLE "runtime_hosts" ("workspace_id", "id", "name", "claim_expires_at", "status", "capacity", "running_runtimes", "host_version", "protocol_version", "last_seen_at", "created_by", "owner_id", "created_at", "removed_at");--> statement-breakpoint
ALTER PUBLICATION "spyria_zero" DROP TABLE "runtimes";--> statement-breakpoint
ALTER PUBLICATION "spyria_zero" ADD TABLE "runtimes" ("workspace_id", "chat_id", "id", "host_id", "state", "failure", "host_online", "image", "agent_version", "agent_protocol_version", "last_active_at", "created_at", "state_changed_at");
