CREATE FUNCTION "notify_sessions_ended"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('sessions_ended', '');
  RETURN NULL;
END
$$;
--> statement-breakpoint
CREATE TRIGGER "sessions_ended" AFTER DELETE ON "sessions" FOR EACH STATEMENT EXECUTE FUNCTION "notify_sessions_ended"();
