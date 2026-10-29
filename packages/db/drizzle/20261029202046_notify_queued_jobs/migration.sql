CREATE FUNCTION "notify_queued_job"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('jobs_queued', '');
  RETURN NULL;
END
$$;
--> statement-breakpoint
CREATE TRIGGER "jobs_queued" AFTER INSERT OR UPDATE OF "state", "run_at" ON "jobs" FOR EACH ROW WHEN (NEW."state" = 'queued' AND NEW."run_at" <= now()) EXECUTE FUNCTION "notify_queued_job"();
