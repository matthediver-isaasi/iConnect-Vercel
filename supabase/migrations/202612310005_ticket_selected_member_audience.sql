-- Task 5178. Schema BEFORE application rollout. Additive, no legacy backfill.
-- Simple ticket classes use event.pricing_config; complex classes use columns.
ALTER TABLE public.complex_event_ticket_class
  ADD COLUMN IF NOT EXISTS audience_mode text,
  ADD COLUMN IF NOT EXISTS selected_member_ids uuid[];

COMMENT ON COLUMN public.complex_event_ticket_class.audience_mode IS
  'NULL/legacy preserves existing eligibility. selected_members is an explicit tenant-member allowlist.';
COMMENT ON COLUMN public.complex_event_ticket_class.selected_member_ids IS
  'Canonical member.id UUID allowlist; tenant ownership checked on writes. Never backfilled from legacy role/group rules.';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
    WHERE conrelid='public.complex_event_ticket_class'::regclass
      AND conname='complex_ticket_audience_mode_valid') THEN
    ALTER TABLE public.complex_event_ticket_class
      ADD CONSTRAINT complex_ticket_audience_mode_valid
      CHECK (audience_mode IS NULL OR audience_mode IN ('legacy','selected_members'));
  END IF;
END $$;

-- Shared normalizer for both storage forms. Called only by the definer trigger,
-- not exposed as a public RPC. UUIDs are resolved against canonical member rows,
-- independent of a caller's RLS visibility, with no member data returned.
CREATE OR REPLACE FUNCTION public.normalize_ticket_selected_member_audience(
  ticket jsonb, tenant uuid, previous jsonb DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  mode text;
  ids uuid[] := ARRAY[]::uuid[];
  element jsonb;
  member_id uuid;
  found_id uuid;
  field text;
BEGIN
  IF jsonb_typeof(ticket) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'Each ticket class must be an object' USING ERRCODE='23514';
  END IF;
  mode := coalesce(ticket->>'audience_mode', 'legacy');
  IF mode NOT IN ('legacy','selected_members') THEN
    RAISE EXCEPTION 'Invalid ticket audience_mode' USING ERRCODE='23514';
  END IF;
  IF mode='legacy' AND (
    previous->>'audience_mode'='selected_members'
    OR (ticket ? 'audience_mode'
      AND ticket->'selected_member_ids' IS NOT NULL
      AND ticket->'selected_member_ids' NOT IN ('null'::jsonb, '[]'::jsonb))
  ) THEN
    RETURN jsonb_set(ticket, '{selected_member_ids}', '[]'::jsonb);
  END IF;
  IF ticket->'selected_member_ids' IS NOT NULL
    AND ticket->'selected_member_ids' <> 'null'::jsonb
    AND jsonb_typeof(ticket->'selected_member_ids') <> 'array' THEN
    RAISE EXCEPTION 'selected_member_ids must be a UUID array' USING ERRCODE='23514';
  END IF;
  FOR element IN SELECT value FROM jsonb_array_elements(
    CASE WHEN jsonb_typeof(ticket->'selected_member_ids')='array'
      THEN ticket->'selected_member_ids' ELSE '[]'::jsonb END)
  LOOP
    IF jsonb_typeof(element) <> 'string' OR (element #>> '{}') !~*
      '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      RAISE EXCEPTION 'selected_member_ids must contain only member UUIDs' USING ERRCODE='23514';
    END IF;
    member_id := (element #>> '{}')::uuid;
    IF NOT member_id = ANY(ids) THEN ids := array_append(ids, member_id); END IF;
  END LOOP;
  IF mode='legacy' THEN
    IF cardinality(ids)>0 THEN
      RAISE EXCEPTION 'selected_member_ids requires selected_members mode' USING ERRCODE='23514';
    END IF;
    RETURN ticket; -- Missing/null legacy fields are preserved exactly.
  END IF;
  IF tenant IS NULL OR jsonb_typeof(ticket->'selected_member_ids') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Selected-members tickets require a tenant and a member UUID array (possibly empty)' USING ERRCODE='23514';
  END IF;
  IF ticket->>'visibility_mode' IS DISTINCT FROM 'members_only' THEN
    RAISE EXCEPTION 'Selected-members tickets require members_only visibility' USING ERRCODE='23514';
  END IF;
  FOREACH field IN ARRAY ARRAY['role_ids','member_group_ids'] LOOP
    IF ticket->field IS NOT NULL AND ticket->field NOT IN ('null'::jsonb,'[]'::jsonb) THEN
      RAISE EXCEPTION 'Selected-members tickets cannot use role/group restrictions' USING ERRCODE='23514';
    END IF;
  END LOOP;
  IF (ticket->'role_match_only' IS NOT NULL AND ticket->'role_match_only' NOT IN ('null'::jsonb,'false'::jsonb))
    OR (ticket->'create_member_records' IS NOT NULL AND ticket->'create_member_records' NOT IN ('null'::jsonb,'false'::jsonb))
    OR (ticket->'new_member_role_id' IS NOT NULL AND ticket->'new_member_role_id' NOT IN ('null'::jsonb,'""'::jsonb)) THEN
    RAISE EXCEPTION 'Selected-members tickets cannot use role matching or contact creation' USING ERRCODE='23514';
  END IF;
  FOREACH member_id IN ARRAY ids LOOP
    found_id := NULL;
    SELECT m.id INTO found_id FROM public.member m
      WHERE m.id=member_id AND m.tenant_id=tenant FOR SHARE;
    IF found_id IS NULL THEN
      RAISE EXCEPTION 'Every selected member must exist in this tenant' USING ERRCODE='23514';
    END IF;
  END LOOP;
  RETURN jsonb_set(ticket, '{selected_member_ids}', to_jsonb(ids));
END $$;
REVOKE ALL ON FUNCTION public.normalize_ticket_selected_member_audience(jsonb,uuid,jsonb) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.enforce_ticket_selected_member_audience()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  row_data jsonb := to_jsonb(NEW);
  old_data jsonb;
  config jsonb;
  old_config jsonb;
  ticket jsonb;
  old_ticket jsonb;
  normalized jsonb;
  tickets jsonb := '[]'::jsonb;
  config_was_string boolean := false;
BEGIN
  IF TG_OP='UPDATE' THEN old_data := to_jsonb(OLD); END IF;
  IF TG_TABLE_NAME='complex_event_ticket_class' THEN
    IF TG_OP='UPDATE' AND NEW.tenant_id IS DISTINCT FROM OLD.tenant_id THEN
      RAISE EXCEPTION 'Ticket tenant cannot be changed' USING ERRCODE='23514';
    END IF;
    IF TG_OP='UPDATE' AND NEW.complex_event_id IS DISTINCT FROM OLD.complex_event_id THEN
      RAISE EXCEPTION 'A ticket class cannot be moved to another complex event' USING ERRCODE='23514';
    END IF;
    IF TG_OP='INSERT' THEN
      PERFORM 1 FROM public.complex_event e
        WHERE e.id=NEW.complex_event_id AND e.tenant_id=NEW.tenant_id FOR SHARE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'The complex event must exist in this tenant' USING ERRCODE='23514';
      END IF;
    END IF;
    normalized := public.normalize_ticket_selected_member_audience(
      row_data, NEW.tenant_id, old_data);
    NEW := jsonb_populate_record(NEW, normalized);
    RETURN NEW;
  END IF;
  IF TG_OP='UPDATE' AND row_data->'pricing_config' IS NOT DISTINCT FROM old_data->'pricing_config'
    AND NEW.tenant_id IS NOT DISTINCT FROM OLD.tenant_id THEN
    RETURN NEW; -- Do not rewrite/parse historical pricing on unrelated updates.
  END IF;
  config := row_data->'pricing_config';
  IF config IS NULL OR config IN ('null'::jsonb,'""'::jsonb) THEN RETURN NEW; END IF;
  config_was_string := jsonb_typeof(config)='string';
  IF config_was_string THEN
    BEGIN config := (config #>> '{}')::jsonb;
    EXCEPTION WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'pricing_config must contain valid JSON' USING ERRCODE='23514';
    END;
  END IF;
  IF config='null'::jsonb THEN RETURN NEW; END IF;
  IF jsonb_typeof(config) <> 'object' THEN
    RAISE EXCEPTION 'pricing_config must be an object' USING ERRCODE='23514';
  END IF;
  IF config->'ticket_classes' IS NULL OR config->'ticket_classes'='null'::jsonb THEN RETURN NEW; END IF;
  IF jsonb_typeof(config->'ticket_classes') <> 'array' THEN
    RAISE EXCEPTION 'pricing_config.ticket_classes must be an array' USING ERRCODE='23514';
  END IF;
  old_config := old_data->'pricing_config';
  IF jsonb_typeof(old_config)='string' THEN
    BEGIN old_config := (old_config #>> '{}')::jsonb;
    EXCEPTION WHEN invalid_text_representation THEN old_config := NULL;
    END;
  END IF;
  FOR ticket IN SELECT value FROM jsonb_array_elements(config->'ticket_classes') LOOP
    old_ticket := NULL;
    IF ticket->>'id' IS NOT NULL AND jsonb_typeof(old_config->'ticket_classes')='array' THEN
      SELECT value INTO old_ticket FROM jsonb_array_elements(old_config->'ticket_classes')
        WHERE value->>'id'=ticket->>'id' LIMIT 1;
    END IF;
    normalized := public.normalize_ticket_selected_member_audience(ticket, NEW.tenant_id, old_ticket);
    tickets := tickets || jsonb_build_array(normalized);
  END LOOP;
  config := jsonb_set(config, '{ticket_classes}', tickets);
  IF config_was_string THEN config := to_jsonb(config::text); END IF;
  NEW := jsonb_populate_record(NEW, jsonb_build_object('pricing_config',config));
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.enforce_ticket_selected_member_audience() FROM PUBLIC;

DROP TRIGGER IF EXISTS ticket_selected_member_audience_guard ON public.complex_event_ticket_class;
CREATE TRIGGER ticket_selected_member_audience_guard
  BEFORE INSERT OR UPDATE ON public.complex_event_ticket_class
  FOR EACH ROW EXECUTE FUNCTION public.enforce_ticket_selected_member_audience();
DROP TRIGGER IF EXISTS ticket_selected_member_audience_guard ON public.event;
CREATE TRIGGER ticket_selected_member_audience_guard
  BEFORE INSERT OR UPDATE ON public.event
  FOR EACH ROW EXECUTE FUNCTION public.enforce_ticket_selected_member_audience();
