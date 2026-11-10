BEGIN;
ALTER TABLE public.membership_renewal_journey
 ADD COLUMN IF NOT EXISTS post_grace_form_id uuid REFERENCES public.form(id);
ALTER TABLE public.membership_renewal_journey_history
 ADD COLUMN IF NOT EXISTS post_grace_form_id uuid;
CREATE TABLE IF NOT EXISTS public.membership_entry_configuration_audit (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 actor text NOT NULL,
 snapshot_hash text NOT NULL,
 before_snapshot jsonb NOT NULL,
 after_snapshot jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.membership_entry_configuration_audit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.membership_entry_configuration_audit FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.membership_entry_configuration_audit TO service_role;
DROP POLICY IF EXISTS membership_entry_audit_read ON public.membership_entry_configuration_audit;
CREATE POLICY membership_entry_audit_read ON public.membership_entry_configuration_audit
 FOR SELECT TO service_role USING(true);

CREATE OR REPLACE FUNCTION public.save_membership_renewal_journey(
 p_tenant_id uuid,p_actor text,p_mode text,p_form_id uuid,p_expected_revision bigint,p_post_grace_form_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE prior bigint; result public.membership_renewal_journey; target uuid;
BEGIN
 IF p_mode IS NULL OR p_mode NOT IN ('same_schedule','questionnaire')
 OR nullif(trim(p_actor),'') IS NULL OR p_expected_revision IS NULL OR p_expected_revision<0 THEN
  RAISE EXCEPTION 'Invalid renewal journey settings' USING ERRCODE='22023';
 END IF;
 PERFORM 1 FROM public.tenant WHERE id=p_tenant_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Tenant unavailable'; END IF;
 IF p_mode='questionnaire' AND p_form_id IS NULL THEN
  RAISE EXCEPTION 'Choose a renewal entry form' USING ERRCODE='22023';
 END IF;
 FOREACH target IN ARRAY ARRAY[p_form_id,p_post_grace_form_id] LOOP
  IF target IS NOT NULL THEN
   PERFORM 1 FROM public.form WHERE id=target AND tenant_id=p_tenant_id
    AND is_active=true AND require_authentication=true AND archived_at IS NULL
    AND (deactivate_at IS NULL OR deactivate_at>now())
    AND coalesce(form_type,'standard')='standard' AND nullif(trim(slug),'') IS NOT NULL FOR SHARE;
   IF NOT FOUND THEN RAISE EXCEPTION 'Choose an active form requiring login from this tenant' USING ERRCODE='22023'; END IF;
  END IF;
 END LOOP;
 SELECT revision INTO prior FROM public.membership_renewal_journey WHERE tenant_id=p_tenant_id;
 IF coalesce(prior,0)<>p_expected_revision THEN
  RAISE EXCEPTION 'Settings changed. Reload before saving' USING ERRCODE='40001';
 END IF;
 INSERT INTO public.membership_renewal_journey(tenant_id,mode,form_id,post_grace_form_id,revision,updated_by)
 VALUES(p_tenant_id,p_mode,p_form_id,p_post_grace_form_id,coalesce(prior,0)+1,p_actor)
 ON CONFLICT(tenant_id) DO UPDATE SET mode=excluded.mode,form_id=excluded.form_id,
  post_grace_form_id=excluded.post_grace_form_id,revision=excluded.revision,
  updated_by=excluded.updated_by,updated_at=now()
 RETURNING * INTO result;
 INSERT INTO public.membership_renewal_journey_history(tenant_id,revision,mode,form_id,post_grace_form_id,actor)
 VALUES(p_tenant_id,result.revision,p_mode,p_form_id,p_post_grace_form_id,p_actor);
 RETURN to_jsonb(result);
END $$;
REVOKE ALL ON FUNCTION public.save_membership_renewal_journey(uuid,text,text,uuid,bigint,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.save_membership_renewal_journey(uuid,text,text,uuid,bigint,uuid) TO service_role;

-- Older deployed clients may save ordinary renewal settings during rollout.
-- Serialize them on the same tenant and retain the new independent destination.
CREATE OR REPLACE FUNCTION public.save_membership_renewal_journey(
 p_tenant_id uuid,p_actor text,p_mode text,p_form_id uuid,p_expected_revision bigint)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE restart uuid;
BEGIN
 PERFORM 1 FROM public.tenant WHERE id=p_tenant_id FOR UPDATE;
 SELECT post_grace_form_id INTO restart FROM public.membership_renewal_journey WHERE tenant_id=p_tenant_id;
 RETURN public.save_membership_renewal_journey(p_tenant_id,p_actor,p_mode,p_form_id,p_expected_revision,restart);
END $$;
COMMIT;
