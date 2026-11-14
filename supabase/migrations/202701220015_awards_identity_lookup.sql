BEGIN;
CREATE FUNCTION public.awards_identity_lookup(p_tenant uuid,p_kind text,p_query text,p_page integer DEFAULT 1)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE needle text; rows jsonb;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Service authority required' USING ERRCODE='42501'; END IF;
  IF p_kind NOT IN ('member','contact') OR length(btrim(coalesce(p_query,'')))<2 OR length(p_query)>200
    OR p_page IS NULL OR p_page<1 OR p_page>1000 THEN RAISE EXCEPTION 'Enter at least two search characters'; END IF;
  needle:='%'||replace(replace(replace(lower(p_query),'\','\\'),'%','\%'),'_','\_')||'%';
  IF p_kind='member' THEN
    SELECT coalesce(jsonb_agg(row_data ORDER BY sort_email,id),'[]') INTO rows FROM (
      SELECT m.id,m.email sort_email,jsonb_build_object('id',m.id,'kind','member','email',m.email,
        'label',coalesce(nullif(to_jsonb(m)->>'full_name',''),nullif(concat_ws(' ',to_jsonb(m)->>'first_name',to_jsonb(m)->>'last_name'),''),m.email),
        'loginEnabled',coalesce((to_jsonb(m)->>'login_enabled')::boolean,true)) row_data
      FROM public.member m LEFT JOIN public.organization o ON o.id=m.organization_id
      WHERE (m.tenant_id=p_tenant OR m.tenant_id IS NULL AND o.tenant_id=p_tenant)
        AND m.email !~* '^deleted_' AND (
          lower(m.email) LIKE needle OR lower(concat_ws(' ',to_jsonb(m)->>'full_name',to_jsonb(m)->>'first_name',to_jsonb(m)->>'last_name')) LIKE needle)
      ORDER BY m.email,m.id LIMIT 25 OFFSET (p_page-1)*25
    ) matches;
  ELSE
    SELECT coalesce(jsonb_agg(row_data ORDER BY sort_email,id),'[]') INTO rows FROM (
      SELECT c.id,c.email sort_email,jsonb_build_object('id',c.id,'kind','contact','email',c.email,
        'label',coalesce(nullif(to_jsonb(c)->>'full_name',''),nullif(to_jsonb(c)->>'name',''),
          nullif(concat_ws(' ',to_jsonb(c)->>'first_name',to_jsonb(c)->>'last_name'),''),c.email)) row_data
      FROM public.organization_contact c JOIN public.organization o ON o.id=c.organization_id
      WHERE o.tenant_id=p_tenant AND (lower(c.email) LIKE needle OR
        lower(concat_ws(' ',to_jsonb(c)->>'full_name',to_jsonb(c)->>'name',to_jsonb(c)->>'first_name',to_jsonb(c)->>'last_name')) LIKE needle)
      ORDER BY c.email,c.id LIMIT 25 OFFSET (p_page-1)*25
    ) matches;
  END IF;
  RETURN jsonb_build_object('identities',rows,'page',p_page,'pageSize',25);
END $$;
REVOKE ALL ON FUNCTION public.awards_identity_lookup(uuid,text,text,integer) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.awards_identity_lookup(uuid,text,text,integer) TO service_role;
COMMIT;
