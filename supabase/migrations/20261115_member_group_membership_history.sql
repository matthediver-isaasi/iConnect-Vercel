-- Authoritative forward-only history. Run in ONE transaction (runner enforces it).
-- No assignment timestamp/activity log is treated as historical evidence.
-- Source-table locks cover snapshot + trigger installation, including concurrent
-- automatic reconciliation and cascades. No FKs intentionally: history survives
-- member/group/assignment deletion. Only service_role may read this data.
SET LOCAL timezone = 'UTC';
LOCK TABLE public.member, public.member_group, public.member_group_assignment
  IN SHARE ROW EXCLUSIVE MODE;

CREATE TABLE IF NOT EXISTS public.member_group_history_baseline (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  started_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS public.member_group_history_group (
  tenant_id uuid NOT NULL,
  group_id uuid NOT NULL,
  name text,
  is_active boolean,
  deleted_at timestamptz,
  PRIMARY KEY (tenant_id, group_id)
);
CREATE TABLE IF NOT EXISTS public.member_group_membership_history (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL,
  assignment_id uuid NOT NULL,
  group_id uuid NOT NULL,
  member_id uuid NOT NULL,
  role text,
  group_name text,
  valid_from timestamptz NOT NULL,
  valid_until timestamptz,
  is_baseline boolean NOT NULL DEFAULT false,
  source_open boolean NOT NULL DEFAULT true,
  CHECK (valid_until IS NULL OR valid_until >= valid_from)
);
CREATE UNIQUE INDEX IF NOT EXISTS member_group_history_open_assignment
  ON public.member_group_membership_history(assignment_id) WHERE source_open;
CREATE INDEX IF NOT EXISTS member_group_history_tenant_period
  ON public.member_group_membership_history(tenant_id, valid_from, valid_until);
CREATE INDEX IF NOT EXISTS member_group_history_pair_period
  ON public.member_group_membership_history(tenant_id, group_id, member_id, valid_from);

DO $$
DECLARE v_at timestamptz;
BEGIN
  INSERT INTO public.member_group_history_baseline(singleton, started_at)
    VALUES (true, clock_timestamp()) ON CONFLICT DO NOTHING
    RETURNING started_at INTO v_at;
  IF v_at IS NOT NULL THEN
    INSERT INTO public.member_group_history_group(tenant_id, group_id, name, is_active)
      SELECT tenant_id, id, name, is_active FROM public.member_group WHERE tenant_id IS NOT NULL;
    INSERT INTO public.member_group_membership_history
      (tenant_id, assignment_id, group_id, member_id, role, group_name,
       valid_from, valid_until, is_baseline)
      SELECT a.tenant_id, a.id, a.group_id, a.member_id, a.group_role, g.name,
        v_at, a.expires_at::timestamptz, true
      FROM public.member_group_assignment a
      JOIN public.member_group g ON g.id = a.group_id AND g.tenant_id = a.tenant_id
      JOIN public.member m ON m.id = a.member_id AND m.tenant_id = a.tenant_id
      WHERE a.guest_id IS NULL
        AND (a.expires_at IS NULL OR a.expires_at::timestamptz > v_at);
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.capture_member_group_assignment_history()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp SET timezone = 'UTC'
AS $$
DECLARE v_at timestamptz := clock_timestamp();
BEGIN
  IF TG_OP = 'UPDATE' AND
    ROW(NEW.id, NEW.tenant_id, NEW.group_id, NEW.member_id, NEW.guest_id, NEW.group_role, NEW.expires_at)
    IS NOT DISTINCT FROM
    ROW(OLD.id, OLD.tenant_id, OLD.group_id, OLD.member_id, OLD.guest_id, OLD.group_role, OLD.expires_at)
  THEN RETURN NEW; END IF;
  IF TG_OP <> 'INSERT' THEN
    UPDATE public.member_group_membership_history
    SET valid_until = GREATEST(valid_from, LEAST(valid_until, v_at)), source_open = false
    WHERE assignment_id = OLD.id AND source_open;
  END IF;
  IF TG_OP <> 'DELETE' AND NEW.member_id IS NOT NULL AND NEW.guest_id IS NULL
     AND (NEW.expires_at IS NULL OR NEW.expires_at::timestamptz > v_at) THEN
    INSERT INTO public.member_group_membership_history
      (tenant_id, assignment_id, group_id, member_id, role, group_name, valid_from, valid_until)
    SELECT NEW.tenant_id, NEW.id, NEW.group_id, NEW.member_id, NEW.group_role,
      g.name, v_at, NEW.expires_at::timestamptz
    FROM public.member_group g JOIN public.member m
      ON m.id = NEW.member_id AND m.tenant_id = NEW.tenant_id
    WHERE g.id = NEW.group_id AND g.tenant_id = NEW.tenant_id;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.capture_member_group_identity_history()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_at timestamptz := clock_timestamp();
BEGIN
  IF TG_OP = 'DELETE' THEN
    UPDATE public.member_group_history_group SET deleted_at = v_at
      WHERE tenant_id = OLD.tenant_id AND group_id = OLD.id;
    UPDATE public.member_group_membership_history
      SET valid_until = GREATEST(valid_from, LEAST(valid_until, v_at)), source_open = false
      WHERE tenant_id = OLD.tenant_id AND group_id = OLD.id AND source_open;
    RETURN OLD;
  END IF;
  INSERT INTO public.member_group_history_group(tenant_id, group_id, name, is_active)
    VALUES (NEW.tenant_id, NEW.id, NEW.name, NEW.is_active)
    ON CONFLICT (tenant_id, group_id) DO UPDATE
      SET name = EXCLUDED.name, is_active = EXCLUDED.is_active, deleted_at = NULL;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.close_deleted_member_group_history()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  UPDATE public.member_group_membership_history
    SET valid_until = GREATEST(valid_from, LEAST(valid_until, clock_timestamp())), source_open = false
    WHERE tenant_id = OLD.tenant_id AND member_id = OLD.id AND source_open;
  RETURN OLD;
END $$;

DROP TRIGGER IF EXISTS member_group_assignment_history ON public.member_group_assignment;
CREATE TRIGGER member_group_assignment_history AFTER INSERT OR UPDATE OR DELETE
  ON public.member_group_assignment FOR EACH ROW
  EXECUTE FUNCTION public.capture_member_group_assignment_history();
DROP TRIGGER IF EXISTS member_group_identity_history ON public.member_group;
CREATE TRIGGER member_group_identity_history BEFORE INSERT OR UPDATE OR DELETE
  ON public.member_group FOR EACH ROW EXECUTE FUNCTION public.capture_member_group_identity_history();
DROP TRIGGER IF EXISTS member_group_member_delete_history ON public.member;
CREATE TRIGGER member_group_member_delete_history BEFORE DELETE
  ON public.member FOR EACH ROW EXECUTE FUNCTION public.close_deleted_member_group_history();

ALTER TABLE public.member_group_history_baseline ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.member_group_history_group ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.member_group_membership_history ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.member_group_history_baseline, public.member_group_history_group,
  public.member_group_membership_history FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON SEQUENCE public.member_group_membership_history_id_seq
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.member_group_history_baseline, public.member_group_history_group,
  public.member_group_membership_history TO service_role;
-- Explicit policy also supports service roles without BYPASSRLS in isolated DBs.
DROP POLICY IF EXISTS service_read ON public.member_group_history_baseline;
CREATE POLICY service_read ON public.member_group_history_baseline FOR SELECT TO service_role USING (true);
DROP POLICY IF EXISTS service_read ON public.member_group_history_group;
CREATE POLICY service_read ON public.member_group_history_group FOR SELECT TO service_role USING (true);
DROP POLICY IF EXISTS service_read ON public.member_group_membership_history;
CREATE POLICY service_read ON public.member_group_membership_history FOR SELECT TO service_role USING (true);
REVOKE ALL ON FUNCTION public.capture_member_group_assignment_history(),
  public.capture_member_group_identity_history(), public.close_deleted_member_group_history()
  FROM PUBLIC, anon, authenticated, service_role;