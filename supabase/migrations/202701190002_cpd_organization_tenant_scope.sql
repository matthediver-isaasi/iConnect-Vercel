BEGIN;
-- Match the existing merge endpoint: a direct tenant wins; only missing
-- direct tenancy falls back to the member's organisation.
CREATE OR REPLACE FUNCTION public.cpd_member_belongs_to_tenant(p_member uuid,p_tenant uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
  SELECT EXISTS(SELECT 1 FROM public.member m
    LEFT JOIN public.organization o ON o.id=m.organization_id
    WHERE m.id=p_member AND COALESCE(m.tenant_id,o.tenant_id)=p_tenant)
$$;
REVOKE ALL ON FUNCTION public.cpd_member_belongs_to_tenant(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;

-- Only the reviewed ownership/history functions are changed. Refuse unexpected
-- definitions instead of rewriting arbitrary live functions.
DO $$
DECLARE definition text; old_fragment text; new_fragment text;
BEGIN
  SELECT pg_get_functiondef('public.transfer_member_cpd(uuid,uuid,uuid,uuid)'::regprocedure) INTO definition;
  old_fragment := '(SELECT count(*) FROM public.member WHERE tenant_id=p_tenant_id AND id IN(p_source_id,p_target_id))<>2
    OR NOT EXISTS(SELECT 1 FROM public.member WHERE tenant_id=p_tenant_id AND id=p_actor_id)';
  new_fragment := 'NOT public.cpd_member_belongs_to_tenant(p_source_id,p_tenant_id)
    OR NOT public.cpd_member_belongs_to_tenant(p_target_id,p_tenant_id)
    OR NOT public.cpd_member_belongs_to_tenant(p_actor_id,p_tenant_id)';
  IF strpos(definition,old_fragment)>0 THEN EXECUTE replace(definition,old_fragment,new_fragment);
  ELSIF strpos(definition,new_fragment)=0 THEN RAISE EXCEPTION 'Unexpected CPD transfer definition'; END IF;
  SELECT pg_get_functiondef('public.get_member_cpd_points_history(uuid,uuid,integer,integer)'::regprocedure) INTO definition;
  old_fragment := 'NOT EXISTS(SELECT 1 FROM public.member WHERE id=p_member_id AND tenant_id=p_tenant_id)';
  new_fragment := 'NOT public.cpd_member_belongs_to_tenant(p_member_id,p_tenant_id)';
  IF strpos(definition,old_fragment)>0 THEN EXECUTE replace(definition,old_fragment,new_fragment);
  ELSIF strpos(definition,new_fragment)=0 THEN RAISE EXCEPTION 'Unexpected CPD history definition'; END IF;
END $$;
COMMIT;
