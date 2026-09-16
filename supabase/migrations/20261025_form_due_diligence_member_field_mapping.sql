-- Task #4423: allow due-diligence field mapping actions to target the member
-- linked to the submission. Member mutations and their workflow recovery
-- payload are committed together for both ordinary transitions and the strict
-- initialization retry path.

ALTER TABLE public.stage_field_mapping_action
  ADD COLUMN IF NOT EXISTS target_entity TEXT NOT NULL DEFAULT 'organization';

ALTER TABLE public.stage_field_mapping_action
  DROP CONSTRAINT IF EXISTS stage_field_mapping_action_target_entity_check;
ALTER TABLE public.stage_field_mapping_action
  ADD CONSTRAINT stage_field_mapping_action_target_entity_check
  CHECK (target_entity IN ('organization', 'member'));

-- One durable occurrence identifies the current stage-action execution. It
-- must not be derived from updated_at: review/history writes can change that
-- timestamp without entering a new stage, and initialization leases are
-- intentionally replaced on retry.
ALTER TABLE public.form_submission_due_diligence
  ADD COLUMN IF NOT EXISTS stage_action_occurrence_id UUID;
UPDATE public.form_submission_due_diligence
   SET stage_action_occurrence_id = gen_random_uuid()
 WHERE stage_action_occurrence_id IS NULL;
ALTER TABLE public.form_submission_due_diligence
  ALTER COLUMN stage_action_occurrence_id SET DEFAULT gen_random_uuid();
ALTER TABLE public.form_submission_due_diligence
  ALTER COLUMN stage_action_occurrence_id SET NOT NULL;

ALTER TABLE public.form_due_diligence_field_mapping_workflow_outbox
  ADD COLUMN IF NOT EXISTS target_entity TEXT NOT NULL DEFAULT 'organization';
ALTER TABLE public.form_due_diligence_field_mapping_workflow_outbox
  ADD COLUMN IF NOT EXISTS member_id UUID REFERENCES public.member(id) ON DELETE CASCADE;
ALTER TABLE public.form_due_diligence_field_mapping_workflow_outbox
  ALTER COLUMN organization_id DROP NOT NULL;

ALTER TABLE public.form_due_diligence_field_mapping_workflow_outbox
  DROP CONSTRAINT IF EXISTS form_dd_field_mapping_outbox_target_entity_chk;
ALTER TABLE public.form_due_diligence_field_mapping_workflow_outbox
  ADD CONSTRAINT form_dd_field_mapping_outbox_target_entity_chk
  CHECK (target_entity IN ('organization', 'member'));

CREATE INDEX IF NOT EXISTS form_dd_field_mapping_workflow_outbox_member_idx
  ON public.form_due_diligence_field_mapping_workflow_outbox
    (member_id, form_submission_due_diligence_id, created_at)
  WHERE target_entity = 'member';

-- The eight-argument function predates member targets. Remove it so callers
-- cannot accidentally bypass target validation through the legacy overload.
DROP FUNCTION IF EXISTS public.apply_form_due_diligence_field_mapping_with_outbox(
  UUID, UUID, TEXT, TEXT, UUID, JSONB, UUID, TEXT
);

CREATE OR REPLACE FUNCTION public.apply_form_due_diligence_field_mapping_with_outbox(
  p_tenant_id UUID,
  p_due_diligence_submission_id UUID,
  p_event_key TEXT,
  p_event_type TEXT,
  p_organization_id UUID DEFAULT NULL,
  p_mutation JSONB DEFAULT '{}'::JSONB,
  p_preference_field_id UUID DEFAULT NULL,
  p_preference_value TEXT DEFAULT NULL,
  p_target_entity TEXT DEFAULT 'organization',
  p_member_id UUID DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_organization public.organization%ROWTYPE;
  v_member public.member%ROWTYPE;
  v_updated_member public.member%ROWTYPE;
  v_before JSONB;
  v_after JSONB;
  v_preference_value TEXT;
  v_preference_exists BOOLEAN := FALSE;
  v_key TEXT;
  v_existing_outbox public.form_due_diligence_field_mapping_workflow_outbox%ROWTYPE;
BEGIN
  IF p_event_type NOT IN ('core', 'preference')
     OR p_target_entity NOT IN ('organization', 'member')
     OR NULLIF(BTRIM(p_event_key), '') IS NULL THEN
    RAISE EXCEPTION 'invalid field-mapping workflow outbox event' USING ERRCODE = '22023';
  END IF;

  PERFORM 1
    FROM public.form_submission_due_diligence
   WHERE id = p_due_diligence_submission_id
     AND tenant_id = p_tenant_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'due-diligence submission is not tenant-owned' USING ERRCODE = 'P0001';
  END IF;

  -- Serialize callers for one occurrence key. An ON CONFLICT after the
  -- mutation is unsafe: a changed value on a legitimate stage re-entry could
  -- update the row while silently losing its new workflow payload.
  PERFORM pg_advisory_xact_lock(hashtextextended(
    p_due_diligence_submission_id::TEXT || ':' || p_event_key,
    4423
  ));
  SELECT * INTO v_existing_outbox
    FROM public.form_due_diligence_field_mapping_workflow_outbox
   WHERE form_submission_due_diligence_id = p_due_diligence_submission_id
     AND tenant_id = p_tenant_id
     AND event_key = p_event_key
   FOR UPDATE;
  IF FOUND THEN
    IF v_existing_outbox.event_type IS DISTINCT FROM p_event_type
       OR v_existing_outbox.target_entity IS DISTINCT FROM p_target_entity
       OR v_existing_outbox.organization_id IS DISTINCT FROM p_organization_id
       OR v_existing_outbox.member_id IS DISTINCT FROM p_member_id THEN
      RAISE EXCEPTION 'field-mapping event key already exists with a different target'
        USING ERRCODE = 'P0001';
    END IF;
    IF p_event_type = 'core'
       AND (
         (v_existing_outbox.payload ? 'mutation'
           AND v_existing_outbox.payload->'mutation'
             IS DISTINCT FROM COALESCE(p_mutation, '{}'::JSONB))
         OR (
           NOT (v_existing_outbox.payload ? 'mutation')
           AND NOT (COALESCE(v_existing_outbox.payload->'after', '{}'::JSONB)
                    @> COALESCE(p_mutation, '{}'::JSONB))
         )
       ) THEN
      RAISE EXCEPTION 'field-mapping event key already exists with a different mutation'
        USING ERRCODE = 'P0001';
    END IF;
    IF p_event_type = 'preference'
       AND (
         v_existing_outbox.payload->>'field_id' IS DISTINCT FROM p_preference_field_id::TEXT
         OR COALESCE(v_existing_outbox.payload->'new_value', 'null'::JSONB)
            IS DISTINCT FROM COALESCE(to_jsonb(p_preference_value), 'null'::JSONB)
       ) THEN
      RAISE EXCEPTION 'field-mapping event key already exists with a different preference payload'
        USING ERRCODE = 'P0001';
    END IF;
    IF p_event_type = 'core' THEN
      RETURN jsonb_build_object(
        'applied', FALSE,
        'replayed', TRUE,
        'created', FALSE,
        'before', v_existing_outbox.payload->'before',
        'after', v_existing_outbox.payload->'after'
      );
    END IF;
    RETURN jsonb_build_object(
      'applied', FALSE,
      'replayed', TRUE,
      'created', FALSE,
      'previous_value', v_existing_outbox.payload->'previous_value',
      'new_value', v_existing_outbox.payload->'new_value'
    );
  END IF;

  IF p_target_entity = 'organization' THEN
    IF p_organization_id IS NULL THEN
      RAISE EXCEPTION 'organization target is required' USING ERRCODE = '22023';
    END IF;
    SELECT * INTO v_organization
      FROM public.organization
     WHERE id = p_organization_id
       AND tenant_id = p_tenant_id
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'organization is not tenant-owned' USING ERRCODE = 'P0001';
    END IF;
  ELSE
    IF p_member_id IS NULL THEN
      RAISE EXCEPTION 'member target is required' USING ERRCODE = '22023';
    END IF;
    SELECT * INTO v_member
      FROM public.member
     WHERE id = p_member_id
       AND tenant_id = p_tenant_id
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'member is not tenant-owned' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  IF p_event_type = 'core' THEN
    IF p_target_entity = 'organization' THEN
      IF EXISTS (
        SELECT 1
          FROM jsonb_object_keys(COALESCE(p_mutation, '{}'::JSONB)) AS key_name
         WHERE key_name NOT IN (
           'name', 'email', 'invoicing_email', 'phone', 'website_url',
           'description', 'logo_url', 'invoicing_address', 'address'
         )
      ) THEN
        RAISE EXCEPTION 'invalid organization field-mapping mutation' USING ERRCODE = '22023';
      END IF;

      v_before := to_jsonb(v_organization);
      v_organization := jsonb_populate_record(v_organization, COALESCE(p_mutation, '{}'::JSONB));
      IF v_before IS NOT DISTINCT FROM to_jsonb(v_organization) THEN
        RETURN jsonb_build_object('applied', FALSE, 'created', FALSE, 'after', v_before);
      END IF;
      UPDATE public.organization AS org
         SET name = v_organization.name,
             email = v_organization.email,
             invoicing_email = v_organization.invoicing_email,
             phone = v_organization.phone,
             website_url = v_organization.website_url,
             description = v_organization.description,
             logo_url = v_organization.logo_url,
             invoicing_address = v_organization.invoicing_address,
             address = v_organization.address
       WHERE id = p_organization_id AND tenant_id = p_tenant_id
       RETURNING to_jsonb(org) INTO v_after;
      INSERT INTO public.form_due_diligence_field_mapping_workflow_outbox (
        form_submission_due_diligence_id, tenant_id, event_key, event_type,
        target_entity, organization_id, member_id, payload
      ) VALUES (
        p_due_diligence_submission_id, p_tenant_id, p_event_key, 'core',
        'organization', p_organization_id, NULL,
        jsonb_build_object(
          'before', v_before,
          'after', v_after,
          'mutation', COALESCE(p_mutation, '{}'::JSONB)
        )
      );
      RETURN jsonb_build_object(
        'applied', TRUE, 'created', FALSE, 'before', v_before, 'after', v_after
      );
    END IF;

    -- These are the only writable member core fields exposed by the shared
    -- form-mapping contract. The dynamic assignment keeps values typed by the
    -- real member column instead of coercing everything to an unsafe column.
    IF EXISTS (
      SELECT 1
        FROM jsonb_object_keys(COALESCE(p_mutation, '{}'::JSONB)) AS key_name
       WHERE key_name NOT IN (
         'first_name', 'last_name', 'job_title', 'mobile', 'landline'
       )
    ) THEN
      RAISE EXCEPTION 'invalid member field-mapping mutation' USING ERRCODE = '22023';
    END IF;

    v_before := to_jsonb(v_member);
    v_updated_member := jsonb_populate_record(v_member, COALESCE(p_mutation, '{}'::JSONB));
    IF v_before IS NOT DISTINCT FROM to_jsonb(v_updated_member) THEN
      RETURN jsonb_build_object('applied', FALSE, 'created', FALSE, 'after', v_before);
    END IF;

    FOR v_key IN SELECT key FROM jsonb_object_keys(COALESCE(p_mutation, '{}'::JSONB)) AS key
    LOOP
      EXECUTE format(
        'UPDATE public.member SET %1$I = (jsonb_populate_record(NULL::public.member, $1)).%1$I
          WHERE id = $2 AND tenant_id = $3',
        v_key
      ) USING p_mutation, p_member_id, p_tenant_id;
    END LOOP;
    SELECT to_jsonb(m) INTO v_after
      FROM public.member AS m
     WHERE m.id = p_member_id AND m.tenant_id = p_tenant_id;

    INSERT INTO public.form_due_diligence_field_mapping_workflow_outbox (
      form_submission_due_diligence_id, tenant_id, event_key, event_type,
      target_entity, organization_id, member_id, payload
    ) VALUES (
      p_due_diligence_submission_id, p_tenant_id, p_event_key, 'core',
      'member', NULL, p_member_id,
      jsonb_build_object(
        'before', v_before,
        'after', v_after,
        'mutation', COALESCE(p_mutation, '{}'::JSONB)
      )
    );
    RETURN jsonb_build_object(
      'applied', TRUE, 'created', FALSE, 'before', v_before, 'after', v_after
    );
  END IF;

  IF p_preference_field_id IS NULL THEN
    RAISE EXCEPTION 'preference field is required' USING ERRCODE = '22023';
  END IF;

  IF p_target_entity = 'organization' THEN
    PERFORM 1
      FROM public.preference_field
     WHERE id = p_preference_field_id
       AND tenant_id = p_tenant_id
       AND entity_scope = 'organization';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'organization preference field is not tenant-owned' USING ERRCODE = 'P0001';
    END IF;
    SELECT value INTO v_preference_value
      FROM public.organization_preference_value
     WHERE organization_id = p_organization_id AND field_id = p_preference_field_id
     FOR UPDATE;
    v_preference_exists := FOUND;
    IF v_preference_exists AND v_preference_value IS NOT DISTINCT FROM p_preference_value THEN
      RETURN jsonb_build_object('applied', FALSE, 'created', FALSE);
    END IF;
    IF v_preference_exists THEN
      UPDATE public.organization_preference_value
         SET value = p_preference_value, updated_at = NOW()
       WHERE organization_id = p_organization_id AND field_id = p_preference_field_id;
    ELSE
      INSERT INTO public.organization_preference_value (organization_id, field_id, value)
      VALUES (p_organization_id, p_preference_field_id, p_preference_value);
    END IF;
  ELSE
    PERFORM 1
      FROM public.preference_field
     WHERE id = p_preference_field_id
       AND tenant_id = p_tenant_id
       AND entity_scope = 'member';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'member preference field is not tenant-owned' USING ERRCODE = 'P0001';
    END IF;
    SELECT value INTO v_preference_value
      FROM public.member_preference_value
     WHERE member_id = p_member_id AND field_id = p_preference_field_id
     FOR UPDATE;
    v_preference_exists := FOUND;
    IF v_preference_exists AND v_preference_value IS NOT DISTINCT FROM p_preference_value THEN
      RETURN jsonb_build_object('applied', FALSE, 'created', FALSE);
    END IF;
    IF p_preference_value IS NULL THEN
      DELETE FROM public.member_preference_value
       WHERE member_id = p_member_id AND field_id = p_preference_field_id;
    ELSIF v_preference_exists THEN
      UPDATE public.member_preference_value
         SET value = p_preference_value
       WHERE member_id = p_member_id AND field_id = p_preference_field_id;
    ELSE
      INSERT INTO public.member_preference_value (member_id, field_id, value)
      VALUES (p_member_id, p_preference_field_id, p_preference_value);
    END IF;
  END IF;

  INSERT INTO public.form_due_diligence_field_mapping_workflow_outbox (
    form_submission_due_diligence_id, tenant_id, event_key, event_type,
    target_entity, organization_id, member_id, payload
  ) VALUES (
    p_due_diligence_submission_id, p_tenant_id, p_event_key, 'preference',
    p_target_entity, p_organization_id, p_member_id,
    jsonb_build_object(
      'field_id', p_preference_field_id,
      'previous_value', v_preference_value,
      'new_value', p_preference_value
    )
  );
  RETURN jsonb_build_object(
    'applied', TRUE,
    'created', NOT v_preference_exists,
    'previous_value', v_preference_value,
    'new_value', p_preference_value
  );
END;
$$;

REVOKE ALL ON FUNCTION public.apply_form_due_diligence_field_mapping_with_outbox(
  UUID, UUID, TEXT, TEXT, UUID, JSONB, UUID, TEXT, TEXT, UUID
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_form_due_diligence_field_mapping_with_outbox(
  UUID, UUID, TEXT, TEXT, UUID, JSONB, UUID, TEXT, TEXT, UUID
) TO service_role;