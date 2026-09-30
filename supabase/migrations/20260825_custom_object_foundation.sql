-- Tenant-safe Custom Object metadata and generic record storage.
-- Core Member, Organisation, and Organisation Group preference-value tables
-- remain unchanged; Custom Object record values live in JSONB.

CREATE TABLE IF NOT EXISTS public.custom_object_definition (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenant(id) ON DELETE CASCADE,
  object_key varchar(100) NOT NULL,
  singular_label varchar(255) NOT NULL,
  plural_label varchar(255) NOT NULL,
  description text,
  icon varchar(100),
  primary_display_field_id uuid,
  status varchar(20) NOT NULL DEFAULT 'draft',
  configuration jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by text,
  updated_by text,
  archived_at timestamptz,
  archived_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT custom_object_definition_key_format
    CHECK (object_key ~ '^[a-z][a-z0-9_]{0,99}$'),
  CONSTRAINT custom_object_definition_status_check
    CHECK (status IN ('draft', 'active', 'archived')),
  CONSTRAINT custom_object_definition_configuration_object
    CHECK (jsonb_typeof(configuration) = 'object'),
  CONSTRAINT custom_object_definition_archive_state
    CHECK (
      (status = 'archived' AND archived_at IS NOT NULL)
      OR (status <> 'archived' AND archived_at IS NULL AND archived_by IS NULL)
    ),
  CONSTRAINT custom_object_definition_tenant_key_unique
    UNIQUE (tenant_id, object_key),
  CONSTRAINT custom_object_definition_tenant_id_unique
    UNIQUE (tenant_id, id)
);

CREATE INDEX IF NOT EXISTS idx_custom_object_definition_tenant_status
  ON public.custom_object_definition (tenant_id, status, object_key);
CREATE UNIQUE INDEX IF NOT EXISTS custom_object_definition_active_tenant_label_unique
  ON public.custom_object_definition (tenant_id, lower(singular_label))
  WHERE status <> 'archived';

-- Extend the existing field-definition source of truth. Core scopes continue
-- to use NULL custom_object_id and retain tenant-wide key uniqueness.
ALTER TABLE public.preference_field
  ADD COLUMN IF NOT EXISTS custom_object_id uuid;
ALTER TABLE public.preference_field
  ADD COLUMN IF NOT EXISTS created_by text;
ALTER TABLE public.preference_field
  ADD COLUMN IF NOT EXISTS updated_by text;

ALTER TABLE public.preference_field
  DROP CONSTRAINT IF EXISTS preference_field_entity_scope_check;

ALTER TABLE public.preference_field
  ADD CONSTRAINT preference_field_entity_scope_check
  CHECK ((entity_scope)::text = ANY (ARRAY[
    'member'::text,
    'organization'::text,
    'organization_group'::text,
    'custom_object'::text
  ]));

-- Keep the database contract aligned with the existing Custom Fields editor.
-- long_text remains accepted for legacy core rows that predate textarea.
ALTER TABLE public.preference_field
  DROP CONSTRAINT IF EXISTS preference_field_field_type_check;

ALTER TABLE public.preference_field
  ADD CONSTRAINT preference_field_field_type_check
  CHECK ((field_type)::text = ANY (ARRAY[
    'text'::text,
    'textarea'::text,
    'long_text'::text,
    'email'::text,
    'url'::text,
    'date'::text,
    'boolean'::text,
    'number'::text,
    'decimal'::text,
    'picklist'::text,
    'dropdown'::text,
    'country'::text,
    'countries'::text,
    'list'::text,
    'file'::text
  ]));

ALTER TABLE public.preference_field
  DROP CONSTRAINT IF EXISTS preference_field_tenant_name_unique;
ALTER TABLE public.preference_field
  DROP CONSTRAINT IF EXISTS preference_field_name_key;

CREATE UNIQUE INDEX IF NOT EXISTS preference_field_core_tenant_name_unique
  ON public.preference_field (tenant_id, name)
  WHERE custom_object_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS preference_field_object_tenant_name_unique
  ON public.preference_field (tenant_id, custom_object_id, name)
  WHERE custom_object_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS preference_field_tenant_id_unique
  ON public.preference_field (tenant_id, id);

CREATE INDEX IF NOT EXISTS idx_preference_field_tenant_custom_object
  ON public.preference_field (tenant_id, custom_object_id, is_active, display_order)
  WHERE custom_object_id IS NOT NULL;

ALTER TABLE public.preference_field
  DROP CONSTRAINT IF EXISTS preference_field_custom_object_ownership_check;

ALTER TABLE public.preference_field
  ADD CONSTRAINT preference_field_custom_object_ownership_check
  CHECK (
    (entity_scope = 'custom_object' AND custom_object_id IS NOT NULL)
    OR (entity_scope <> 'custom_object' AND custom_object_id IS NULL)
  );

ALTER TABLE public.preference_field
  DROP CONSTRAINT IF EXISTS preference_field_custom_object_tenant_fk;

ALTER TABLE public.preference_field
  ADD CONSTRAINT preference_field_custom_object_tenant_fk
  FOREIGN KEY (tenant_id, custom_object_id)
  REFERENCES public.custom_object_definition(tenant_id, id)
  ON DELETE CASCADE;

-- A composite FK back from the object to its primary preference field would
-- create a delete cycle (field -> object and object -> field). The trigger
-- below enforces tenant, object, scope, and active-state ownership instead.

CREATE TABLE IF NOT EXISTS public.custom_object_record (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenant(id) ON DELETE CASCADE,
  custom_object_id uuid NOT NULL,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by text,
  updated_by text,
  archived_at timestamptz,
  archived_by text,
  archive_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT custom_object_record_data_object
    CHECK (jsonb_typeof(data) = 'object'),
  CONSTRAINT custom_object_record_archive_state
    CHECK (
      (archived_at IS NULL AND archived_by IS NULL AND archive_reason IS NULL)
      OR archived_at IS NOT NULL
    ),
  CONSTRAINT custom_object_record_object_tenant_fk
    FOREIGN KEY (tenant_id, custom_object_id)
    REFERENCES public.custom_object_definition(tenant_id, id)
    ON DELETE CASCADE,
  CONSTRAINT custom_object_record_tenant_id_unique
    UNIQUE (tenant_id, id)
);

CREATE INDEX IF NOT EXISTS idx_custom_object_record_tenant_object_active
  ON public.custom_object_record (tenant_id, custom_object_id, id)
  WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_custom_object_record_tenant_object_archived
  ON public.custom_object_record (tenant_id, custom_object_id, archived_at)
  WHERE archived_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_custom_object_record_data_gin
  ON public.custom_object_record USING gin (data);

CREATE TABLE IF NOT EXISTS public.custom_object_relationship_definition (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenant(id) ON DELETE CASCADE,
  relationship_key varchar(100) NOT NULL,
  source_kind varchar(30) NOT NULL,
  source_custom_object_id uuid,
  target_kind varchar(30) NOT NULL,
  target_custom_object_id uuid,
  cardinality varchar(30) NOT NULL,
  source_label varchar(255) NOT NULL,
  target_label varchar(255) NOT NULL,
  is_required boolean NOT NULL DEFAULT false,
  show_on_source boolean NOT NULL DEFAULT true,
  show_on_target boolean NOT NULL DEFAULT true,
  edit_from_source boolean NOT NULL DEFAULT true,
  edit_from_target boolean NOT NULL DEFAULT false,
  status varchar(20) NOT NULL DEFAULT 'draft',
  configuration jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by text,
  updated_by text,
  archived_at timestamptz,
  archived_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT custom_object_relationship_definition_key_format
    CHECK (relationship_key ~ '^[a-z][a-z0-9_]{0,99}$'),
  CONSTRAINT custom_object_relationship_definition_source_kind
    CHECK (source_kind IN ('member', 'organization', 'organization_group', 'custom_object')),
  CONSTRAINT custom_object_relationship_definition_target_kind
    CHECK (target_kind IN ('member', 'organization', 'organization_group', 'custom_object')),
  CONSTRAINT custom_object_relationship_definition_source_owner
    CHECK (
      (source_kind = 'custom_object' AND source_custom_object_id IS NOT NULL)
      OR (source_kind <> 'custom_object' AND source_custom_object_id IS NULL)
    ),
  CONSTRAINT custom_object_relationship_definition_target_owner
    CHECK (
      (target_kind = 'custom_object' AND target_custom_object_id IS NOT NULL)
      OR (target_kind <> 'custom_object' AND target_custom_object_id IS NULL)
    ),
  CONSTRAINT custom_object_relationship_definition_cardinality
    CHECK (cardinality IN ('one_to_one', 'one_to_many', 'many_to_one', 'many_to_many')),
  CONSTRAINT custom_object_relationship_definition_status
    CHECK (status IN ('draft', 'active', 'archived')),
  CONSTRAINT custom_object_relationship_definition_configuration
    CHECK (jsonb_typeof(configuration) = 'object'),
  CONSTRAINT custom_object_relationship_definition_archive_state
    CHECK (
      (status = 'archived' AND archived_at IS NOT NULL)
      OR (status <> 'archived' AND archived_at IS NULL AND archived_by IS NULL)
    ),
  CONSTRAINT custom_object_relationship_definition_source_tenant_fk
    FOREIGN KEY (tenant_id, source_custom_object_id)
    REFERENCES public.custom_object_definition(tenant_id, id)
    ON DELETE CASCADE,
  CONSTRAINT custom_object_relationship_definition_target_tenant_fk
    FOREIGN KEY (tenant_id, target_custom_object_id)
    REFERENCES public.custom_object_definition(tenant_id, id)
    ON DELETE CASCADE,
  CONSTRAINT custom_object_relationship_definition_tenant_key_unique
    UNIQUE (tenant_id, relationship_key),
  CONSTRAINT custom_object_relationship_definition_tenant_id_unique
    UNIQUE (tenant_id, id)
);

CREATE INDEX IF NOT EXISTS idx_custom_object_relationship_definition_tenant_status
  ON public.custom_object_relationship_definition (tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_custom_object_relationship_definition_source
  ON public.custom_object_relationship_definition (tenant_id, source_kind, source_custom_object_id);
CREATE INDEX IF NOT EXISTS idx_custom_object_relationship_definition_target
  ON public.custom_object_relationship_definition (tenant_id, target_kind, target_custom_object_id);

CREATE TABLE IF NOT EXISTS public.custom_object_relationship (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenant(id) ON DELETE CASCADE,
  relationship_definition_id uuid NOT NULL,
  source_record_id uuid NOT NULL,
  target_record_id uuid NOT NULL,
  created_by text,
  archived_at timestamptz,
  archived_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT custom_object_relationship_archive_state
    CHECK (
      (archived_at IS NULL AND archived_by IS NULL)
      OR archived_at IS NOT NULL
    ),
  CONSTRAINT custom_object_relationship_definition_tenant_fk
    FOREIGN KEY (tenant_id, relationship_definition_id)
    REFERENCES public.custom_object_relationship_definition(tenant_id, id)
    ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS custom_object_relationship_active_pair_unique
  ON public.custom_object_relationship (
    tenant_id,
    relationship_definition_id,
    source_record_id,
    target_record_id
  )
  WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_custom_object_relationship_tenant_definition
  ON public.custom_object_relationship (tenant_id, relationship_definition_id, id)
  WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_custom_object_relationship_tenant_source
  ON public.custom_object_relationship (tenant_id, source_record_id, relationship_definition_id)
  WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_custom_object_relationship_tenant_target
  ON public.custom_object_relationship (tenant_id, target_record_id, relationship_definition_id)
  WHERE archived_at IS NULL;

CREATE TABLE IF NOT EXISTS public.custom_object_role_permission (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenant(id) ON DELETE CASCADE,
  custom_object_id uuid NOT NULL,
  role_id uuid NOT NULL REFERENCES public.role(id) ON DELETE CASCADE,
  can_view_records boolean NOT NULL DEFAULT false,
  can_create_records boolean NOT NULL DEFAULT false,
  can_edit_records boolean NOT NULL DEFAULT false,
  can_archive_records boolean NOT NULL DEFAULT false,
  can_export_records boolean NOT NULL DEFAULT false,
  created_by text,
  updated_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT custom_object_role_permission_object_tenant_fk
    FOREIGN KEY (tenant_id, custom_object_id)
    REFERENCES public.custom_object_definition(tenant_id, id)
    ON DELETE CASCADE,
  CONSTRAINT custom_object_role_permission_unique
    UNIQUE (tenant_id, custom_object_id, role_id)
);

CREATE INDEX IF NOT EXISTS idx_custom_object_role_permission_tenant_role
  ON public.custom_object_role_permission (tenant_id, role_id, custom_object_id);

CREATE TABLE IF NOT EXISTS public.custom_object_audit_event (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenant(id) ON DELETE CASCADE,
  custom_object_id uuid,
  record_id uuid,
  relationship_definition_id uuid,
  relationship_id uuid,
  actor_id text,
  actor_type varchar(30) NOT NULL DEFAULT 'system',
  action varchar(100) NOT NULL,
  entity_type varchar(100) NOT NULL,
  entity_id uuid NOT NULL,
  before_data jsonb,
  after_data jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT custom_object_audit_event_actor_type
    CHECK (actor_type IN ('tenant_user', 'member', 'platform_owner', 'system')),
  CONSTRAINT custom_object_audit_event_before_object
    CHECK (before_data IS NULL OR jsonb_typeof(before_data) = 'object'),
  CONSTRAINT custom_object_audit_event_after_object
    CHECK (after_data IS NULL OR jsonb_typeof(after_data) = 'object'),
  CONSTRAINT custom_object_audit_event_metadata_object
    CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE INDEX IF NOT EXISTS idx_custom_object_audit_event_tenant_created
  ON public.custom_object_audit_event (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_custom_object_audit_event_tenant_object
  ON public.custom_object_audit_event (tenant_id, custom_object_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_custom_object_audit_event_tenant_entity
  ON public.custom_object_audit_event (tenant_id, entity_type, entity_id, created_at DESC);

-- Definition lifecycle, stable identity, primary field ownership, and
-- conservative archive-not-delete semantics.
CREATE OR REPLACE FUNCTION public.guard_custom_object_definition()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF pg_trigger_depth() > 1 THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'Custom Objects must be archived instead of deleted'
      USING ERRCODE = '23514', CONSTRAINT = 'custom_object_definition_archive_only';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
       OR NEW.object_key IS DISTINCT FROM OLD.object_key THEN
      RAISE EXCEPTION 'Custom Object identity is immutable'
        USING ERRCODE = '23514', CONSTRAINT = 'custom_object_definition_immutable_identity';
    END IF;
    IF OLD.status = 'archived' AND NEW.status <> 'archived' THEN
      RAISE EXCEPTION 'Archived Custom Objects cannot be reactivated'
        USING ERRCODE = '23514', CONSTRAINT = 'custom_object_definition_archived_terminal';
    END IF;
    IF OLD.status = 'active' AND NEW.status = 'draft' THEN
      RAISE EXCEPTION 'Active Custom Objects cannot return to draft'
        USING ERRCODE = '23514', CONSTRAINT = 'custom_object_definition_active_not_draft';
    END IF;
  END IF;

  IF NEW.status = 'archived' THEN
    IF TG_OP = 'UPDATE' THEN
      NEW.archived_at := COALESCE(OLD.archived_at, NEW.archived_at, now());
    ELSE
      NEW.archived_at := COALESCE(NEW.archived_at, now());
    END IF;
  ELSE
    NEW.archived_at := NULL;
    NEW.archived_by := NULL;
  END IF;

  IF NEW.primary_display_field_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM public.preference_field pf
    WHERE pf.id = NEW.primary_display_field_id
      AND pf.tenant_id = NEW.tenant_id
      AND pf.custom_object_id = NEW.id
      AND pf.entity_scope = 'custom_object'
      AND pf.is_active = true
  ) THEN
    RAISE EXCEPTION 'Primary display field must be an active field on the same Custom Object'
      USING ERRCODE = '23503', CONSTRAINT = 'custom_object_definition_primary_field_owner';
  END IF;

  IF NEW.status = 'active' AND NEW.primary_display_field_id IS NULL THEN
    RAISE EXCEPTION 'Active Custom Objects require a primary display field'
      USING ERRCODE = '23514', CONSTRAINT = 'custom_object_definition_active_primary_field';
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS custom_object_definition_guard_trigger
  ON public.custom_object_definition;
CREATE TRIGGER custom_object_definition_guard_trigger
  BEFORE INSERT OR UPDATE OR DELETE ON public.custom_object_definition
  FOR EACH ROW EXECUTE FUNCTION public.guard_custom_object_definition();

CREATE OR REPLACE FUNCTION public.guard_custom_object_preference_field()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.custom_object_id IS NOT NULL THEN
      IF pg_trigger_depth() > 1 THEN
        RETURN OLD;
      END IF;
      RAISE EXCEPTION 'Custom Object fields must be archived instead of deleted'
        USING ERRCODE = '23514', CONSTRAINT = 'preference_field_custom_object_archive_only';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW.custom_object_id IS DISTINCT FROM OLD.custom_object_id THEN
      RAISE EXCEPTION 'Preference field ownership cannot be changed'
        USING ERRCODE = '23514', CONSTRAINT = 'preference_field_custom_object_immutable_owner';
    END IF;
    IF OLD.custom_object_id IS NOT NULL AND (
      NEW.id IS DISTINCT FROM OLD.id
      OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
      OR NEW.name IS DISTINCT FROM OLD.name
      OR NEW.entity_scope IS DISTINCT FROM OLD.entity_scope
    ) THEN
      RAISE EXCEPTION 'Custom Object field identity is immutable'
        USING ERRCODE = '23514', CONSTRAINT = 'preference_field_custom_object_immutable_identity';
    END IF;
    IF OLD.custom_object_id IS NOT NULL
       AND OLD.is_active IS TRUE
       AND NEW.is_active IS NOT TRUE
       AND EXISTS (
         SELECT 1
         FROM public.custom_object_definition cod
         WHERE cod.id = OLD.custom_object_id
           AND cod.tenant_id = OLD.tenant_id
           AND cod.status = 'active'
           AND cod.primary_display_field_id = OLD.id
       ) THEN
      RAISE EXCEPTION 'The primary display field of an active Custom Object cannot be deactivated'
        USING ERRCODE = '23514',
          CONSTRAINT = 'preference_field_custom_object_active_primary_required';
    END IF;
  END IF;

  IF NEW.custom_object_id IS NOT NULL THEN
    IF NEW.name !~ '^[a-z][a-z0-9_]{0,99}$' THEN
      RAISE EXCEPTION 'Custom Object field key is invalid'
        USING ERRCODE = '23514', CONSTRAINT = 'preference_field_custom_object_key_format';
    END IF;
    IF NOT EXISTS (
      SELECT 1
      FROM public.custom_object_definition cod
      WHERE cod.id = NEW.custom_object_id
        AND cod.tenant_id = NEW.tenant_id
        AND cod.status <> 'archived'
    ) THEN
      RAISE EXCEPTION 'Custom Object field owner must belong to the same tenant and be available'
        USING ERRCODE = '23503', CONSTRAINT = 'preference_field_custom_object_same_tenant';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS custom_object_preference_field_guard_trigger
  ON public.preference_field;
CREATE TRIGGER custom_object_preference_field_guard_trigger
  BEFORE INSERT OR UPDATE OR DELETE ON public.preference_field
  FOR EACH ROW EXECUTE FUNCTION public.guard_custom_object_preference_field();

CREATE OR REPLACE FUNCTION public.guard_custom_object_record()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  object_status text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF pg_trigger_depth() > 1 THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'Custom Object records must be archived instead of deleted'
      USING ERRCODE = '23514', CONSTRAINT = 'custom_object_record_archive_only';
  END IF;

  IF TG_OP = 'UPDATE' AND (
    NEW.id IS DISTINCT FROM OLD.id
    OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.custom_object_id IS DISTINCT FROM OLD.custom_object_id
  ) THEN
    RAISE EXCEPTION 'Custom Object record identity is immutable'
      USING ERRCODE = '23514', CONSTRAINT = 'custom_object_record_immutable_identity';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.archived_at IS NOT NULL AND NEW.archived_at IS NULL THEN
    RAISE EXCEPTION 'Archived Custom Object records cannot be restored'
      USING ERRCODE = '23514', CONSTRAINT = 'custom_object_record_archived_terminal';
  END IF;

  SELECT cod.status INTO object_status
  FROM public.custom_object_definition cod
  WHERE cod.id = NEW.custom_object_id
    AND cod.tenant_id = NEW.tenant_id;

  IF object_status IS NULL THEN
    RAISE EXCEPTION 'Custom Object record owner must belong to the same tenant'
      USING ERRCODE = '23503', CONSTRAINT = 'custom_object_record_same_tenant';
  END IF;
  IF TG_OP = 'INSERT' AND object_status <> 'active' THEN
    RAISE EXCEPTION 'New records can only be created for active Custom Objects'
      USING ERRCODE = '23514', CONSTRAINT = 'custom_object_record_active_object';
  END IF;
  IF TG_OP = 'UPDATE'
     AND NEW.data IS DISTINCT FROM OLD.data
     AND object_status <> 'active' THEN
    RAISE EXCEPTION 'Record data can only be edited for active Custom Objects'
      USING ERRCODE = '23514', CONSTRAINT = 'custom_object_record_edit_active_object';
  END IF;

  IF NEW.archived_at IS NULL THEN
    NEW.archived_by := NULL;
    NEW.archive_reason := NULL;
  ELSE
    IF TG_OP = 'UPDATE' THEN
      NEW.archived_at := COALESCE(OLD.archived_at, NEW.archived_at, now());
    ELSE
      NEW.archived_at := COALESCE(NEW.archived_at, now());
    END IF;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS custom_object_record_guard_trigger
  ON public.custom_object_record;
CREATE TRIGGER custom_object_record_guard_trigger
  BEFORE INSERT OR UPDATE OR DELETE ON public.custom_object_record
  FOR EACH ROW EXECUTE FUNCTION public.guard_custom_object_record();

CREATE OR REPLACE FUNCTION public.guard_custom_object_relationship_definition()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF pg_trigger_depth() > 1 THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'Relationship definitions must be archived instead of deleted'
      USING ERRCODE = '23514', CONSTRAINT = 'custom_object_relationship_definition_archive_only';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
       OR NEW.relationship_key IS DISTINCT FROM OLD.relationship_key
       OR NEW.source_kind IS DISTINCT FROM OLD.source_kind
       OR NEW.source_custom_object_id IS DISTINCT FROM OLD.source_custom_object_id
       OR NEW.target_kind IS DISTINCT FROM OLD.target_kind
       OR NEW.target_custom_object_id IS DISTINCT FROM OLD.target_custom_object_id
       OR NEW.cardinality IS DISTINCT FROM OLD.cardinality THEN
      RAISE EXCEPTION 'Relationship identity, endpoints, and cardinality are immutable'
        USING ERRCODE = '23514', CONSTRAINT = 'custom_object_relationship_definition_immutable_identity';
    END IF;
    IF OLD.status = 'archived' AND NEW.status <> 'archived' THEN
      RAISE EXCEPTION 'Archived relationship definitions cannot be restored'
        USING ERRCODE = '23514', CONSTRAINT = 'custom_object_relationship_definition_archived_terminal';
    END IF;
  END IF;

  IF NEW.source_custom_object_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.custom_object_definition cod
    WHERE cod.id = NEW.source_custom_object_id
      AND cod.tenant_id = NEW.tenant_id
      AND (NEW.status <> 'active' OR cod.status = 'active')
  ) THEN
    RAISE EXCEPTION 'Source Custom Object must belong to the same tenant and be active when the relationship is active'
      USING ERRCODE = '23503', CONSTRAINT = 'custom_object_relationship_definition_source_same_tenant';
  END IF;
  IF NEW.target_custom_object_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.custom_object_definition cod
    WHERE cod.id = NEW.target_custom_object_id
      AND cod.tenant_id = NEW.tenant_id
      AND (NEW.status <> 'active' OR cod.status = 'active')
  ) THEN
    RAISE EXCEPTION 'Target Custom Object must belong to the same tenant and be active when the relationship is active'
      USING ERRCODE = '23503', CONSTRAINT = 'custom_object_relationship_definition_target_same_tenant';
  END IF;

  IF NEW.status = 'archived' THEN
    IF TG_OP = 'UPDATE' THEN
      NEW.archived_at := COALESCE(OLD.archived_at, NEW.archived_at, now());
    ELSE
      NEW.archived_at := COALESCE(NEW.archived_at, now());
    END IF;
  ELSE
    NEW.archived_at := NULL;
    NEW.archived_by := NULL;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS custom_object_relationship_definition_guard_trigger
  ON public.custom_object_relationship_definition;
CREATE TRIGGER custom_object_relationship_definition_guard_trigger
  BEFORE INSERT OR UPDATE OR DELETE ON public.custom_object_relationship_definition
  FOR EACH ROW EXECUTE FUNCTION public.guard_custom_object_relationship_definition();

CREATE OR REPLACE FUNCTION public.custom_object_endpoint_exists(
  p_tenant_id uuid,
  p_kind text,
  p_custom_object_id uuid,
  p_record_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
BEGIN
  CASE p_kind
    WHEN 'member' THEN
      RETURN EXISTS (
        SELECT 1 FROM public.member
        WHERE id = p_record_id AND tenant_id = p_tenant_id
      );
    WHEN 'organization' THEN
      RETURN EXISTS (
        SELECT 1 FROM public.organization
        WHERE id = p_record_id AND tenant_id = p_tenant_id
      );
    WHEN 'organization_group' THEN
      RETURN EXISTS (
        SELECT 1 FROM public.organization_group
        WHERE id = p_record_id AND tenant_id = p_tenant_id
      );
    WHEN 'custom_object' THEN
      RETURN EXISTS (
        SELECT 1
        FROM public.custom_object_record cor
        JOIN public.custom_object_definition cod
          ON cod.id = cor.custom_object_id
         AND cod.tenant_id = cor.tenant_id
        WHERE cor.id = p_record_id
          AND cor.tenant_id = p_tenant_id
          AND cor.custom_object_id = p_custom_object_id
          AND cor.archived_at IS NULL
          AND cod.status = 'active'
      );
    ELSE
      RETURN false;
  END CASE;
END;
$$;

CREATE OR REPLACE FUNCTION public.guard_custom_object_relationship()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  definition public.custom_object_relationship_definition%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF pg_trigger_depth() > 1 THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'Relationships must be archived instead of deleted'
      USING ERRCODE = '23514', CONSTRAINT = 'custom_object_relationship_archive_only';
  END IF;

  IF TG_OP = 'UPDATE' AND (
    NEW.id IS DISTINCT FROM OLD.id
    OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.relationship_definition_id IS DISTINCT FROM OLD.relationship_definition_id
    OR NEW.source_record_id IS DISTINCT FROM OLD.source_record_id
    OR NEW.target_record_id IS DISTINCT FROM OLD.target_record_id
  ) THEN
    RAISE EXCEPTION 'Relationship identity and endpoints are immutable'
      USING ERRCODE = '23514', CONSTRAINT = 'custom_object_relationship_immutable_identity';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.archived_at IS NOT NULL AND NEW.archived_at IS NULL THEN
    RAISE EXCEPTION 'Archived relationships cannot be restored'
      USING ERRCODE = '23514', CONSTRAINT = 'custom_object_relationship_archived_terminal';
  END IF;

  SELECT * INTO definition
  FROM public.custom_object_relationship_definition rd
  WHERE rd.id = NEW.relationship_definition_id
    AND rd.tenant_id = NEW.tenant_id;

  IF definition.id IS NULL THEN
    RAISE EXCEPTION 'Relationship definition must belong to the same tenant'
      USING ERRCODE = '23503', CONSTRAINT = 'custom_object_relationship_definition_same_tenant';
  END IF;

  IF NEW.archived_at IS NULL THEN
    IF definition.status <> 'active' THEN
      RAISE EXCEPTION 'Relationship definition is not active'
        USING ERRCODE = '23514', CONSTRAINT = 'custom_object_relationship_definition_active';
    END IF;
    IF NOT public.custom_object_endpoint_exists(
      NEW.tenant_id,
      definition.source_kind,
      definition.source_custom_object_id,
      NEW.source_record_id
    ) THEN
      RAISE EXCEPTION 'Source relationship record does not exist, is archived, or belongs to another tenant/object'
        USING ERRCODE = '23503', CONSTRAINT = 'custom_object_relationship_source_valid';
    END IF;
    IF NOT public.custom_object_endpoint_exists(
      NEW.tenant_id,
      definition.target_kind,
      definition.target_custom_object_id,
      NEW.target_record_id
    ) THEN
      RAISE EXCEPTION 'Target relationship record does not exist, is archived, or belongs to another tenant/object'
        USING ERRCODE = '23503', CONSTRAINT = 'custom_object_relationship_target_valid';
    END IF;

    PERFORM pg_advisory_xact_lock(hashtext(NEW.relationship_definition_id::text));

    IF definition.cardinality IN ('one_to_one', 'many_to_one') AND EXISTS (
      SELECT 1
      FROM public.custom_object_relationship existing
      WHERE existing.tenant_id = NEW.tenant_id
        AND existing.relationship_definition_id = NEW.relationship_definition_id
        AND existing.source_record_id = NEW.source_record_id
        AND existing.archived_at IS NULL
        AND existing.id <> NEW.id
    ) THEN
      RAISE EXCEPTION 'Source record exceeds relationship cardinality'
        USING ERRCODE = '23505', CONSTRAINT = 'custom_object_relationship_source_cardinality';
    END IF;

    IF definition.cardinality IN ('one_to_one', 'one_to_many') AND EXISTS (
      SELECT 1
      FROM public.custom_object_relationship existing
      WHERE existing.tenant_id = NEW.tenant_id
        AND existing.relationship_definition_id = NEW.relationship_definition_id
        AND existing.target_record_id = NEW.target_record_id
        AND existing.archived_at IS NULL
        AND existing.id <> NEW.id
    ) THEN
      RAISE EXCEPTION 'Target record exceeds relationship cardinality'
        USING ERRCODE = '23505', CONSTRAINT = 'custom_object_relationship_target_cardinality';
    END IF;
    NEW.archived_by := NULL;
  ELSE
    IF TG_OP = 'UPDATE' THEN
      NEW.archived_at := COALESCE(OLD.archived_at, NEW.archived_at, now());
    ELSE
      NEW.archived_at := COALESCE(NEW.archived_at, now());
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS custom_object_relationship_guard_trigger
  ON public.custom_object_relationship;
CREATE TRIGGER custom_object_relationship_guard_trigger
  BEFORE INSERT OR UPDATE OR DELETE ON public.custom_object_relationship
  FOR EACH ROW EXECUTE FUNCTION public.guard_custom_object_relationship();

CREATE OR REPLACE FUNCTION public.guard_custom_object_role_permission()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.custom_object_definition cod
    WHERE cod.id = NEW.custom_object_id
      AND cod.tenant_id = NEW.tenant_id
  ) THEN
    RAISE EXCEPTION 'Permission Custom Object must belong to the same tenant'
      USING ERRCODE = '23503', CONSTRAINT = 'custom_object_role_permission_object_same_tenant';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.role r
    WHERE r.id = NEW.role_id
      AND r.tenant_id = NEW.tenant_id
  ) THEN
    RAISE EXCEPTION 'Permission role must belong to the same tenant'
      USING ERRCODE = '23503', CONSTRAINT = 'custom_object_role_permission_role_same_tenant';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS custom_object_role_permission_guard_trigger
  ON public.custom_object_role_permission;
CREATE TRIGGER custom_object_role_permission_guard_trigger
  BEFORE INSERT OR UPDATE OF tenant_id, custom_object_id, role_id,
    can_view_records, can_create_records, can_edit_records,
    can_archive_records, can_export_records
  ON public.custom_object_role_permission
  FOR EACH ROW EXECUTE FUNCTION public.guard_custom_object_role_permission();

-- Core Member, Organisation, and Organisation Group value tables must never
-- point at a Custom Object field. Custom Object values live only in the
-- JSONB-backed custom_object_record table.
CREATE OR REPLACE FUNCTION public.guard_core_preference_value_field()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.preference_field pf
    WHERE pf.id = NEW.field_id
      AND (
        pf.entity_scope = 'custom_object'
        OR pf.custom_object_id IS NOT NULL
      )
  ) THEN
    RAISE EXCEPTION 'Custom Object fields cannot be stored in core preference value tables'
      USING ERRCODE = '23514', CONSTRAINT = 'core_preference_value_custom_object_field';
  END IF;
  RETURN NEW;
END;
$$;

DO $$
BEGIN
  IF to_regclass('public.member_preference_value') IS NOT NULL THEN
    EXECUTE 'DROP TRIGGER IF EXISTS member_preference_value_custom_object_guard ON public.member_preference_value';
    EXECUTE 'CREATE TRIGGER member_preference_value_custom_object_guard
      BEFORE INSERT OR UPDATE OF field_id ON public.member_preference_value
      FOR EACH ROW EXECUTE FUNCTION public.guard_core_preference_value_field()';
  END IF;
  IF to_regclass('public.organization_preference_value') IS NOT NULL THEN
    EXECUTE 'DROP TRIGGER IF EXISTS organization_preference_value_custom_object_guard ON public.organization_preference_value';
    EXECUTE 'CREATE TRIGGER organization_preference_value_custom_object_guard
      BEFORE INSERT OR UPDATE OF field_id ON public.organization_preference_value
      FOR EACH ROW EXECUTE FUNCTION public.guard_core_preference_value_field()';
  END IF;
  IF to_regclass('public.organization_group_preference_value') IS NOT NULL THEN
    EXECUTE 'DROP TRIGGER IF EXISTS organization_group_preference_value_custom_object_guard ON public.organization_group_preference_value';
    EXECUTE 'CREATE TRIGGER organization_group_preference_value_custom_object_guard
      BEFORE INSERT OR UPDATE OF field_id ON public.organization_group_preference_value
      FOR EACH ROW EXECUTE FUNCTION public.guard_core_preference_value_field()';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.guard_custom_object_audit_event()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'Custom Object audit events are append-only'
      USING ERRCODE = '23514', CONSTRAINT = 'custom_object_audit_event_append_only';
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF pg_trigger_depth() > 1 THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'Custom Object audit events are append-only'
      USING ERRCODE = '23514', CONSTRAINT = 'custom_object_audit_event_append_only';
  END IF;

  IF NEW.custom_object_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.custom_object_definition cod
    WHERE cod.id = NEW.custom_object_id AND cod.tenant_id = NEW.tenant_id
  ) THEN
    RAISE EXCEPTION 'Audit Custom Object belongs to another tenant'
      USING ERRCODE = '23503', CONSTRAINT = 'custom_object_audit_event_object_same_tenant';
  END IF;
  IF NEW.record_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.custom_object_record cor
    WHERE cor.id = NEW.record_id
      AND cor.tenant_id = NEW.tenant_id
      AND (
        NEW.custom_object_id IS NULL
        OR cor.custom_object_id = NEW.custom_object_id
      )
  ) THEN
    RAISE EXCEPTION 'Audit record belongs to another tenant or Custom Object'
      USING ERRCODE = '23503', CONSTRAINT = 'custom_object_audit_event_record_same_tenant';
  END IF;
  IF NEW.relationship_definition_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.custom_object_relationship_definition rd
    WHERE rd.id = NEW.relationship_definition_id AND rd.tenant_id = NEW.tenant_id
  ) THEN
    RAISE EXCEPTION 'Audit relationship definition belongs to another tenant'
      USING ERRCODE = '23503', CONSTRAINT = 'custom_object_audit_event_definition_same_tenant';
  END IF;
  IF NEW.relationship_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.custom_object_relationship rel
    WHERE rel.id = NEW.relationship_id
      AND rel.tenant_id = NEW.tenant_id
      AND (
        NEW.relationship_definition_id IS NULL
        OR rel.relationship_definition_id = NEW.relationship_definition_id
      )
  ) THEN
    RAISE EXCEPTION 'Audit relationship belongs to another tenant or definition'
      USING ERRCODE = '23503', CONSTRAINT = 'custom_object_audit_event_relationship_same_tenant';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS custom_object_audit_event_guard_trigger
  ON public.custom_object_audit_event;
CREATE TRIGGER custom_object_audit_event_guard_trigger
  BEFORE INSERT OR UPDATE OR DELETE ON public.custom_object_audit_event
  FOR EACH ROW EXECUTE FUNCTION public.guard_custom_object_audit_event();

-- Every domain mutation and its audit event commit in the same database
-- transaction. Dedicated services encode the authenticated identity class in
-- server-authored mutation columns so the trigger can persist both actor id
-- and actor type without accepting caller-controlled audit rows.
CREATE OR REPLACE FUNCTION public.audit_custom_object_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_before jsonb := CASE WHEN TG_OP = 'UPDATE' THEN to_jsonb(OLD) ELSE NULL END;
  v_after jsonb := to_jsonb(NEW);
  v_tenant_id uuid;
  v_custom_object_id uuid;
  v_record_id uuid;
  v_relationship_definition_id uuid;
  v_relationship_id uuid;
  v_actor_reference text;
  v_actor_id text;
  v_actor_type text := 'system';
  v_action text;
  v_entity_type text;
BEGIN
  IF TG_TABLE_NAME = 'preference_field'
     AND COALESCE(v_after->>'entity_scope', '') <> 'custom_object' THEN
    RETURN NEW;
  END IF;

  v_tenant_id := (v_after->>'tenant_id')::uuid;
  v_actor_reference := COALESCE(
    NULLIF(v_after->>'archived_by', ''),
    NULLIF(v_after->>'updated_by', ''),
    NULLIF(v_after->>'created_by', ''),
    NULLIF(v_before->>'updated_by', ''),
    NULLIF(v_before->>'created_by', '')
  );
  IF v_actor_reference LIKE 'tenant_user:%' THEN
    v_actor_type := 'tenant_user';
    v_actor_id := substring(v_actor_reference FROM char_length('tenant_user:') + 1);
  ELSIF v_actor_reference LIKE 'member:%' THEN
    v_actor_type := 'member';
    v_actor_id := substring(v_actor_reference FROM char_length('member:') + 1);
  ELSE
    v_actor_id := v_actor_reference;
  END IF;

  CASE TG_TABLE_NAME
    WHEN 'custom_object_definition' THEN
      v_custom_object_id := NEW.id;
      v_entity_type := 'custom_object_definition';
      v_action := CASE
        WHEN TG_OP = 'INSERT' THEN 'created'
        WHEN OLD.status <> 'archived' AND NEW.status = 'archived' THEN 'archived'
        ELSE 'updated'
      END;
    WHEN 'preference_field' THEN
      v_custom_object_id := NEW.custom_object_id;
      v_entity_type := 'preference_field';
      v_action := CASE
        WHEN TG_OP = 'INSERT' THEN 'field_created'
        WHEN OLD.is_active AND NOT NEW.is_active THEN 'field_deactivated'
        ELSE 'field_updated'
      END;
    WHEN 'custom_object_record' THEN
      v_custom_object_id := NEW.custom_object_id;
      v_record_id := NEW.id;
      v_entity_type := 'custom_object_record';
      v_action := CASE
        WHEN TG_OP = 'INSERT' THEN 'record_created'
        WHEN OLD.archived_at IS NULL AND NEW.archived_at IS NOT NULL THEN 'record_archived'
        ELSE 'record_updated'
      END;
    WHEN 'custom_object_relationship_definition' THEN
      v_custom_object_id := COALESCE(NEW.source_custom_object_id, NEW.target_custom_object_id);
      v_relationship_definition_id := NEW.id;
      v_entity_type := 'custom_object_relationship_definition';
      v_action := CASE
        WHEN TG_OP = 'INSERT' THEN 'relationship_definition_created'
        WHEN OLD.status <> 'archived' AND NEW.status = 'archived'
          THEN 'relationship_definition_archived'
        ELSE 'relationship_definition_updated'
      END;
    WHEN 'custom_object_relationship' THEN
      v_relationship_definition_id := NEW.relationship_definition_id;
      v_relationship_id := NEW.id;
      SELECT COALESCE(rd.source_custom_object_id, rd.target_custom_object_id)
      INTO v_custom_object_id
      FROM public.custom_object_relationship_definition rd
      WHERE rd.id = NEW.relationship_definition_id
        AND rd.tenant_id = NEW.tenant_id;
      v_entity_type := 'custom_object_relationship';
      v_action := CASE
        WHEN TG_OP = 'INSERT' THEN 'relationship_created'
        WHEN OLD.archived_at IS NULL AND NEW.archived_at IS NOT NULL THEN 'relationship_archived'
        ELSE 'relationship_updated'
      END;
    WHEN 'custom_object_role_permission' THEN
      v_custom_object_id := NEW.custom_object_id;
      v_entity_type := 'custom_object_role_permission';
      v_action := 'permission_upserted';
    ELSE
      RETURN NEW;
  END CASE;

  INSERT INTO public.custom_object_audit_event (
    tenant_id,
    custom_object_id,
    record_id,
    relationship_definition_id,
    relationship_id,
    actor_id,
    actor_type,
    action,
    entity_type,
    entity_id,
    before_data,
    after_data,
    metadata
  ) VALUES (
    v_tenant_id,
    v_custom_object_id,
    v_record_id,
    v_relationship_definition_id,
    v_relationship_id,
    v_actor_id,
    v_actor_type,
    v_action,
    v_entity_type,
    NEW.id,
    v_before,
    v_after,
    '{}'::jsonb
  );

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS custom_object_definition_audit_trigger
  ON public.custom_object_definition;
CREATE TRIGGER custom_object_definition_audit_trigger
  AFTER INSERT OR UPDATE ON public.custom_object_definition
  FOR EACH ROW EXECUTE FUNCTION public.audit_custom_object_mutation();

DROP TRIGGER IF EXISTS custom_object_preference_field_audit_trigger
  ON public.preference_field;
CREATE TRIGGER custom_object_preference_field_audit_trigger
  AFTER INSERT OR UPDATE ON public.preference_field
  FOR EACH ROW EXECUTE FUNCTION public.audit_custom_object_mutation();

DROP TRIGGER IF EXISTS custom_object_record_audit_trigger
  ON public.custom_object_record;
CREATE TRIGGER custom_object_record_audit_trigger
  AFTER INSERT OR UPDATE ON public.custom_object_record
  FOR EACH ROW EXECUTE FUNCTION public.audit_custom_object_mutation();

DROP TRIGGER IF EXISTS custom_object_relationship_definition_audit_trigger
  ON public.custom_object_relationship_definition;
CREATE TRIGGER custom_object_relationship_definition_audit_trigger
  AFTER INSERT OR UPDATE ON public.custom_object_relationship_definition
  FOR EACH ROW EXECUTE FUNCTION public.audit_custom_object_mutation();

DROP TRIGGER IF EXISTS custom_object_relationship_audit_trigger
  ON public.custom_object_relationship;
CREATE TRIGGER custom_object_relationship_audit_trigger
  AFTER INSERT OR UPDATE ON public.custom_object_relationship
  FOR EACH ROW EXECUTE FUNCTION public.audit_custom_object_mutation();

DROP TRIGGER IF EXISTS custom_object_role_permission_audit_trigger
  ON public.custom_object_role_permission;
CREATE TRIGGER custom_object_role_permission_audit_trigger
  AFTER INSERT OR UPDATE ON public.custom_object_role_permission
  FOR EACH ROW EXECUTE FUNCTION public.audit_custom_object_mutation();

-- Direct browser access is intentionally denied. The service role is used only
-- behind tenant-, permission-, and schema-validating server APIs.
ALTER TABLE public.custom_object_definition ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.custom_object_record ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.custom_object_relationship_definition ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.custom_object_relationship ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.custom_object_role_permission ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.custom_object_audit_event ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.custom_object_definition FROM anon, authenticated;
REVOKE ALL ON TABLE public.custom_object_record FROM anon, authenticated;
REVOKE ALL ON TABLE public.custom_object_relationship_definition FROM anon, authenticated;
REVOKE ALL ON TABLE public.custom_object_relationship FROM anon, authenticated;
REVOKE ALL ON TABLE public.custom_object_role_permission FROM anon, authenticated;
REVOKE ALL ON TABLE public.custom_object_audit_event FROM anon, authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.custom_object_definition TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.custom_object_record TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.custom_object_relationship_definition TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.custom_object_relationship TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.custom_object_role_permission TO service_role;
GRANT SELECT, INSERT ON TABLE public.custom_object_audit_event TO service_role;

DROP POLICY IF EXISTS custom_object_definition_service_role
  ON public.custom_object_definition;
CREATE POLICY custom_object_definition_service_role
  ON public.custom_object_definition FOR ALL TO service_role
  USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS custom_object_record_service_role
  ON public.custom_object_record;
CREATE POLICY custom_object_record_service_role
  ON public.custom_object_record FOR ALL TO service_role
  USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS custom_object_relationship_definition_service_role
  ON public.custom_object_relationship_definition;
CREATE POLICY custom_object_relationship_definition_service_role
  ON public.custom_object_relationship_definition FOR ALL TO service_role
  USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS custom_object_relationship_service_role
  ON public.custom_object_relationship;
CREATE POLICY custom_object_relationship_service_role
  ON public.custom_object_relationship FOR ALL TO service_role
  USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS custom_object_role_permission_service_role
  ON public.custom_object_role_permission;
CREATE POLICY custom_object_role_permission_service_role
  ON public.custom_object_role_permission FOR ALL TO service_role
  USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS custom_object_audit_event_service_role
  ON public.custom_object_audit_event;
DROP POLICY IF EXISTS custom_object_audit_event_service_role_insert
  ON public.custom_object_audit_event;
CREATE POLICY custom_object_audit_event_service_role
  ON public.custom_object_audit_event FOR SELECT TO service_role
  USING (true);
CREATE POLICY custom_object_audit_event_service_role_insert
  ON public.custom_object_audit_event FOR INSERT TO service_role
  WITH CHECK (true);

REVOKE ALL ON FUNCTION public.guard_custom_object_definition() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.guard_custom_object_preference_field() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.guard_custom_object_record() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.guard_custom_object_relationship_definition() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.custom_object_endpoint_exists(uuid, text, uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.guard_custom_object_relationship() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.guard_custom_object_role_permission() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.guard_core_preference_value_field() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.guard_custom_object_audit_event() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.audit_custom_object_mutation() FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.custom_object_endpoint_exists(uuid, text, uuid, uuid) TO service_role;

COMMENT ON TABLE public.custom_object_definition IS
  'Tenant-owned Custom Object metadata. Internal object_key is immutable; labels are editable.';
COMMENT ON COLUMN public.preference_field.custom_object_id IS
  'Owning Custom Object for entity_scope=custom_object. NULL for existing core scopes.';
COMMENT ON TABLE public.custom_object_record IS
  'Generic JSONB-backed records for all tenant Custom Objects.';
COMMENT ON TABLE public.custom_object_audit_event IS
  'Append-only, server-authored audit trail for Custom Object schema, records, and relationships.';