BEGIN;
CREATE FUNCTION public.assessment_panel_policy(p_tenant uuid,p_round uuid,p_version bigint,p_proposers text[],p_approvers text[],p_discussion text[],
  p_actor_kind text,p_actor uuid,p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE r public.assessment_round;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Service authority required' USING ERRCODE='42501'; END IF;
  IF p_actor_kind NOT IN ('member','tenant_user') OR p_actor IS NULL OR length(btrim(coalesce(p_reason,'')))=0
    OR p_proposers IS NULL OR p_approvers IS NULL OR p_discussion IS NULL
    OR NOT (p_proposers||p_approvers||p_discussion <@ ARRAY['judge','chair','approver']::text[]) THEN RAISE EXCEPTION 'Valid panel roles and reason required'; END IF;
  SELECT * INTO r FROM public.assessment_round WHERE tenant_id=p_tenant AND id=p_round FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Round unavailable'; END IF;
  IF r.version IS DISTINCT FROM p_version THEN RAISE EXCEPTION 'Round changed' USING ERRCODE='40001'; END IF;
  IF r.state<>'draft' THEN RAISE EXCEPTION 'Panel authority is locked once judging starts'; END IF;
  UPDATE public.assessment_round SET moderation_proposers=p_proposers,moderation_approvers=p_approvers,moderation_discussion=p_discussion,
    version=version+1 WHERE id=r.id RETURNING * INTO r;
  INSERT INTO public.awards_audit_event(tenant_id,award_id,actor_kind,actor_id,action,subject_id,reason,changes)
    VALUES(p_tenant,r.award_id,p_actor_kind,p_actor,'round.panel_policy',r.id,p_reason,
      jsonb_build_object('proposers',p_proposers,'approvers',p_approvers,'discussion',p_discussion,'version',r.version));
  RETURN to_jsonb(r);
END $$;
REVOKE ALL ON FUNCTION public.assessment_panel_policy(uuid,uuid,bigint,text[],text[],text[],text,uuid,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.assessment_panel_policy(uuid,uuid,bigint,text[],text[],text[],text,uuid,text) TO service_role;
COMMIT;
