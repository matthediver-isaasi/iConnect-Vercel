-- Runtime relationship invariants added after the Custom Object foundation.
-- Edge creation cardinality continues to be serialized by the advisory lock in
-- guard_custom_object_relationship(). Final-edge removal uses the same lock key
-- so a concurrent insert/archive cannot bypass a required relationship.

CREATE OR REPLACE FUNCTION public.guard_custom_object_required_relationship()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  definition public.custom_object_relationship_definition%ROWTYPE;
  source_is_archived boolean := false;
BEGIN
  IF OLD.archived_at IS NULL AND NEW.archived_at IS NOT NULL THEN
    SELECT * INTO definition
    FROM public.custom_object_relationship_definition rd
    WHERE rd.id = OLD.relationship_definition_id
      AND rd.tenant_id = OLD.tenant_id;

    IF definition.id IS NOT NULL
       AND definition.is_required
       AND definition.status <> 'archived' THEN
      PERFORM pg_advisory_xact_lock(hashtext(OLD.relationship_definition_id::text));

      IF definition.source_kind = 'custom_object' THEN
        SELECT cor.archived_at IS NOT NULL INTO source_is_archived
        FROM public.custom_object_record cor
        WHERE cor.tenant_id = OLD.tenant_id
          AND cor.id = OLD.source_record_id
          AND cor.custom_object_id = definition.source_custom_object_id;
      END IF;

      IF NOT COALESCE(source_is_archived, false) AND NOT EXISTS (
        SELECT 1
        FROM public.custom_object_relationship remaining
        WHERE remaining.tenant_id = OLD.tenant_id
          AND remaining.relationship_definition_id = OLD.relationship_definition_id
          AND remaining.source_record_id = OLD.source_record_id
          AND remaining.archived_at IS NULL
          AND remaining.id <> OLD.id
      ) THEN
        RAISE EXCEPTION 'A required relationship cannot lose its final active edge'
          USING ERRCODE = '23514',
            CONSTRAINT = 'custom_object_relationship_required_source';
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS custom_object_relationship_required_guard_trigger
  ON public.custom_object_relationship;
CREATE TRIGGER custom_object_relationship_required_guard_trigger
  BEFORE UPDATE OF archived_at ON public.custom_object_relationship
  FOR EACH ROW EXECUTE FUNCTION public.guard_custom_object_required_relationship();

REVOKE ALL ON FUNCTION public.guard_custom_object_required_relationship()
  FROM PUBLIC, anon, authenticated;

-- Retiring a relationship definition also retires all of its active edges.
-- The definition is already archived when this AFTER trigger runs, allowing
-- required edges to be retired as part of the same lifecycle transaction.
CREATE OR REPLACE FUNCTION public.archive_custom_object_relationship_definition_edges()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF OLD.status <> 'archived' AND NEW.status = 'archived' THEN
    UPDATE public.custom_object_relationship relationship
    SET archived_at = COALESCE(NEW.archived_at, now()),
        archived_by = NEW.archived_by
    WHERE relationship.tenant_id = NEW.tenant_id
      AND relationship.relationship_definition_id = NEW.id
      AND relationship.archived_at IS NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS custom_object_relationship_definition_edge_archive_trigger
  ON public.custom_object_relationship_definition;
CREATE TRIGGER custom_object_relationship_definition_edge_archive_trigger
  AFTER UPDATE OF status ON public.custom_object_relationship_definition
  FOR EACH ROW EXECUTE FUNCTION public.archive_custom_object_relationship_definition_edges();

-- An archived endpoint cannot retain draft or active relationship metadata.
-- Updating the definitions (rather than deleting them) preserves reviewability
-- and lets their existing audit trigger record each automatic retirement.
CREATE OR REPLACE FUNCTION public.archive_custom_object_definition_relationships()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  retirement_at timestamptz := COALESCE(NEW.archived_at, now());
BEGIN
  IF OLD.status <> 'archived' AND NEW.status = 'archived' THEN
    UPDATE public.custom_object_relationship_definition definition
    SET status = 'archived',
        archived_at = retirement_at,
        archived_by = NEW.archived_by,
        updated_by = COALESCE(NEW.updated_by, NEW.archived_by, definition.updated_by),
        updated_at = retirement_at
    WHERE definition.tenant_id = NEW.tenant_id
      AND definition.status <> 'archived'
      AND (
        definition.source_custom_object_id = NEW.id
        OR definition.target_custom_object_id = NEW.id
      );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS custom_object_definition_relationship_archive_trigger
  ON public.custom_object_definition;
CREATE TRIGGER custom_object_definition_relationship_archive_trigger
  AFTER UPDATE OF status ON public.custom_object_definition
  FOR EACH ROW EXECUTE FUNCTION public.archive_custom_object_definition_relationships();

-- Archive every active incident edge after a Custom Object record is archived.
-- Running AFTER the record update lets the required-edge guard distinguish a
-- source retirement (allowed) from loss of the last target of an active source
-- (rejected, rolling the record archive back atomically).
CREATE OR REPLACE FUNCTION public.archive_custom_object_record_relationships()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF OLD.archived_at IS NULL AND NEW.archived_at IS NOT NULL THEN
    UPDATE public.custom_object_relationship relationship
    SET archived_at = NEW.archived_at,
        archived_by = COALESCE(NEW.archived_by, relationship.archived_by)
    FROM public.custom_object_relationship_definition definition
    WHERE relationship.tenant_id = NEW.tenant_id
      AND relationship.relationship_definition_id = definition.id
      AND definition.tenant_id = NEW.tenant_id
      AND relationship.archived_at IS NULL
      AND (
        (
          definition.source_kind = 'custom_object'
          AND definition.source_custom_object_id = NEW.custom_object_id
          AND relationship.source_record_id = NEW.id
        )
        OR
        (
          definition.target_kind = 'custom_object'
          AND definition.target_custom_object_id = NEW.custom_object_id
          AND relationship.target_record_id = NEW.id
        )
      );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS custom_object_record_relationship_archive_trigger
  ON public.custom_object_record;
CREATE TRIGGER custom_object_record_relationship_archive_trigger
  AFTER UPDATE OF archived_at ON public.custom_object_record
  FOR EACH ROW EXECUTE FUNCTION public.archive_custom_object_record_relationships();

-- The service archives individual edges only through this function. The lock
-- is acquired before the edge is re-read, so concurrent removals serialize
-- before the trigger's final-edge check and update.
CREATE OR REPLACE FUNCTION public.archive_custom_object_relationship(
  p_tenant_id uuid,
  p_relationship_id uuid,
  p_archived_by text,
  p_archived_at timestamptz DEFAULT now()
)
RETURNS public.custom_object_relationship
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  edge public.custom_object_relationship%ROWTYPE;
  result public.custom_object_relationship%ROWTYPE;
BEGIN
  SELECT relationship.* INTO edge
  FROM public.custom_object_relationship relationship
  WHERE relationship.id = p_relationship_id
    AND relationship.tenant_id = p_tenant_id;
  IF edge.id IS NULL THEN
    RAISE EXCEPTION 'Relationship edge not found for tenant'
      USING ERRCODE = 'P0002';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext(edge.relationship_definition_id::text));

  SELECT relationship.* INTO edge
  FROM public.custom_object_relationship relationship
  WHERE relationship.id = p_relationship_id
    AND relationship.tenant_id = p_tenant_id
  FOR UPDATE;
  IF edge.archived_at IS NOT NULL THEN
    RAISE EXCEPTION 'Relationship edge is already archived'
      USING ERRCODE = '23514',
        CONSTRAINT = 'custom_object_relationship_already_archived';
  END IF;

  UPDATE public.custom_object_relationship
  SET archived_at = COALESCE(p_archived_at, now()),
      archived_by = p_archived_by
  WHERE id = edge.id
    AND tenant_id = p_tenant_id
  RETURNING * INTO result;
  RETURN result;
END;
$$;

REVOKE ALL ON FUNCTION public.archive_custom_object_record_relationships()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.archive_custom_object_relationship_definition_edges()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.archive_custom_object_definition_relationships()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.archive_custom_object_relationship(uuid, uuid, text, timestamptz)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.archive_custom_object_relationship(uuid, uuid, text, timestamptz)
  TO service_role;