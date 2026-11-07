BEGIN;
CREATE TABLE public.membership_renewal_journey(
 tenant_id uuid PRIMARY KEY REFERENCES public.tenant(id),
 mode text NOT NULL CHECK(mode IN ('same_schedule','questionnaire')),
 form_id uuid REFERENCES public.form(id),
 revision bigint NOT NULL CHECK(revision>0),
 updated_by text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK(mode<>'questionnaire' OR form_id IS NOT NULL)
);
CREATE TABLE public.membership_renewal_journey_history(
 tenant_id uuid NOT NULL,revision bigint NOT NULL,mode text NOT NULL,form_id uuid,
 actor text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(tenant_id,revision)
);
ALTER TABLE public.membership_renewal_journey ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.membership_renewal_journey_history ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.membership_renewal_journey,public.membership_renewal_journey_history FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.membership_renewal_journey,public.membership_renewal_journey_history TO service_role;
CREATE POLICY renewal_journey_service ON public.membership_renewal_journey FOR SELECT TO service_role USING(true);
CREATE POLICY renewal_journey_history_service ON public.membership_renewal_journey_history FOR SELECT TO service_role USING(true);
CREATE FUNCTION public.save_membership_renewal_journey(p_tenant_id uuid,p_actor text,p_mode text,p_form_id uuid,p_expected_revision bigint)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE prior bigint; result public.membership_renewal_journey;
BEGIN
 IF p_mode IS NULL OR p_mode NOT IN ('same_schedule','questionnaire') OR nullif(trim(p_actor),'') IS NULL OR p_expected_revision IS NULL OR p_expected_revision<0 THEN
  RAISE EXCEPTION 'Invalid renewal journey settings' USING ERRCODE='22023'; END IF;
 PERFORM 1 FROM public.tenant WHERE id=p_tenant_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Tenant unavailable'; END IF;
 IF p_form_id IS NOT NULL THEN
  PERFORM 1 FROM public.form WHERE id=p_form_id AND tenant_id=p_tenant_id AND is_active=true AND require_authentication=true
    AND coalesce(form_type,'standard')='standard' AND nullif(trim(slug),'') IS NOT NULL FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Choose an active form requiring login from this tenant' USING ERRCODE='22023'; END IF;
 ELSIF p_mode='questionnaire' THEN RAISE EXCEPTION 'Choose a renewal entry form' USING ERRCODE='22023';
 END IF;
 SELECT revision INTO prior FROM public.membership_renewal_journey WHERE tenant_id=p_tenant_id;
 IF coalesce(prior,0)<>p_expected_revision THEN RAISE EXCEPTION 'Settings changed. Reload before saving' USING ERRCODE='40001'; END IF;
 INSERT INTO public.membership_renewal_journey(tenant_id,mode,form_id,revision,updated_by)
 VALUES(p_tenant_id,p_mode,p_form_id,coalesce(prior,0)+1,p_actor)
 ON CONFLICT(tenant_id) DO UPDATE SET mode=excluded.mode,form_id=excluded.form_id,revision=excluded.revision,updated_by=excluded.updated_by,updated_at=now()
 RETURNING * INTO result;
 INSERT INTO public.membership_renewal_journey_history(tenant_id,revision,mode,form_id,actor)
 VALUES(p_tenant_id,result.revision,p_mode,p_form_id,p_actor);
 RETURN to_jsonb(result);
END $$;
REVOKE ALL ON FUNCTION public.save_membership_renewal_journey(uuid,text,text,uuid,bigint) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.save_membership_renewal_journey(uuid,text,text,uuid,bigint) TO service_role;
COMMIT;
