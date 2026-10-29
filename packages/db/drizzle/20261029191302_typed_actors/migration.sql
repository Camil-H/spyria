ALTER TABLE "events" ADD COLUMN "actor_kind" text;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "on_behalf_of" text;--> statement-breakpoint
ALTER TABLE "workspace_events" ADD COLUMN "actor_kind" text;--> statement-breakpoint
ALTER TABLE "workspace_events" ADD COLUMN "on_behalf_of" text;--> statement-breakpoint
CREATE INDEX "workspace_events_on_behalf_of_index" ON "workspace_events" ("workspace_id","on_behalf_of","created_at");--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_actor_kind" CHECK ("actor_kind" in ('member', 'agent', 'system', 'integration'));--> statement-breakpoint
ALTER TABLE "workspace_events" ADD CONSTRAINT "workspace_events_actor_kind" CHECK ("actor_kind" in ('member', 'agent', 'system', 'integration'));--> statement-breakpoint
UPDATE "workspace_events" SET "actor_kind" = CASE WHEN "actor_id" IS NULL OR "actor_id" = 'operator' THEN 'system' ELSE 'member' END;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "reject_event_change"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  redacted_message_id text := CASE WHEN OLD.type = 'message.edited' THEN OLD.payload->>'messageId' ELSE OLD.id END;
BEGIN
  IF TG_OP = 'DELETE' AND OLD.workspace_id = current_setting('spyria.purging_workspace', true) AND EXISTS(
    SELECT 1 FROM workspaces WHERE workspace_id = OLD.workspace_id AND deleted_at IS NOT NULL AND purge_at <= now()
  ) THEN
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE'
    AND OLD.type IN ('message.posted', 'message.replied', 'message.edited')
    AND OLD.workspace_id || '/' || redacted_message_id = current_setting('spyria.redacting_message', true)
    AND NEW.workspace_id = OLD.workspace_id AND NEW.chat_id = OLD.chat_id AND NEW.id = OLD.id
    AND NEW.seq = OLD.seq AND NEW.type = OLD.type AND NEW.actor IS NOT DISTINCT FROM OLD.actor
    AND NEW.actor_kind IS NOT DISTINCT FROM OLD.actor_kind AND NEW.on_behalf_of IS NOT DISTINCT FROM OLD.on_behalf_of
    AND NEW.created_at = OLD.created_at
    AND NEW.payload = (OLD.payload - 'attachments') || '{"body": "", "redacted": true}'::jsonb
    AND EXISTS(
      SELECT 1 FROM messages WHERE workspace_id = OLD.workspace_id AND id = redacted_message_id
        AND deleted_at IS NOT NULL
    ) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'events are append-only: % rejected', TG_OP;
END
$$;
