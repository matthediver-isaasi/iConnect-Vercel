BEGIN;
CREATE TABLE public.membership_joining_journey(
 tenant_id uuid PRIMARY KEY REFERENCES public.tenant(id),
 form_id uuid REFERENCES public.form(id), revision bigint NOT NULL CHECK(revision>0),
 updated_by text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.membership_joining_journey_history(
 tenant_id uuid NOT NULL,revision bigint NOT NULL,form_id uuid,actor text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(tenant_id,revision)
);
ALTER TABLE public.membership_joining_journey ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.membership_joining_journey_history ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.membership_joining_journey,public.membership_joining_journey_history FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.membership_joining_journey,public.membership_joining_journey_history TO service_role;
CREATE POLICY joining_journey_service ON public.membership_joining_journey FOR SELECT TO service_role USING(true);
CREATE POLICY joining_journey_history_service ON public.membership_joining_journey_history FOR SELECT TO service_role USING(true);
CREATE FUNCTION public.save_membership_joining_journey(p_tenant_id uuid,p_actor text,p_form_id uuid,p_expected_revision bigint)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE prior bigint; result public.membership_joining_journey;
BEGIN
 IF nullif(trim(p_actor),'') IS NULL OR p_expected_revision IS NULL OR p_expected_revision<0 THEN
  RAISE EXCEPTION 'Invalid joining journey settings' USING ERRCODE='22023'; END IF;
 PERFORM 1 FROM public.tenant WHERE id=p_tenant_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Tenant unavailable'; END IF;
 IF p_form_id IS NOT NULL THEN
  PERFORM 1 FROM public.form WHERE id=p_form_id AND tenant_id=p_tenant_id AND is_active=true
    AND coalesce(form_type,'standard')='standard' AND nullif(trim(slug),'') IS NOT NULL FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Choose an active standard form from this tenant' USING ERRCODE='22023'; END IF;
 END IF;
 SELECT revision INTO prior FROM public.membership_joining_journey WHERE tenant_id=p_tenant_id;
 IF coalesce(prior,0)<>p_expected_revision THEN RAISE EXCEPTION 'Settings changed. Reload before saving' USING ERRCODE='40001'; END IF;
 INSERT INTO public.membership_joining_journey(tenant_id,form_id,revision,updated_by)
 VALUES(p_tenant_id,p_form_id,coalesce(prior,0)+1,p_actor)
 ON CONFLICT(tenant_id) DO UPDATE SET form_id=excluded.form_id,revision=excluded.revision,updated_by=excluded.updated_by,updated_at=now()
 RETURNING * INTO result;
 INSERT INTO public.membership_joining_journey_history(tenant_id,revision,form_id,actor)
 VALUES(p_tenant_id,result.revision,p_form_id,p_actor);
 RETURN to_jsonb(result);
END $$;
REVOKE ALL ON FUNCTION public.save_membership_joining_journey(uuid,text,uuid,bigint) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.save_membership_joining_journey(uuid,text,uuid,bigint) TO service_role;
COMMIT;
