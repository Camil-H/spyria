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
--> statement-breakpoint
DO $$
DECLARE
  redacted record;
BEGIN
  FOR redacted IN
    SELECT workspace_id, id FROM events
    WHERE type IN ('message.posted', 'message.replied') AND payload->>'redacted' = 'true' AND payload->'attachments' IS NOT NULL
  LOOP
    PERFORM set_config('spyria.redacting_message', redacted.workspace_id || '/' || redacted.id, true);
    UPDATE events SET payload = (payload - 'attachments') || '{"body": "", "redacted": true}'::jsonb
    WHERE workspace_id = redacted.workspace_id AND id = redacted.id;
  END LOOP;
  PERFORM set_config('spyria.redacting_message', '', true);
END
$$;
