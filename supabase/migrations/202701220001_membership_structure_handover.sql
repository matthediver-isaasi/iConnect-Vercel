-- Version boundaries, not purchased membership terms. No existing rows are rewritten.
CREATE TABLE IF NOT EXISTS public.membership_structure_schedule_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  operation text NOT NULL,
  before_schedule jsonb NOT NULL,
  after_schedule jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.membership_structure_schedule_audit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.membership_structure_schedule_audit FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON public.membership_structure_schedule_audit TO service_role;

CREATE OR REPLACE FUNCTION public.membership_structure_scope(c public.membership_tier_config)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT jsonb_build_array(c.tenant_id, coalesce(c.structure_scope_type, 'organization'),
    c.structure_field_id, CASE WHEN c.structure_field_id IS NULL THEN ''
      ELSE lower(btrim(coalesce(c.structure_match_value, ''))) END)::text
$$;

-- Covers legacy writers and deletion as well as the transactional save.
CREATE OR REPLACE FUNCTION public.lock_membership_structure_schedule()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.tenant_id IS DISTINCT FROM OLD.tenant_id THEN
    RAISE EXCEPTION USING ERRCODE = 'PT409', MESSAGE = 'Cannot move a membership structure between tenants.';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'membership-structure:' || CASE WHEN TG_OP = 'DELETE' THEN OLD.tenant_id ELSE NEW.tenant_id END::text, 0));
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS membership_structure_schedule_lock ON public.membership_tier_config;
CREATE TRIGGER membership_structure_schedule_lock BEFORE INSERT OR UPDATE OR DELETE
ON public.membership_tier_config FOR EACH ROW EXECUTE FUNCTION public.lock_membership_structure_schedule();

CREATE OR REPLACE FUNCTION public.check_membership_structure_schedule()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE scope_key text;
BEGIN
  scope_key := public.membership_structure_scope(NEW);
  IF EXISTS (
    SELECT 1 FROM public.membership_tier_config a
    WHERE public.membership_structure_scope(a) = scope_key
      AND (a.effective_to < a.effective_from OR EXISTS (
        SELECT 1 FROM public.membership_tier_config b
        WHERE public.membership_structure_scope(b) = scope_key AND a.id <> b.id
          AND coalesce(a.effective_from, '-infinity'::date) <= coalesce(b.effective_to, 'infinity'::date)
          AND coalesce(b.effective_from, '-infinity'::date) <= coalesce(a.effective_to, 'infinity'::date)
      ))
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'PT409',
      MESSAGE = 'Membership structure dates overlap. Reload and review this scope before saving.';
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS membership_structure_schedule_check ON public.membership_tier_config;
CREATE CONSTRAINT TRIGGER membership_structure_schedule_check AFTER INSERT OR UPDATE
ON public.membership_tier_config DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.check_membership_structure_schedule();

CREATE OR REPLACE FUNCTION public.save_membership_structure(
  p_tenant_id uuid, p_config_id uuid, p_config jsonb, p_children jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  saved public.membership_tier_config;
  prior public.membership_tier_config;
  proposed public.membership_tier_config;
  scope_key text;
  before_rows jsonb;
  columns_sql text;
  values_sql text;
  patch jsonb;
  child_key text;
  child_table text;
  child_row jsonb;
  allowed text[];
  next_start date;
  previous_start date;
BEGIN
  IF p_tenant_id IS NULL OR jsonb_typeof(p_config) IS DISTINCT FROM 'object'
    OR jsonb_typeof(p_children) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'Invalid membership structure payload';
  END IF;
  -- Held before any row write; concurrent saves always re-read the committed timeline.
  PERFORM pg_advisory_xact_lock(hashtextextended('membership-structure:' || p_tenant_id::text, 0));
  proposed := jsonb_populate_record(NULL::public.membership_tier_config, p_config);
  IF proposed.effective_from IS NULL
    OR coalesce(proposed.structure_scope_type, 'organization') NOT IN ('member', 'organization')
    OR (proposed.structure_field_id IS NOT NULL AND nullif(btrim(proposed.structure_match_value), '') IS NULL) THEN
    RAISE EXCEPTION USING ERRCODE = 'PT409', MESSAGE = 'A valid start date and scope are required.';
  END IF;
  proposed.tenant_id := p_tenant_id;
  scope_key := public.membership_structure_scope(proposed);
  IF p_config_id IS NOT NULL THEN
    SELECT * INTO prior FROM public.membership_tier_config
      WHERE id = p_config_id AND tenant_id = p_tenant_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE = 'PT409', MESSAGE = 'Membership structure not found.'; END IF;
    IF prior.effective_to IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = 'PT409', MESSAGE = 'This retained membership structure is read-only. Duplicate it instead.';
    END IF;
    IF public.membership_structure_scope(prior) <> scope_key THEN
      RAISE EXCEPTION USING ERRCODE = 'PT409', MESSAGE = 'Duplicate the structure to change its scope.';
    END IF;
    SELECT max(effective_from) FILTER (WHERE effective_from < prior.effective_from),
      min(effective_from) FILTER (WHERE effective_from > prior.effective_from)
      INTO previous_start, next_start
      FROM public.membership_tier_config
      WHERE public.membership_structure_scope(membership_tier_config) = scope_key AND id <> p_config_id;
    IF proposed.effective_from <= previous_start OR proposed.effective_from >= next_start THEN
      RAISE EXCEPTION USING ERRCODE = 'PT409', MESSAGE = 'The start date cannot cross another version. Duplicate it instead.';
    END IF;
  END IF;
  IF EXISTS (SELECT 1 FROM public.membership_tier_config c
    WHERE public.membership_structure_scope(c) = scope_key
      AND c.id IS DISTINCT FROM p_config_id AND c.effective_from = proposed.effective_from) THEN
    RAISE EXCEPTION USING ERRCODE = 'PT409', MESSAGE = 'A structure already starts on that day in this scope.';
  END IF;
  SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY c.effective_from NULLS FIRST, c.id), '[]'::jsonb)
    INTO before_rows FROM public.membership_tier_config c WHERE public.membership_structure_scope(c) = scope_key;
  -- When moving a start date, move only the previously attached boundary.
  IF prior.id IS NOT NULL AND prior.effective_from IS DISTINCT FROM proposed.effective_from THEN
    UPDATE public.membership_tier_config c SET effective_to = proposed.effective_from - 1, updated_at = now()
      WHERE public.membership_structure_scope(c) = scope_key AND c.id <> prior.id
        AND c.effective_to = prior.effective_from - 1
        AND (c.effective_from IS NULL OR c.effective_from < proposed.effective_from);
  END IF;
  patch := (p_config - ARRAY['id','tenant_id','created_at','updated_at','effective_to'])
    || jsonb_build_object('tenant_id', p_tenant_id, 'updated_at', now());
  -- Only supplied columns are assigned, preserving defaults and omitted optional settings.
  IF EXISTS (SELECT 1 FROM jsonb_object_keys(patch) k WHERE NOT EXISTS (
    SELECT 1 FROM pg_attribute a WHERE a.attrelid = 'public.membership_tier_config'::regclass
      AND a.attname = k AND a.attnum > 0 AND NOT a.attisdropped)) THEN
    RAISE EXCEPTION 'Unknown membership structure field';
  END IF;
  SELECT string_agg(format('%I', k), ','), string_agg(format('r.%I', k), ',')
    INTO columns_sql, values_sql FROM jsonb_object_keys(patch) k;
  IF p_config_id IS NULL THEN
    EXECUTE format('INSERT INTO public.membership_tier_config (%s)
      SELECT %s FROM jsonb_populate_record(NULL::public.membership_tier_config,$1) r RETURNING *',
      columns_sql, values_sql) INTO saved USING patch;
  ELSE
    EXECUTE format('UPDATE public.membership_tier_config SET (%s) =
      (SELECT %s FROM jsonb_populate_record(NULL::public.membership_tier_config,$1) r)
      WHERE id=$2 AND tenant_id=$3 RETURNING *', columns_sql, values_sql)
      INTO saved USING patch, p_config_id, p_tenant_id;
  END IF;
  -- Cap every overlapping neighbour, including finite-ended future rows.
  -- Never delete versions or extend intentional gaps.
  WITH boundaries AS (
    SELECT id, lead(effective_from) OVER (ORDER BY effective_from NULLS FIRST, id) AS successor_start
      FROM public.membership_tier_config c WHERE public.membership_structure_scope(c) = scope_key
  )
  UPDATE public.membership_tier_config c
    SET effective_to = b.successor_start - 1, updated_at = now()
    FROM boundaries b WHERE c.id = b.id AND b.successor_start IS NOT NULL
      AND (c.effective_to IS NULL OR c.effective_to >= b.successor_start);

  FOR child_key, child_table, allowed IN SELECT * FROM (VALUES
    ('bands','membership_tier_band',ARRAY['label','min_value','max_value','annual_cost','display_order','vat_rate','match_value','dd_monthly_amount','nominal_code']),
    ('discounts','membership_tier_discount',ARRAY['field_id','field_label','match_value','match_condition','discount_type','discount_value','label','sort_order']),
    ('vatOverrides','membership_tier_vat_override',ARRAY['field_id','field_label','match_value','match_condition','vat_rate','label','sort_order']),
    ('reminders','membership_tier_reminder',ARRAY['label','offset_value','offset_unit','direction','email_template_id','recipient_role_ids','is_active','sort_order'])
  ) AS children(key,tab,cols) LOOP
    IF NOT p_children ? child_key THEN CONTINUE; END IF;
    IF jsonb_typeof(p_children->child_key) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Invalid child list'; END IF;
    EXECUTE format('DELETE FROM public.%I WHERE config_id=$1 AND tenant_id=$2', child_table)
      USING saved.id, p_tenant_id;
    FOR child_row IN SELECT value FROM jsonb_array_elements(p_children->child_key) LOOP
      IF jsonb_typeof(child_row) IS DISTINCT FROM 'object' OR EXISTS (
        SELECT 1 FROM jsonb_object_keys(child_row) k WHERE NOT k = ANY(allowed)
      ) THEN RAISE EXCEPTION 'Invalid child fields'; END IF;
      child_row := child_row || jsonb_build_object('config_id',saved.id,'tenant_id',p_tenant_id);
      SELECT string_agg(format('%I',k),','), string_agg(format('r.%I',k),',')
        INTO columns_sql, values_sql FROM jsonb_object_keys(child_row) k;
      EXECUTE format('INSERT INTO public.%I (%s) SELECT %s FROM jsonb_populate_record(NULL::public.%I,$1) r',
        child_table, columns_sql, values_sql, child_table) USING child_row;
    END LOOP;
  END LOOP;
  INSERT INTO public.membership_structure_schedule_audit(tenant_id,operation,before_schedule,after_schedule)
    SELECT p_tenant_id, CASE WHEN prior.id IS NULL THEN 'create' ELSE 'update' END, before_rows,
      coalesce(jsonb_agg(to_jsonb(c) ORDER BY c.effective_from NULLS FIRST,c.id),'[]'::jsonb)
      FROM public.membership_tier_config c WHERE public.membership_structure_scope(c) = scope_key;
  SELECT * INTO saved FROM public.membership_tier_config WHERE id = saved.id;
  RETURN to_jsonb(saved);
END $$;
REVOKE ALL ON FUNCTION public.membership_structure_scope(public.membership_tier_config),
  public.lock_membership_structure_schedule(), public.check_membership_structure_schedule(),
  public.save_membership_structure(uuid,uuid,jsonb,jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.save_membership_structure(uuid,uuid,jsonb,jsonb) TO service_role;
NOTIFY pgrst, 'reload schema';
