CREATE FUNCTION "notify_sessions_ended"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "ended_sessions") THEN
    PERFORM pg_notify('sessions_ended', '');
  END IF;
  RETURN NULL;
END
$$;
--> statement-breakpoint
CREATE TRIGGER "sessions_ended" AFTER DELETE ON "sessions" REFERENCING OLD TABLE AS "ended_sessions" FOR EACH STATEMENT EXECUTE FUNCTION "notify_sessions_ended"();
