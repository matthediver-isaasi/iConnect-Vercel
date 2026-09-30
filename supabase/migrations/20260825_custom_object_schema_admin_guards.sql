-- Additive guards for installations that already applied the Custom Object
-- foundation migration before schema administration was introduced.

CREATE OR REPLACE FUNCTION public.guard_custom_object_schema_admin_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF OLD.status = 'active' AND NEW.status = 'draft' THEN
    RAISE EXCEPTION 'Active Custom Objects cannot return to draft'
      USING ERRCODE = '23514',
        CONSTRAINT = 'custom_object_definition_active_not_draft';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS custom_object_schema_admin_lifecycle_trigger
  ON public.custom_object_definition;
CREATE TRIGGER custom_object_schema_admin_lifecycle_trigger
  BEFORE UPDATE OF status ON public.custom_object_definition
  FOR EACH ROW EXECUTE FUNCTION public.guard_custom_object_schema_admin_lifecycle();

CREATE OR REPLACE FUNCTION public.classify_custom_object_audit_actor()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.actor_id LIKE 'tenant_user:%' THEN
    NEW.actor_type := 'tenant_user';
    NEW.actor_id := substring(NEW.actor_id FROM char_length('tenant_user:') + 1);
  ELSIF NEW.actor_id LIKE 'member:%' THEN
    NEW.actor_type := 'member';
    NEW.actor_id := substring(NEW.actor_id FROM char_length('member:') + 1);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS custom_object_audit_actor_type_trigger
  ON public.custom_object_audit_event;
CREATE TRIGGER custom_object_audit_actor_type_trigger
  BEFORE INSERT ON public.custom_object_audit_event
  FOR EACH ROW EXECUTE FUNCTION public.classify_custom_object_audit_actor();

REVOKE ALL ON FUNCTION public.guard_custom_object_schema_admin_lifecycle()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.classify_custom_object_audit_actor()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.guard_custom_object_schema_admin_lifecycle()
  TO service_role;
GRANT EXECUTE ON FUNCTION public.classify_custom_object_audit_actor()
  TO service_role;