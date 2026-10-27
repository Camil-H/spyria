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
    AND NEW.payload = OLD.payload || '{"body": "", "redacted": true}'::jsonb
    AND EXISTS(
      SELECT 1 FROM messages WHERE workspace_id = OLD.workspace_id AND id = redacted_message_id
        AND deleted_at IS NOT NULL
    ) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'events are append-only: % rejected', TG_OP;
END
$$;
