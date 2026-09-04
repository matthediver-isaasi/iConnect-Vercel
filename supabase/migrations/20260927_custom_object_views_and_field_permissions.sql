-- Presentation metadata remains in the existing JSONB configuration columns.
-- This additive migration supplies durable, role-scoped field access controls.

CREATE TABLE IF NOT EXISTS public.custom_object_field_role_permission (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenant(id) ON DELETE CASCADE,
  custom_object_id uuid NOT NULL,
  field_id uuid NOT NULL,
  role_id uuid NOT NULL REFERENCES public.role(id) ON DELETE CASCADE,
  access_level varchar(10) NOT NULL,
  created_by text,
  updated_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT custom_object_field_role_permission_access_check
    CHECK (access_level IN ('none', 'read', 'edit')),
  CONSTRAINT custom_object_field_role_permission_object_tenant_fk
    FOREIGN KEY (tenant_id, custom_object_id)
    REFERENCES public.custom_object_definition(tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT custom_object_field_role_permission_field_tenant_fk
    FOREIGN KEY (tenant_id, field_id)
    REFERENCES public.preference_field(tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT custom_object_field_role_permission_unique
    UNIQUE (tenant_id, custom_object_id, field_id, role_id)
);

CREATE INDEX IF NOT EXISTS idx_custom_object_field_role_permission_tenant_role_object
  ON public.custom_object_field_role_permission (tenant_id, role_id, custom_object_id, field_id);

CREATE OR REPLACE FUNCTION public.guard_custom_object_field_role_permission()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.preference_field field
    WHERE field.id = NEW.field_id
      AND field.tenant_id = NEW.tenant_id
      AND field.custom_object_id = NEW.custom_object_id
      AND field.entity_scope = 'custom_object'
  ) THEN
    RAISE EXCEPTION 'Field permission must belong to the same Custom Object and tenant'
      USING ERRCODE = '23503',
        CONSTRAINT = 'custom_object_field_role_permission_field_owner';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS custom_object_field_role_permission_guard_trigger
  ON public.custom_object_field_role_permission;
CREATE TRIGGER custom_object_field_role_permission_guard_trigger
  BEFORE INSERT OR UPDATE ON public.custom_object_field_role_permission
  FOR EACH ROW EXECUTE FUNCTION public.guard_custom_object_field_role_permission();

ALTER TABLE public.custom_object_field_role_permission ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.custom_object_field_role_permission FROM anon, authenticated;
DROP POLICY IF EXISTS custom_object_field_role_permission_service_role
  ON public.custom_object_field_role_permission;
CREATE POLICY custom_object_field_role_permission_service_role
  ON public.custom_object_field_role_permission
  FOR ALL TO service_role USING (true) WITH CHECK (true);

NOTIFY pgrst, 'reload schema';