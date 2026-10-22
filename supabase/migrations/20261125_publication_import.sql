-- Reviewed separately; never run this migration as part of a workbook preview.
BEGIN;
CREATE TABLE IF NOT EXISTS public.publication_import_receipt (
  plan_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES public.tenant(id),
  actor_key text NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.publication_import_receipt ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.publication_import_receipt FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON public.publication_import_receipt TO service_role;

-- Projection avoids exposing password/payment/private member data to the service.
CREATE OR REPLACE FUNCTION public.publication_import_identity(j jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path = public AS $$
 SELECT coalesce(jsonb_object_agg(key,value),'{}'::jsonb) FROM jsonb_each(j)
 WHERE key = ANY(ARRAY['id','tenant_id','first_name','last_name','email','role_id',
 'member_excluded_features','is_active','deleted_at','status','role']);
$$;

CREATE OR REPLACE FUNCTION public.publication_import_snapshot(p_tenant uuid, p_member uuid, p_tenant_user text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE m jsonb; a jsonb; r jsonb; result jsonb; lookup text;
BEGIN
 SELECT public.publication_import_identity(to_jsonb(x)) INTO m FROM public.member x
 WHERE id=p_member AND tenant_id=p_tenant;
 IF p_tenant_user IS NULL THEN a:=m;
 ELSE
   SELECT public.publication_import_identity(to_jsonb(x)) INTO a FROM public.tenant_user x
   WHERE id::text=p_tenant_user AND tenant_id=p_tenant AND status='active';
   IF a IS NULL THEN
     SELECT jsonb_build_object('id',i.id,'tenant_id',tm.tenant_id,'role',tm.role,'status',tm.status)
     INTO a FROM public.tenant_identity i JOIN public.tenant_membership tm ON tm.identity_id=i.id
     WHERE i.id=p_tenant_user AND tm.tenant_id=p_tenant AND tm.status='active'
       AND tm.role IN ('owner','admin') ORDER BY tm.id LIMIT 1;
   END IF;
 END IF;
 SELECT to_jsonb(x) INTO r FROM public.role x WHERE id=(m->>'role_id')::uuid AND tenant_id=p_tenant;
 result:=jsonb_build_object('actor',a,'member',m,'role',r,
   'settings',(SELECT to_jsonb(x) FROM public.article_brief_settings x WHERE tenant_id=p_tenant),
   'members',coalesce((SELECT jsonb_agg(public.publication_import_identity(to_jsonb(x)) ORDER BY id)
      FROM (SELECT * FROM public.member WHERE tenant_id=p_tenant ORDER BY id LIMIT 10001) x),'[]'::jsonb),
   'externalWriters',coalesce((SELECT jsonb_agg(public.publication_import_identity(to_jsonb(x)) ORDER BY id)
      FROM (SELECT * FROM public.external_writer WHERE tenant_id=p_tenant ORDER BY id LIMIT 10001) x),'[]'::jsonb),
   'briefs',coalesce((SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM
      (SELECT id,title,category,sla,contract,deadline,writer_deadline,editor_deadline,status,
         assigned_writer_id,external_writer_id,review_owner_id,notes,contributor_type,
         case_study_required,copyright_required
       FROM public.article_brief WHERE tenant_id=p_tenant ORDER BY id LIMIT 10001) x),'[]'::jsonb),
   'accessItems',coalesce((SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM
      (SELECT id,item_key,parent_id,is_active FROM public.role_access_item
       WHERE is_active IS DISTINCT FROM false ORDER BY id LIMIT 10001) x),'[]'::jsonb));
 FOREACH lookup IN ARRAY ARRAY['members','externalWriters','briefs','accessItems'] LOOP
   IF jsonb_array_length(result->lookup)>10000 THEN
     RAISE EXCEPTION 'Publication import lookup limit exceeded: % (maximum 10000)',lookup;
   END IF;
 END LOOP;
 RETURN result;
END $$;

CREATE OR REPLACE FUNCTION public.publication_import_result(p_tenant uuid,p_member uuid,p_tenant_user text,p_plan uuid)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
 SELECT result FROM public.publication_import_receipt WHERE plan_id=p_plan AND tenant_id=p_tenant
 AND actor_key=CASE WHEN p_tenant_user IS NOT NULL THEN 'tenant_user:'||p_tenant_user ELSE 'member:'||p_member END;
$$;

CREATE OR REPLACE FUNCTION public.publication_import_apply(
 p_tenant uuid,p_member uuid,p_tenant_user text,p_plan uuid,p_expires timestamptz,p_snapshot jsonb,p_rows jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
SET lock_timeout = '5s' SET statement_timeout = '25s' AS $$
DECLARE
 previous jsonb; current_snapshot jsonb; item jsonb; payload jsonb; existing public.article_brief;
 inserted public.article_brief; matched integer; created integer:=0; skipped integer:=0;
 started_at timestamptz:=clock_timestamp();
 results jsonb:='[]'; result jsonb; k text; expected jsonb;
 allowed text[]:=ARRAY['title','category','sla','contract','deadline','writer_deadline','editor_deadline',
 'status','assigned_writer_id','external_writer_id','review_owner_id','notes','contributor_type',
 'case_study_required','copyright_required'];
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(p_plan::text,0));
 previous:=public.publication_import_result(p_tenant,p_member,p_tenant_user,p_plan);
 IF previous IS NOT NULL THEN RETURN previous; END IF;
 IF p_expires<=clock_timestamp() THEN RAISE EXCEPTION 'stale expired plan'; END IF;
 IF jsonb_typeof(p_rows) IS DISTINCT FROM 'array' OR jsonb_array_length(p_rows) NOT BETWEEN 1 AND 100
 THEN RAISE EXCEPTION 'Invalid row count'; END IF;
 -- This table lock also serializes manual CRUD and competing import plans.
 LOCK TABLE public.article_brief IN SHARE ROW EXCLUSIVE MODE;
 -- Block concurrent settings, identity, role and membership changes until commit.
 LOCK TABLE public.article_brief_settings,public.member,public.external_writer,public.role,
 public.role_access_item,public.tenant_user,public.tenant_identity,public.tenant_membership IN SHARE MODE;
 current_snapshot:=public.publication_import_snapshot(p_tenant,p_member,p_tenant_user);
 IF current_snapshot IS DISTINCT FROM p_snapshot OR current_snapshot->'actor' = 'null'::jsonb
 THEN RAISE EXCEPTION 'stale import snapshot'; END IF;
 -- No importer application hooks run; fail closed if database triggers might add side effects.
 IF EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid IN ('public.article_brief'::regclass,
   'public.article_brief_activity'::regclass) AND NOT tgisinternal AND tgenabled<>'D')
 THEN RAISE EXCEPTION 'Publication import requires review of database triggers'; END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(p_rows) LOOP
   IF clock_timestamp()-started_at > interval '25 seconds' THEN
     RAISE EXCEPTION 'Publication import execution budget exceeded';
   END IF;
   payload:=item->'payload';
   IF coalesce(item->>'action','') NOT IN ('create','skip') OR jsonb_typeof(payload) IS DISTINCT FROM 'object'
     OR coalesce(length(trim(payload->>'title')),0)=0
     OR coalesce(jsonb_array_length(item->'errors'),0)>0
   THEN RAISE EXCEPTION 'Invalid planned row'; END IF;
   IF EXISTS(SELECT 1 FROM jsonb_object_keys(payload) key WHERE NOT key=ANY(allowed))
   THEN RAISE EXCEPTION 'Unsupported mapped field'; END IF;
   SELECT count(*) INTO matched FROM public.article_brief
     WHERE tenant_id=p_tenant AND lower(regexp_replace(trim(title),'\s+',' ','g'))=
       lower(regexp_replace(trim(payload->>'title'),'\s+',' ','g'));
   IF matched>1 THEN RAISE EXCEPTION 'Conflicting duplicate title'; END IF;
   IF matched=1 THEN
     SELECT * INTO existing FROM public.article_brief
       WHERE tenant_id=p_tenant AND lower(regexp_replace(trim(title),'\s+',' ','g'))=
         lower(regexp_replace(trim(payload->>'title'),'\s+',' ','g'));
     -- Cast dates and other mapped columns using the actual database record type.
     expected:=to_jsonb(jsonb_populate_record(NULL::public.article_brief,payload));
     FOR k IN SELECT jsonb_object_keys(payload) LOOP
       -- Title identity was already compared above using the same normalization
       -- as preview. Keep the existing spelling; imports never update it.
       IF k='title' THEN CONTINUE; END IF;
       IF to_jsonb(existing)->k IS DISTINCT FROM expected->k THEN RAISE EXCEPTION 'Conflicting mapped field: %',k; END IF;
     END LOOP;
     skipped:=skipped+1;
     results:=results||jsonb_build_array(jsonb_build_object('row',item->'row','title',payload->>'title','action','skip','id',existing.id));
   ELSE
     IF item->>'action'='skip' THEN RAISE EXCEPTION 'stale missing brief'; END IF;
     -- Explicit insert columns prevent workbook input from setting audit/security fields.
     inserted:=jsonb_populate_record(NULL::public.article_brief,payload);
     INSERT INTO public.article_brief(title,category,sla,contract,deadline,writer_deadline,editor_deadline,
       status,assigned_writer_id,external_writer_id,review_owner_id,notes,contributor_type,
       case_study_required,copyright_required,tenant_id,created_by)
     VALUES(inserted.title,inserted.category,inserted.sla,inserted.contract,inserted.deadline,
       inserted.writer_deadline,inserted.editor_deadline,inserted.status,inserted.assigned_writer_id,
       inserted.external_writer_id,inserted.review_owner_id,inserted.notes,inserted.contributor_type,
       coalesce(inserted.case_study_required,false),coalesce(inserted.copyright_required,false),p_tenant,p_member)
     RETURNING * INTO inserted;
     INSERT INTO public.article_brief_activity(article_brief_id,action,description,performed_by,metadata,tenant_id)
     VALUES(inserted.id,'brief_created','Created via publication workbook import',p_member,
       jsonb_build_object('plan_id',p_plan,'source_row',item->'row','tenant_user_id',p_tenant_user),p_tenant);
     created:=created+1;
     results:=results||jsonb_build_array(jsonb_build_object('row',item->'row','title',payload->>'title','action','create','id',inserted.id));
   END IF;
 END LOOP;
 result:=jsonb_build_object('created',created,'skipped',skipped,'failed',0,'rows',results,'done',true);
 INSERT INTO public.publication_import_receipt(plan_id,tenant_id,actor_key,result)
 VALUES(p_plan,p_tenant,CASE WHEN p_tenant_user IS NOT NULL THEN 'tenant_user:'||p_tenant_user ELSE 'member:'||p_member END,result);
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.publication_import_identity(jsonb) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.publication_import_snapshot(uuid,uuid,text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.publication_import_result(uuid,uuid,text,uuid) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.publication_import_apply(uuid,uuid,text,uuid,timestamptz,jsonb,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.publication_import_snapshot(uuid,uuid,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.publication_import_result(uuid,uuid,text,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.publication_import_apply(uuid,uuid,text,uuid,timestamptz,jsonb,jsonb) TO service_role;
COMMIT;
