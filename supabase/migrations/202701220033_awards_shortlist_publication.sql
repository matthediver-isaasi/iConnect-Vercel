BEGIN;
ALTER TABLE public.awards_delivery_release ALTER COLUMN outcome_revision_id DROP NOT NULL;
ALTER TABLE public.awards_delivery_release ADD COLUMN shortlist_id uuid REFERENCES public.assessment_shortlist_decision(id);
ALTER TABLE public.awards_delivery_release ADD UNIQUE(shortlist_id);
ALTER TABLE public.awards_delivery_release ADD CHECK(num_nonnulls(outcome_revision_id,shortlist_id)=1);
CREATE TABLE public.awards_shortlist_publication (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  award_id uuid NOT NULL,
  round_id uuid NOT NULL,
  application_id uuid NOT NULL,
  shortlist_id uuid NOT NULL,
  event_link_id uuid,
  audience text NOT NULL CHECK(audience IN ('public','member')),
  revision integer NOT NULL CHECK(revision>0),
  action text NOT NULL CHECK(action IN ('publish','correct','retract')),
  safe_projection jsonb NOT NULL,
  reason text NOT NULL CHECK(length(btrim(reason))>0),
  actor_kind text NOT NULL CHECK(actor_kind IN ('member','tenant_user')),
  actor_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(tenant_id,award_id,round_id) REFERENCES public.assessment_round(tenant_id,award_id,id),
  FOREIGN KEY(tenant_id,round_id,application_id,shortlist_id) REFERENCES public.assessment_shortlist_decision(tenant_id,round_id,application_id,id),
  FOREIGN KEY(tenant_id,event_link_id) REFERENCES public.awards_event_link(tenant_id,id)
);
CREATE UNIQUE INDEX awards_shortlist_publication_version ON public.awards_shortlist_publication
  (application_id,round_id,audience,coalesce(event_link_id,'00000000-0000-0000-0000-000000000000'::uuid),revision);
ALTER TABLE public.awards_shortlist_publication ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.awards_shortlist_publication FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.awards_shortlist_publication TO service_role;
CREATE TRIGGER immutable_evidence BEFORE UPDATE OR DELETE ON public.awards_shortlist_publication
FOR EACH ROW EXECUTE FUNCTION public.awards_immutable_evidence();
CREATE FUNCTION public.awards_shortlist_release(p_tenant uuid,p_shortlist uuid,p_actor_kind text,p_actor uuid,p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE decision public.assessment_shortlist_decision; release uuid;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Service authority required' USING ERRCODE='42501'; END IF;
  IF p_actor_kind NOT IN ('member','tenant_user') OR p_actor IS NULL OR length(btrim(coalesce(p_reason,'')))=0 THEN RAISE EXCEPTION 'Release authority required'; END IF;
  SELECT * INTO decision FROM public.assessment_shortlist_decision WHERE tenant_id=p_tenant AND id=p_shortlist;
  IF NOT FOUND THEN RAISE EXCEPTION 'Shortlist unavailable'; END IF;
  PERFORM 1 FROM public.assessment_round WHERE tenant_id=p_tenant AND id=decision.round_id FOR UPDATE;
  IF NOT public.awards_shortlist_is_current(p_tenant,decision.id) THEN RAISE EXCEPTION 'Confirmed shortlist evidence changed; review before release'; END IF;
  IF decision.state<>'confirmed' OR EXISTS(SELECT 1 FROM public.assessment_shortlist_decision
    WHERE round_id=decision.round_id AND application_id=decision.application_id AND revision>decision.revision) THEN RAISE EXCEPTION 'Current confirmed shortlist required'; END IF;
  SELECT id INTO release FROM public.awards_delivery_release WHERE tenant_id=p_tenant AND shortlist_id=decision.id;
  IF release IS NULL THEN
    INSERT INTO public.awards_delivery_release(tenant_id,award_id,shortlist_id,actor_kind,actor_id,reason)
      VALUES(p_tenant,decision.award_id,decision.id,p_actor_kind,p_actor,p_reason) RETURNING id INTO release;
    INSERT INTO public.awards_audit_event(tenant_id,award_id,actor_kind,actor_id,action,subject_id,reason)
      VALUES(p_tenant,decision.award_id,p_actor_kind,p_actor,'shortlist.released',release,p_reason);
  END IF;
  RETURN jsonb_build_object('release_id',release);
END $$;
CREATE FUNCTION public.awards_publish_shortlist(p_tenant uuid,p_shortlist uuid,p_event uuid,p_audience text,p_action text,
  p_revision integer,p_projection jsonb,p_actor_kind text,p_actor uuid,p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE decision public.assessment_shortlist_decision; previous public.awards_shortlist_publication; saved public.awards_shortlist_publication; programme uuid;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Service authority required' USING ERRCODE='42501'; END IF;
  IF p_actor_kind NOT IN ('member','tenant_user') OR p_actor IS NULL OR length(btrim(coalesce(p_reason,'')))=0
    OR p_audience NOT IN ('public','member') OR p_action NOT IN ('publish','correct','retract') THEN RAISE EXCEPTION 'Publication authority required'; END IF;
  SELECT * INTO decision FROM public.assessment_shortlist_decision WHERE tenant_id=p_tenant AND id=p_shortlist;
  IF NOT FOUND THEN RAISE EXCEPTION 'Shortlist unavailable'; END IF;
  PERFORM 1 FROM public.assessment_round WHERE tenant_id=p_tenant AND id=decision.round_id FOR UPDATE;
  IF p_action<>'retract' AND (decision.state<>'confirmed' OR EXISTS(SELECT 1 FROM public.assessment_shortlist_decision
    WHERE round_id=decision.round_id AND application_id=decision.application_id AND revision>decision.revision)
    OR NOT EXISTS(SELECT 1 FROM public.awards_application WHERE tenant_id=p_tenant AND id=decision.application_id AND eligibility='eligible')) THEN
    RAISE EXCEPTION 'Current eligible confirmed shortlist required'; END IF;
  IF p_action<>'retract' AND NOT public.awards_shortlist_is_current(p_tenant,decision.id) THEN RAISE EXCEPTION 'Confirmed shortlist evidence changed; review before publication'; END IF;
  IF p_event IS NOT NULL THEN
    SELECT programme_id INTO programme FROM public.awards_competition WHERE tenant_id=p_tenant AND id=decision.award_id;
    IF NOT EXISTS(SELECT 1 FROM public.awards_event_link WHERE tenant_id=p_tenant AND id=p_event
      AND (award_id=decision.award_id OR programme_id=programme)) THEN RAISE EXCEPTION 'Event association unavailable'; END IF;
  END IF;
  SELECT * INTO previous FROM public.awards_shortlist_publication WHERE tenant_id=p_tenant AND round_id=decision.round_id
    AND application_id=decision.application_id AND audience=p_audience AND event_link_id IS NOT DISTINCT FROM p_event ORDER BY revision DESC LIMIT 1;
  IF coalesce(previous.revision,0) IS DISTINCT FROM p_revision THEN RAISE EXCEPTION 'Shortlist publication changed' USING ERRCODE='40001'; END IF;
  IF p_action IN ('correct','retract') AND previous.id IS NULL THEN RAISE EXCEPTION 'No existing shortlist publication'; END IF;
  IF p_action<>'retract' AND (jsonb_typeof(p_projection) IS DISTINCT FROM 'object'
    OR length(btrim(coalesce(p_projection->>'title','')))=0 OR length(p_projection->>'title')>300
    OR length(coalesce(p_projection->>'recipient',''))>300 OR length(coalesce(p_projection->>'summary',''))>5000) THEN
    RAISE EXCEPTION 'Explicit safe shortlist text required'; END IF;
  INSERT INTO public.awards_shortlist_publication(tenant_id,award_id,round_id,application_id,shortlist_id,event_link_id,audience,
    revision,action,safe_projection,reason,actor_kind,actor_id)
    VALUES(p_tenant,decision.award_id,decision.round_id,decision.application_id,decision.id,p_event,p_audience,p_revision+1,p_action,
      CASE WHEN p_action='retract' THEN '{}' ELSE jsonb_build_object('title',p_projection->>'title',
        'recipient',p_projection->>'recipient','summary',p_projection->>'summary') END,p_reason,p_actor_kind,p_actor) RETURNING * INTO saved;
  INSERT INTO public.awards_audit_event(tenant_id,award_id,actor_kind,actor_id,action,subject_id,reason,changes)
    VALUES(p_tenant,decision.award_id,p_actor_kind,p_actor,'shortlist.'||p_action,saved.id,p_reason,jsonb_build_object('revision',saved.revision,'audience',p_audience));
  RETURN jsonb_build_object('id',saved.id,'revision',saved.revision,'action',saved.action);
END $$;
CREATE FUNCTION public.awards_public_shortlists(p_tenant uuid,p_award uuid,p_audience text,p_event uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE result jsonb;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Service authority required' USING ERRCODE='42501'; END IF;
  SELECT coalesce(jsonb_agg(safe_projection ORDER BY created_at,id),'[]') INTO result FROM (
    SELECT DISTINCT ON(round_id,application_id) * FROM public.awards_shortlist_publication
      WHERE tenant_id=p_tenant AND award_id=p_award AND audience=p_audience AND event_link_id IS NOT DISTINCT FROM p_event
      ORDER BY round_id,application_id,revision DESC
  ) latest WHERE action<>'retract' AND EXISTS(SELECT 1 FROM public.assessment_shortlist_decision s
    JOIN public.awards_application a ON a.id=s.application_id WHERE s.id=latest.shortlist_id AND s.state='confirmed' AND a.eligibility='eligible'
      AND public.awards_shortlist_is_current(p_tenant,s.id)
      AND NOT EXISTS(SELECT 1 FROM public.assessment_shortlist_decision newer WHERE newer.round_id=s.round_id AND newer.application_id=s.application_id AND newer.revision>s.revision));
  RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.awards_shortlist_release(uuid,uuid,text,uuid,text) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.awards_publish_shortlist(uuid,uuid,uuid,text,text,integer,jsonb,text,uuid,text) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.awards_public_shortlists(uuid,uuid,text,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.awards_shortlist_release(uuid,uuid,text,uuid,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.awards_publish_shortlist(uuid,uuid,uuid,text,text,integer,jsonb,text,uuid,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.awards_public_shortlists(uuid,uuid,text,uuid) TO service_role;
COMMIT;
