CREATE INDEX "chats_workspace_id_owner_user_id_index" ON "chats" ("workspace_id","owner_user_id");--> statement-breakpoint
CREATE INDEX "delegations_workspace_id_chat_id_prompt_id_index" ON "delegations" ("workspace_id","chat_id","prompt_id") WHERE "status" = 'running';--> statement-breakpoint
CREATE INDEX "events_session_index" ON "events" ("workspace_id","chat_id","seq") WHERE "type" = 'agent.event' and (("payload" -> 'event' -> 'update' ->> 'sessionUpdate') in ('session_started', 'config_option_update') or ("payload" -> 'event' ->> 'key') = 'agent_state');--> statement-breakpoint
CREATE INDEX "messages_workspace_id_chat_id_seq_index" ON "messages" ("workspace_id","chat_id","seq" NULLS FIRST);--> statement-breakpoint
CREATE INDEX "messages_pull_request_index" ON "messages" ("workspace_id",("step" ->> 'repository'),("step" ->> 'number')) WHERE ("step" ->> 'type') = 'pull_request';--> statement-breakpoint
CREATE INDEX "runtimes_workspace_id_host_id_index" ON "runtimes" ("workspace_id","host_id");--> statement-breakpoint
ALTER TABLE "jobs" SET (autovacuum_vacuum_scale_factor = 0.01, autovacuum_analyze_scale_factor = 0.02);