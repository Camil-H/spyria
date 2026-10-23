ALTER TABLE "workspaces" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "purge_at" timestamp with time zone;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "reject_event_change"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND OLD.workspace_id = current_setting('spyria.purging_workspace', true) AND EXISTS(
    SELECT 1 FROM workspaces WHERE workspace_id = OLD.workspace_id AND deleted_at IS NOT NULL AND purge_at <= now()
  ) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'events are append-only: % rejected', TG_OP;
END
$$;
