CREATE FUNCTION "reject_event_change"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'events are append-only: % rejected', TG_OP;
END
$$;
--> statement-breakpoint
CREATE TRIGGER "events_append_only" BEFORE UPDATE OR DELETE ON "events" FOR EACH ROW EXECUTE FUNCTION "reject_event_change"();
