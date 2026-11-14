BEGIN;
CREATE TABLE public.assessment_scoring_template (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenant(id),
  series_id uuid NOT NULL,
  revision integer NOT NULL CHECK(revision>0),
  name text NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 300),
  definition jsonb NOT NULL CHECK(jsonb_typeof(definition)='object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,id),
  UNIQUE(tenant_id,series_id,revision)
);
ALTER TABLE public.assessment_scoring_template ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.assessment_scoring_template FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.assessment_scoring_template TO service_role;
CREATE TRIGGER immutable_evidence BEFORE UPDATE OR DELETE ON public.assessment_scoring_template
  FOR EACH ROW EXECUTE FUNCTION public.awards_immutable_evidence();
ALTER TABLE public.assessment_criteria_version ADD COLUMN template_version_id uuid;
ALTER TABLE public.assessment_criteria_version ADD FOREIGN KEY(tenant_id,template_version_id)
  REFERENCES public.assessment_scoring_template(tenant_id,id);
CREATE FUNCTION public.assessment_save_template(p_tenant uuid,p_series uuid,p_revision integer,p_name text,p_definition jsonb,p_actor_kind text,p_actor uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE series uuid:=coalesce(p_series,gen_random_uuid()); latest integer; saved public.assessment_scoring_template;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Service authority required' USING ERRCODE='42501'; END IF;
  IF p_actor_kind NOT IN ('member','tenant_user') OR p_actor IS NULL THEN RAISE EXCEPTION 'Actor required'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant::text||':'||series::text,0));
  SELECT coalesce(max(revision),0) INTO latest FROM public.assessment_scoring_template WHERE tenant_id=p_tenant AND series_id=series;
  IF latest IS DISTINCT FROM p_revision OR p_series IS NOT NULL AND latest=0 THEN RAISE EXCEPTION 'Template changed or unavailable' USING ERRCODE='40001'; END IF;
  IF p_definition->>'optionalPolicy' NOT IN ('incomplete','renormalise') THEN RAISE EXCEPTION 'Explicit scoring policy required'; END IF;
  INSERT INTO public.assessment_scoring_template(tenant_id,series_id,revision,name,definition)
    VALUES(p_tenant,series,latest+1,p_name,p_definition) RETURNING * INTO saved;
  INSERT INTO public.awards_audit_event(tenant_id,actor_kind,actor_id,action,subject_id,changes)
    VALUES(p_tenant,p_actor_kind,p_actor,'criteria.template_saved',saved.id,jsonb_build_object('series_id',series,'revision',saved.revision));
  RETURN to_jsonb(saved);
END $$;
CREATE FUNCTION public.assessment_list_templates(p_tenant uuid,p_page integer DEFAULT 1)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE rows jsonb; total integer;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Service authority required' USING ERRCODE='42501'; END IF;
  IF p_page IS NULL OR p_page NOT BETWEEN 1 AND 10000 THEN RAISE EXCEPTION 'Invalid page'; END IF;
  SELECT count(DISTINCT series_id) INTO total FROM public.assessment_scoring_template WHERE tenant_id=p_tenant;
  SELECT coalesce(jsonb_agg(to_jsonb(selected) ORDER BY selected.series_id),'[]') INTO rows FROM (
    SELECT DISTINCT ON(series_id) id,series_id,revision,name,definition,created_at
      FROM public.assessment_scoring_template WHERE tenant_id=p_tenant ORDER BY series_id,revision DESC LIMIT 50 OFFSET (p_page-1)*50
  ) selected;
  RETURN jsonb_build_object('templates',rows,'total',total,'page',p_page,'pageSize',50);
END $$;
REVOKE ALL ON FUNCTION public.assessment_save_template(uuid,uuid,integer,text,jsonb,text,uuid) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.assessment_list_templates(uuid,integer) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.assessment_save_template(uuid,uuid,integer,text,jsonb,text,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.assessment_list_templates(uuid,integer) TO service_role;
COMMIT;
