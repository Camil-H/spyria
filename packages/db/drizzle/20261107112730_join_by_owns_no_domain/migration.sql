CREATE FUNCTION refuse_domain_of_invited_workspace() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT join_by FROM workspaces WHERE workspace_id = NEW.workspace_id) = 'invited_address' THEN
    RAISE EXCEPTION 'workspace % joins by invited address and owns no email domain', NEW.workspace_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER sso_domains_only_for_domain_workspaces BEFORE INSERT OR UPDATE OF workspace_id ON sso_domains
  FOR EACH ROW EXECUTE FUNCTION refuse_domain_of_invited_workspace();--> statement-breakpoint
CREATE FUNCTION refuse_join_by_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.join_by <> OLD.join_by AND (
    EXISTS (SELECT 1 FROM memberships WHERE workspace_id = NEW.workspace_id AND user_id <> NEW.created_by)
    OR EXISTS (SELECT 1 FROM sso_domains WHERE workspace_id = NEW.workspace_id)) THEN
    RAISE EXCEPTION 'who can join workspace % is chosen at its creation', NEW.workspace_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_join_by_known" CHECK ("join_by" IN ('domain', 'invited_address'));--> statement-breakpoint
CREATE TRIGGER workspaces_join_by_fixed BEFORE UPDATE OF join_by ON workspaces
  FOR EACH ROW EXECUTE FUNCTION refuse_join_by_change();
