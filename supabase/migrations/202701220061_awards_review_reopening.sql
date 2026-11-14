BEGIN;
CREATE FUNCTION public.awards_require_active_review(p_tenant uuid,p_award uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  PERFORM 1 FROM public.awards_competition WHERE tenant_id=p_tenant AND id=p_award
    AND state NOT IN ('results_approved','completed','archived') FOR SHARE NOWAIT;
  IF NOT FOUND THEN RAISE EXCEPTION 'Reopen the award for review before changing assessments'; END IF;
EXCEPTION WHEN lock_not_available THEN
  RAISE EXCEPTION 'Another award action is running; retry with current state' USING ERRCODE='40001';
END $$;
CREATE FUNCTION public.awards_reopen_review(p_tenant uuid,p_award uuid,p_version bigint,p_actor_kind text,p_actor uuid,p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE w public.awards_competition; previous text;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Service authority required' USING ERRCODE='42501'; END IF;
  IF p_actor_kind NOT IN ('member','tenant_user') OR p_actor IS NULL OR length(btrim(coalesce(p_reason,'')))=0 OR length(p_reason)>2000 THEN
    RAISE EXCEPTION 'Configuration authority and reason required'; END IF;
  SELECT * INTO w FROM public.awards_competition WHERE tenant_id=p_tenant AND id=p_award FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Award unavailable'; END IF;
  IF w.version IS DISTINCT FROM p_version THEN RAISE EXCEPTION 'Award changed' USING ERRCODE='40001'; END IF;
  IF w.state NOT IN ('results_approved','completed','archived') THEN RAISE EXCEPTION 'Only a finalised award needs review reopening'; END IF;
  previous:=w.state;
  UPDATE public.awards_competition SET state='judging',version=version+1 WHERE id=w.id RETURNING * INTO w;
  INSERT INTO public.awards_audit_event(tenant_id,award_id,actor_kind,actor_id,action,subject_id,reason,changes)
    VALUES(p_tenant,w.id,p_actor_kind,p_actor,'award.review_reopened',w.id,p_reason,
      jsonb_build_object('previous_state',previous,'state',w.state,'version',w.version,'publication','unchanged'));
  RETURN to_jsonb(w);
END $$;
REVOKE ALL ON FUNCTION public.awards_require_active_review(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.awards_reopen_review(uuid,uuid,bigint,text,uuid,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.awards_reopen_review(uuid,uuid,bigint,text,uuid,text) TO service_role;
COMMIT;
