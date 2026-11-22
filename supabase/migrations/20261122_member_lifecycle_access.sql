BEGIN;
ALTER TABLE public.member ADD COLUMN IF NOT EXISTS lifecycle_state text NOT NULL DEFAULT 'active';
ALTER TABLE public.member ADD COLUMN IF NOT EXISTS lifecycle_generation bigint NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS member_lifecycle_operational_scope ON public.member(tenant_id,lifecycle_state,id);
CREATE UNIQUE INDEX IF NOT EXISTS member_lifecycle_record_member ON public.member_lifecycle_record(member_id);

-- The service-only record is authoritative; generic entity writes cannot
-- archive, restore or resurrect members by writing projection columns.
CREATE OR REPLACE FUNCTION public.guard_member_lifecycle_projection()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE v_state text; v_generation bigint;
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.lifecycle_state<>'active' OR NEW.lifecycle_generation<>0 THEN
      RAISE EXCEPTION 'Lifecycle projection is server managed' USING ERRCODE='42501';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.lifecycle_state IS NOT DISTINCT FROM OLD.lifecycle_state
    AND NEW.lifecycle_generation IS NOT DISTINCT FROM OLD.lifecycle_generation THEN RETURN NEW; END IF;
  IF pg_trigger_depth()<2 THEN
    RAISE EXCEPTION 'Lifecycle projection is server managed' USING ERRCODE='42501';
  END IF;
  SELECT r.state INTO v_state FROM public.member_lifecycle_record r WHERE r.member_id=NEW.id;
  v_generation:=OLD.lifecycle_generation + CASE
    WHEN OLD.lifecycle_state NOT IN ('archived','minimised','deleted')
      AND NEW.lifecycle_state IN ('archived','minimised','deleted') THEN 1 ELSE 0 END;
  IF NEW.lifecycle_state IS DISTINCT FROM v_state OR NEW.lifecycle_generation<>v_generation THEN
    RAISE EXCEPTION 'Invalid lifecycle projection' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS guard_member_lifecycle_projection ON public.member;
CREATE TRIGGER guard_member_lifecycle_projection BEFORE INSERT OR UPDATE ON public.member
  FOR EACH ROW EXECUTE FUNCTION public.guard_member_lifecycle_projection();

CREATE OR REPLACE FUNCTION public.project_member_lifecycle_access()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  UPDATE public.member SET lifecycle_state=NEW.state,
    lifecycle_generation=lifecycle_generation+CASE
      WHEN lifecycle_state NOT IN ('archived','minimised','deleted')
        AND NEW.state IN ('archived','minimised','deleted') THEN 1 ELSE 0 END
    WHERE id=NEW.member_id AND lifecycle_state IS DISTINCT FROM NEW.state
      AND COALESCE(tenant_id,(SELECT o.tenant_id FROM public.organization o WHERE o.id=organization_id))=NEW.tenant_id;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS project_member_lifecycle_access ON public.member_lifecycle_record;
CREATE TRIGGER project_member_lifecycle_access AFTER INSERT OR UPDATE OF state ON public.member_lifecycle_record
  FOR EACH ROW EXECUTE FUNCTION public.project_member_lifecycle_access();
REVOKE ALL ON FUNCTION public.guard_member_lifecycle_projection(),public.project_member_lifecycle_access()
  FROM PUBLIC,anon,authenticated,service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
