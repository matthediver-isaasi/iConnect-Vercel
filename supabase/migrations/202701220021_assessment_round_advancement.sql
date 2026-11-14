BEGIN;
ALTER TABLE public.assessment_shortlist_decision ADD UNIQUE(tenant_id,round_id,application_id,id);
CREATE TABLE public.assessment_round_entry (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  award_id uuid NOT NULL,
  round_id uuid NOT NULL,
  application_id uuid NOT NULL,
  source_round_id uuid NOT NULL,
  source_shortlist_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(round_id,application_id),
  FOREIGN KEY(tenant_id,award_id,round_id) REFERENCES public.assessment_round(tenant_id,award_id,id),
  FOREIGN KEY(tenant_id,award_id,source_round_id) REFERENCES public.assessment_round(tenant_id,award_id,id),
  FOREIGN KEY(tenant_id,award_id,application_id) REFERENCES public.awards_application(tenant_id,award_id,id)
  ,FOREIGN KEY(tenant_id,source_round_id,application_id,source_shortlist_id)
    REFERENCES public.assessment_shortlist_decision(tenant_id,round_id,application_id,id)
);
ALTER TABLE public.assessment_round_entry ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.assessment_round_entry FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.assessment_round_entry TO service_role;
CREATE TRIGGER immutable_evidence BEFORE UPDATE OR DELETE ON public.assessment_round_entry
  FOR EACH ROW EXECUTE FUNCTION public.awards_immutable_evidence();
CREATE FUNCTION public.assessment_round_candidate(p_tenant uuid,p_round uuid,p_application uuid)
RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog,public AS $$
  SELECT EXISTS(SELECT 1 FROM public.assessment_round r JOIN public.awards_application a ON a.tenant_id=r.tenant_id AND a.award_id=r.award_id
    WHERE r.tenant_id=p_tenant AND r.id=p_round AND a.id=p_application AND
      (r.position=1 OR EXISTS(SELECT 1 FROM public.assessment_round_entry e WHERE e.tenant_id=p_tenant AND e.round_id=p_round AND e.application_id=p_application)));
$$;
REVOKE ALL ON FUNCTION public.assessment_round_candidate(uuid,uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.assessment_advance_round(p_tenant uuid,p_source uuid,p_target uuid,p_selections jsonb,
  p_actor_kind text,p_actor uuid,p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE source public.assessment_round; target public.assessment_round; selection jsonb;
  decision public.assessment_shortlist_decision; entry public.assessment_round_entry; ids uuid[]:='{}';
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Service authority required' USING ERRCODE='42501'; END IF;
  IF p_actor_kind NOT IN ('member','tenant_user') OR p_actor IS NULL OR length(btrim(coalesce(p_reason,'')))=0
    OR jsonb_typeof(p_selections) IS DISTINCT FROM 'array' OR jsonb_array_length(p_selections) NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'Selections, actor and reason required'; END IF;
  SELECT * INTO source FROM public.assessment_round WHERE tenant_id=p_tenant AND id=p_source;
  PERFORM 1 FROM public.awards_competition WHERE tenant_id=p_tenant AND id=source.award_id FOR UPDATE;
  PERFORM 1 FROM public.assessment_round WHERE tenant_id=p_tenant AND id IN (p_source,p_target) ORDER BY id FOR UPDATE;
  SELECT * INTO source FROM public.assessment_round WHERE tenant_id=p_tenant AND id=p_source;
  SELECT * INTO target FROM public.assessment_round WHERE tenant_id=p_tenant AND id=p_target;
  IF source.id IS NULL OR target.id IS NULL OR source.award_id<>target.award_id OR target.position<=source.position OR target.state<>'draft' THEN
    RAISE EXCEPTION 'Choose a later draft round in the same award'; END IF;
  FOR selection IN SELECT value FROM jsonb_array_elements(p_selections) LOOP
    SELECT * INTO decision FROM public.assessment_shortlist_decision
      WHERE tenant_id=p_tenant AND round_id=source.id AND application_id=(selection->>'applicationId')::uuid ORDER BY revision DESC LIMIT 1;
    IF NOT FOUND OR decision.id IS DISTINCT FROM (selection->>'shortlistDecisionId')::uuid OR decision.state<>'confirmed' THEN
      RAISE EXCEPTION 'Only current confirmed shortlist decisions can advance' USING ERRCODE='40001'; END IF;
    PERFORM 1 FROM public.awards_application WHERE tenant_id=p_tenant AND id=decision.application_id AND eligibility='eligible' FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Application no longer eligible'; END IF;
    SELECT * INTO entry FROM public.assessment_round_entry WHERE round_id=target.id AND application_id=decision.application_id;
    IF FOUND THEN
      IF entry.source_shortlist_id<>decision.id THEN RAISE EXCEPTION 'Application already advanced from different evidence'; END IF;
    ELSE
      INSERT INTO public.assessment_round_entry(tenant_id,award_id,round_id,application_id,source_round_id,source_shortlist_id)
        VALUES(p_tenant,source.award_id,target.id,decision.application_id,source.id,decision.id) RETURNING * INTO entry;
      INSERT INTO public.awards_audit_event(tenant_id,award_id,actor_kind,actor_id,action,subject_id,reason,changes)
        VALUES(p_tenant,source.award_id,p_actor_kind,p_actor,'round.advanced',entry.id,p_reason,
          jsonb_build_object('application_id',decision.application_id,'source_round_id',source.id,'target_round_id',target.id));
    END IF;
    ids:=array_append(ids,entry.id);
  END LOOP;
  RETURN jsonb_build_object('entry_ids',ids);
END $$;
CREATE FUNCTION public.assessment_round_entry_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE position integer;
BEGIN
  SELECT r.position INTO position FROM public.assessment_round r WHERE r.tenant_id=NEW.tenant_id AND r.id=NEW.round_id;
  IF position>1 AND NOT EXISTS(SELECT 1 FROM public.assessment_round_entry e
    WHERE e.tenant_id=NEW.tenant_id AND e.round_id=NEW.round_id AND e.application_id=NEW.application_id) THEN
    RAISE EXCEPTION 'Application has not been advanced to this round'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER assessment_assignment_round_entry BEFORE INSERT ON public.assessment_assignment
FOR EACH ROW EXECUTE FUNCTION public.assessment_round_entry_guard();
REVOKE ALL ON FUNCTION public.assessment_round_entry_guard() FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.assessment_advance_round(uuid,uuid,uuid,jsonb,text,uuid,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.assessment_advance_round(uuid,uuid,uuid,jsonb,text,uuid,text) TO service_role;
COMMIT;
