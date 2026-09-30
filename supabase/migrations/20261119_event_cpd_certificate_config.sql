-- Certificate selection is independent of badge and points awards.
CREATE TABLE IF NOT EXISTS public.event_cpd_certificate_config (
  tenant_id uuid NOT NULL REFERENCES public.tenant(id) ON DELETE CASCADE,
  event_type text NOT NULL CHECK (event_type IN ('event','complex_event')),
  event_id uuid NOT NULL,
  config jsonb NOT NULL CHECK (jsonb_typeof(config) = 'object'),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,event_type,event_id)
);
CREATE INDEX IF NOT EXISTS event_cpd_certificate_config_event_idx
  ON public.event_cpd_certificate_config (tenant_id,event_id);
ALTER TABLE public.event_cpd_certificate_config ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS service_role_all ON public.event_cpd_certificate_config;
CREATE POLICY service_role_all ON public.event_cpd_certificate_config
  FOR SELECT TO service_role USING (true);
REVOKE ALL ON public.event_cpd_certificate_config FROM PUBLIC,anon,authenticated;
REVOKE INSERT,UPDATE,DELETE ON public.event_cpd_certificate_config FROM service_role;
GRANT SELECT ON public.event_cpd_certificate_config TO service_role;

-- One atomic replace; all event, ticket, date and tenant/template checks run
-- inside the transaction that commits the replacement.
CREATE OR REPLACE FUNCTION public.replace_event_cpd_certificate_config(
  p_tenant_id uuid,p_event_type text,p_event_id uuid,p_config jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE
  v_event jsonb;
  v_rule jsonb;
  v_ref text;
  v_template text;
  v_start text;
  v_end text;
  v_mode text;
  v_date_mode text;
  v_locked_template uuid;
  v_locked_ticket uuid;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'service_role is required'; END IF;
  IF p_tenant_id IS NULL OR p_event_type NOT IN ('event','complex_event') OR p_event_id IS NULL THEN
    RAISE EXCEPTION 'invalid event identity';
  END IF;
  IF p_event_type='event' THEN
    SELECT to_jsonb(e) INTO v_event FROM public.event e
    WHERE e.tenant_id=p_tenant_id AND e.id=p_event_id FOR UPDATE;
  ELSE
    SELECT to_jsonb(e) INTO v_event FROM public.complex_event e
    WHERE e.tenant_id=p_tenant_id AND e.id=p_event_id FOR UPDATE;
  END IF;
  IF v_event IS NULL THEN RAISE EXCEPTION 'event does not belong to tenant'; END IF;
  IF jsonb_typeof(p_config) IS DISTINCT FROM 'object'
    OR jsonb_typeof(p_config->'eventRule') IS DISTINCT FROM 'object'
    OR jsonb_typeof(p_config->'ticketRules') IS DISTINCT FROM 'object'
    OR (SELECT count(*) FROM jsonb_object_keys(
      CASE WHEN jsonb_typeof(p_config->'ticketRules')='object'
        THEN p_config->'ticketRules' ELSE '{}'::jsonb END)) > 500 THEN
    RAISE EXCEPTION 'invalid certificate configuration';
  END IF;
  FOR v_ref,v_rule IN
    SELECT NULL::text,p_config->'eventRule'
    UNION ALL
    SELECT key,value FROM jsonb_each(p_config->'ticketRules')
  LOOP
    IF jsonb_typeof(v_rule) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'invalid certificate rule'; END IF;
    v_mode:=v_rule->>'template_mode';
    v_date_mode:=v_rule->>'date_mode';
    v_template:=v_rule->>'template_id';
    v_start:=v_rule->>'start_date';
    v_end:=v_rule->>'end_date';
    IF NOT (v_rule ?& ARRAY['template_id','date_mode','start_date','end_date'])
      OR jsonb_typeof(v_rule->'template_id') IS NULL
      OR jsonb_typeof(v_rule->'template_id') NOT IN ('null','string')
      OR jsonb_typeof(v_rule->'start_date') IS NULL
      OR jsonb_typeof(v_rule->'start_date') NOT IN ('null','string')
      OR jsonb_typeof(v_rule->'end_date') IS NULL
      OR jsonb_typeof(v_rule->'end_date') NOT IN ('null','string') THEN
      RAISE EXCEPTION 'invalid certificate rule fields';
    END IF;
    IF v_ref IS NULL THEN
      IF v_date_mode NOT IN ('event','custom') OR v_date_mode IS NULL THEN RAISE EXCEPTION 'invalid event date mode'; END IF;
    ELSE
      IF NOT (v_rule ? 'template_mode') THEN RAISE EXCEPTION 'missing ticket template mode'; END IF;
      IF v_mode NOT IN ('inherit','override','none') OR v_mode IS NULL
         OR v_date_mode NOT IN ('inherit','custom') OR v_date_mode IS NULL THEN
        RAISE EXCEPTION 'invalid ticket certificate mode';
      END IF;
      IF p_event_type='event' THEN
        IF NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements(
            CASE WHEN jsonb_typeof(v_event->'pricing_config'->'ticket_classes')='array'
              THEN v_event->'pricing_config'->'ticket_classes' ELSE '[]'::jsonb END
          ) t WHERE t->>'id'=v_ref
        ) THEN RAISE EXCEPTION 'ticket does not belong to event and tenant'; END IF;
      ELSE
        SELECT t.id INTO v_locked_ticket FROM public.complex_event_ticket_class t
          WHERE t.id::text=v_ref AND t.complex_event_id=p_event_id AND t.tenant_id=p_tenant_id
          FOR SHARE;
        IF v_locked_ticket IS NULL THEN RAISE EXCEPTION 'ticket does not belong to event and tenant'; END IF;
      END IF;
      IF (v_mode='override') IS DISTINCT FROM (v_template IS NOT NULL) THEN
        RAISE EXCEPTION 'invalid ticket template override';
      END IF;
    END IF;
    IF v_template IS NOT NULL THEN
      SELECT t.id INTO v_locked_template FROM public.cpd_certificate_template t
      WHERE t.tenant_id=p_tenant_id AND t.id::text=v_template AND t.status='active'
        AND t.source_path IS NOT NULL FOR SHARE;
      IF v_locked_template IS NULL THEN RAISE EXCEPTION 'certificate template must be active and tenant-owned'; END IF;
    END IF;
    IF (v_ref IS NULL AND v_date_mode='event' OR v_ref IS NOT NULL AND v_date_mode='inherit')
      AND (v_start IS NOT NULL OR v_end IS NOT NULL) THEN
      RAISE EXCEPTION 'inherited certificate dates must be empty';
    END IF;
    IF v_date_mode='custom' AND v_start IS NULL THEN
      RAISE EXCEPTION 'custom certificate start date is required';
    END IF;
    IF v_start IS NOT NULL THEN
      IF v_start !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
        OR to_char(v_start::date,'YYYY-MM-DD') <> v_start THEN
        RAISE EXCEPTION 'invalid certificate start date';
      END IF;
    END IF;
    IF v_end IS NOT NULL THEN
      IF v_end !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
        OR to_char(v_end::date,'YYYY-MM-DD') <> v_end THEN
        RAISE EXCEPTION 'invalid certificate end date';
      END IF;
    END IF;
    IF v_start IS NOT NULL AND v_end IS NOT NULL AND v_start::date > v_end::date THEN
      RAISE EXCEPTION 'certificate end date precedes start date';
    END IF;
  END LOOP;
  INSERT INTO public.event_cpd_certificate_config(tenant_id,event_type,event_id,config)
  VALUES (p_tenant_id,p_event_type,p_event_id,p_config)
  ON CONFLICT (tenant_id,event_type,event_id)
  DO UPDATE SET config=EXCLUDED.config,updated_at=now();
  RETURN p_config;
END $$;
REVOKE ALL ON FUNCTION public.replace_event_cpd_certificate_config(uuid,text,uuid,jsonb)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.replace_event_cpd_certificate_config(uuid,text,uuid,jsonb)
  TO service_role;