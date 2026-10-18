CREATE TABLE "audit_settings" (
	"workspace_id" text PRIMARY KEY,
	"retention_days" integer,
	CONSTRAINT "audit_settings_retention_days" CHECK ("retention_days" between 1 and 36500)
);
--> statement-breakpoint
CREATE INDEX "events_audit_index" ON "events" ("workspace_id","created_at") WHERE "type" in ('member.invited', 'member.joined', 'member.role_changed', 'member.removed', 'member.left', 'chat.visibility_changed', 'chat.created', 'branch.pushed');--> statement-breakpoint
CREATE INDEX "events_pull_request_index" ON "events" ("workspace_id","created_at") WHERE "type" in ('message.posted', 'message.step_changed') and ("payload" -> 'step' ->> 'type') = 'pull_request';--> statement-breakpoint
CREATE INDEX "tool_calls_called_at_index" ON "tool_calls" ("workspace_id","called_at");--> statement-breakpoint
CREATE INDEX "tool_calls_prompter_index" ON "tool_calls" ("workspace_id","prompter_id","called_at");--> statement-breakpoint
CREATE INDEX "workspace_events_created_at_index" ON "workspace_events" ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "workspace_events_actor_index" ON "workspace_events" ("workspace_id","actor_id","created_at");--> statement-breakpoint
ALTER TABLE "audit_settings" ADD CONSTRAINT "audit_settings_workspace_id_workspaces_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("workspace_id");