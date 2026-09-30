-- Follow-on only: match session membership's direct-or-inherited tenant scope.
-- A non-null direct member tenant always wins (including a conflicting tenant).
DO $migration$
DECLARE
  definition text := pg_get_functiondef('public.accept_anonymous_survey_completion(jsonb,jsonb,uuid,text,text)'::regprocedure);
  old_lookup text := 'SELECT lower(trim(email)) INTO v_email FROM public.member
      WHERE id=p_member_id AND tenant_id=v_tenant FOR SHARE;';
  new_lookup text := 'SELECT lower(trim(m.email)) INTO v_email FROM public.member m
      WHERE m.id=p_member_id AND coalesce(m.tenant_id,
        (SELECT o.tenant_id FROM public.organization o WHERE o.id=m.organization_id FOR SHARE))=v_tenant
      FOR SHARE OF m;';
BEGIN
  IF position(new_lookup IN definition)>0 THEN RETURN; END IF;
  IF position(old_lookup IN definition)=0 THEN
    RAISE EXCEPTION 'Unexpected anonymous acceptance member lookup; review before applying';
  END IF;
  EXECUTE replace(definition,old_lookup,new_lookup);
END;
$migration$;
REVOKE ALL ON FUNCTION public.accept_anonymous_survey_completion(jsonb,jsonb,uuid,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.accept_anonymous_survey_completion(jsonb,jsonb,uuid,text,text) TO service_role;