BEGIN;
CREATE TABLE public.form_member_affiliation_config (
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 form_id uuid NOT NULL REFERENCES public.form(id),
 config jsonb NOT NULL CHECK(jsonb_typeof(config)='object'),
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,form_id)
);
CREATE TABLE public.form_member_affiliation_snapshot (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 form_id uuid NOT NULL REFERENCES public.form(id),
 member_id uuid NOT NULL REFERENCES public.member(id),
 config jsonb NOT NULL,
 graph jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL DEFAULT now()+interval '24 hours',
 submission_id uuid REFERENCES public.form_submission(id),
 request jsonb,
 result jsonb,
 UNIQUE(tenant_id,submission_id)
);
ALTER TABLE public.form_member_affiliation_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.form_member_affiliation_snapshot ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.form_member_affiliation_config,public.form_member_affiliation_snapshot FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.form_member_affiliation_config TO service_role;
GRANT SELECT ON public.form_member_affiliation_snapshot TO service_role;

CREATE FUNCTION public.form_member_affiliation_graph(p_tenant uuid,p_member uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
 WITH links AS (
   SELECT r.* FROM custom_object_relationship r JOIN custom_object_relationship_definition d
     ON d.id=r.relationship_definition_id AND d.tenant_id=r.tenant_id
   WHERE r.tenant_id=p_tenant AND r.archived_at IS NULL AND
     ((d.source_kind='member' AND r.source_record_id=p_member) OR (d.target_kind='member' AND r.target_record_id=p_member))
 ), records AS (
   SELECT c.* FROM custom_object_record c WHERE c.tenant_id=p_tenant AND c.archived_at IS NULL
     AND EXISTS(SELECT 1 FROM links l WHERE c.id IN(l.source_record_id,l.target_record_id))
 )
 SELECT jsonb_build_object('organization_id',m.organization_id,
   'links',COALESCE((SELECT jsonb_agg(to_jsonb(l) ORDER BY l.id) FROM links l),'[]'::jsonb),
   'records',COALESCE((SELECT jsonb_agg(to_jsonb(c) ORDER BY c.id) FROM records c),'[]'::jsonb),
   'recordLinks',COALESCE((SELECT jsonb_agg(to_jsonb(r) ORDER BY r.id) FROM custom_object_relationship r
     WHERE r.tenant_id=p_tenant AND r.archived_at IS NULL AND EXISTS
       (SELECT 1 FROM records c WHERE c.id IN(r.source_record_id,r.target_record_id))),'[]'::jsonb))
 FROM member m WHERE m.tenant_id=p_tenant AND m.id=p_member
$$;
REVOKE ALL ON FUNCTION public.form_member_affiliation_graph(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.form_member_affiliation_capture(p_tenant uuid,p_form uuid,p_member uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE cfg jsonb; g jsonb; token uuid; BEGIN
 SELECT c.config INTO cfg FROM form_member_affiliation_config c JOIN form f ON f.id=c.form_id AND f.tenant_id=c.tenant_id
 WHERE c.tenant_id=p_tenant AND c.form_id=p_form AND c.config->>'enabled'='true'
   AND f.require_authentication=true AND f.mutation_access_policy->>'mode'='authenticated_owner';
 IF cfg IS NULL THEN RAISE EXCEPTION 'Affiliation form unavailable' USING ERRCODE='42501'; END IF;
 g:=form_member_affiliation_graph(p_tenant,p_member);
 IF g IS NULL THEN RAISE EXCEPTION 'Member unavailable' USING ERRCODE='42501'; END IF;
 IF octet_length(g::text)>1000000 THEN RAISE EXCEPTION 'Affiliations need administrator review' USING ERRCODE='22023'; END IF;
 INSERT INTO form_member_affiliation_snapshot(tenant_id,form_id,member_id,config,graph)
 VALUES(p_tenant,p_form,p_member,cfg,g) RETURNING id INTO token;
 RETURN jsonb_build_object('token',token,'graph',g,'config',cfg);
END $$;
REVOKE ALL ON FUNCTION public.form_member_affiliation_capture(uuid,uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.form_member_affiliation_capture(uuid,uuid,uuid) TO service_role;

CREATE FUNCTION public.form_member_affiliation_apply(
 p_token uuid,p_submission uuid,p_primary uuid,p_departments uuid[],p_secondary uuid[]
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE
 s form_member_affiliation_snapshot%ROWTYPE;
 sub form_submission%ROWTYPE;
 cfg jsonb; req jsonb; v_result jsonb; before_depts jsonb; sets jsonb:='[]';
 dept_def uuid; member_def uuid; org_def uuid; assignment_object uuid; label_field text;
 rm custom_object_relationship%ROWTYPE;
 record_id uuid; org_id uuid; kept uuid[]:='{}'; new_id uuid; label text;
 md custom_object_relationship_definition%ROWTYPE; od custom_object_relationship_definition%ROWTYPE;
BEGIN
 IF p_departments IS NULL OR p_secondary IS NULL OR cardinality(p_departments)>500 OR cardinality(p_secondary)>100
   OR array_position(p_departments,NULL) IS NOT NULL OR array_position(p_secondary,NULL) IS NOT NULL
   OR cardinality(p_departments)<>(SELECT count(DISTINCT x) FROM unnest(p_departments)x)
   OR cardinality(p_secondary)<>(SELECT count(DISTINCT x) FROM unnest(p_secondary)x) THEN
   RAISE EXCEPTION 'Invalid affiliation selections' USING ERRCODE='22023';
 END IF;
 req:=jsonb_build_object('primary',p_primary,'departments',p_departments,'secondary',p_secondary);
 LOCK TABLE custom_object_relationship,custom_object_record IN SHARE ROW EXCLUSIVE MODE;
 SELECT * INTO s FROM form_member_affiliation_snapshot WHERE id=p_token FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Affiliation snapshot unavailable' USING ERRCODE='42501'; END IF;
 IF s.result IS NOT NULL THEN
   IF s.submission_id IS DISTINCT FROM p_submission OR s.request IS DISTINCT FROM req THEN
     RAISE EXCEPTION 'Affiliation snapshot already submitted' USING ERRCODE='23505';
   END IF;
   RETURN s.result||jsonb_build_object('replayed',true);
 END IF;
 IF s.expires_at<now() THEN RAISE EXCEPTION 'Reload your affiliations before submitting' USING ERRCODE='40001'; END IF;
 SELECT * INTO sub FROM form_submission WHERE id=p_submission AND tenant_id=s.tenant_id FOR UPDATE;
 IF NOT FOUND OR sub.form_id<>s.form_id OR sub.created_member_id IS DISTINCT FROM s.member_id THEN
   RAISE EXCEPTION 'Submission identity mismatch' USING ERRCODE='42501';
 END IF;
 SELECT config INTO cfg FROM form_member_affiliation_config WHERE tenant_id=s.tenant_id AND form_id=s.form_id FOR SHARE;
 IF cfg IS DISTINCT FROM s.config OR cfg->>'enabled' IS DISTINCT FROM 'true' THEN
   RAISE EXCEPTION 'Form configuration changed; reload before submitting' USING ERRCODE='40001';
 END IF;
 PERFORM 1 FROM member WHERE id=s.member_id AND tenant_id=s.tenant_id FOR UPDATE;
 IF s.graph IS DISTINCT FROM form_member_affiliation_graph(s.tenant_id,s.member_id) THEN
   RAISE EXCEPTION 'Affiliations changed; reload before submitting' USING ERRCODE='40001';
 END IF;
 dept_def:=NULLIF(cfg->>'memberDepartmentDefinitionId','')::uuid;
 member_def:=NULLIF(cfg->>'secondaryMemberDefinitionId','')::uuid;
 org_def:=NULLIF(cfg->>'secondaryOrganizationDefinitionId','')::uuid;
 assignment_object:=NULLIF(cfg->>'secondaryObjectId','')::uuid;
 label_field:=NULLIF(cfg->>'secondaryLabelFieldId','');
 IF dept_def IS NOT NULL THEN
   sets:=jsonb_build_array(jsonb_build_object('definition_id',dept_def,'related_ids',p_departments));
 ELSIF cardinality(p_departments)>0 THEN RAISE EXCEPTION 'Departments are not configured' USING ERRCODE='22023';
 END IF;
 before_depts:=form_member_relationship_snapshot(s.tenant_id,s.member_id,CASE WHEN dept_def IS NULL THEN '{}'::uuid[] ELSE ARRAY[dept_def] END);
 IF member_def IS NULL THEN
   IF cardinality(p_secondary)>0 THEN RAISE EXCEPTION 'Secondary affiliations are not configured' USING ERRCODE='22023'; END IF;
 ELSE
   SELECT * INTO md FROM custom_object_relationship_definition WHERE id=member_def AND tenant_id=s.tenant_id AND status='active' FOR SHARE;
   SELECT * INTO od FROM custom_object_relationship_definition WHERE id=org_def AND tenant_id=s.tenant_id AND status='active' FOR SHARE;
   IF md.id IS NULL OR od.id IS NULL OR assignment_object IS NULL OR NOT ((md.source_kind='custom_object' AND md.source_custom_object_id=assignment_object AND md.target_kind='member')
     OR (md.target_kind='custom_object' AND md.target_custom_object_id=assignment_object AND md.source_kind='member'))
     OR NOT ((od.source_kind='custom_object' AND od.source_custom_object_id=assignment_object AND od.target_kind='organization')
     OR (od.target_kind='custom_object' AND od.target_custom_object_id=assignment_object AND od.source_kind='organization')) THEN
     RAISE EXCEPTION 'Invalid secondary affiliation definitions' USING ERRCODE='42501';
   END IF;
   FOR rm IN SELECT * FROM custom_object_relationship WHERE tenant_id=s.tenant_id
     AND relationship_definition_id=member_def AND archived_at IS NULL AND
     CASE WHEN md.source_kind='member' THEN source_record_id=s.member_id ELSE target_record_id=s.member_id END LOOP
     record_id:=CASE WHEN md.source_kind='custom_object' THEN rm.source_record_id ELSE rm.target_record_id END;
     -- Never re-parent or dispose of an assignment shared with someone else.
     IF (SELECT count(*) FROM custom_object_relationship WHERE tenant_id=s.tenant_id
       AND relationship_definition_id=member_def AND archived_at IS NULL AND record_id IN(source_record_id,target_record_id))<>1
       OR (SELECT count(*) FROM custom_object_relationship WHERE tenant_id=s.tenant_id
       AND relationship_definition_id=org_def AND archived_at IS NULL AND record_id IN(source_record_id,target_record_id))<>1 THEN
       RAISE EXCEPTION 'Secondary assignment needs administrator review' USING ERRCODE='22023';
     END IF;
     SELECT CASE WHEN od.source_kind='organization' THEN source_record_id ELSE target_record_id END INTO org_id
       FROM custom_object_relationship WHERE tenant_id=s.tenant_id AND relationship_definition_id=org_def
       AND archived_at IS NULL AND record_id IN(source_record_id,target_record_id);
     IF org_id=ANY(p_secondary) THEN
       IF org_id=ANY(kept) THEN RAISE EXCEPTION 'Duplicate secondary assignment needs review' USING ERRCODE='22023'; END IF;
       kept:=array_append(kept,org_id);
     ELSE
       IF EXISTS(SELECT 1 FROM custom_object_relationship WHERE tenant_id=s.tenant_id AND archived_at IS NULL
         AND record_id IN(source_record_id,target_record_id) AND relationship_definition_id NOT IN(member_def,org_def)) THEN
         RAISE EXCEPTION 'Secondary assignment has other relationships; administrator review required' USING ERRCODE='22023';
       END IF;
       UPDATE custom_object_relationship SET archived_at=now(),archived_by=s.member_id::text
         WHERE tenant_id=s.tenant_id AND archived_at IS NULL AND relationship_definition_id IN(member_def,org_def)
         AND record_id IN(source_record_id,target_record_id);
       UPDATE custom_object_record SET archived_at=now(),archived_by=s.member_id::text,
         archive_reason='Removed through authenticated membership form',updated_at=now()
         WHERE tenant_id=s.tenant_id AND id=record_id AND custom_object_id=assignment_object;
     END IF;
   END LOOP;
   FOREACH org_id IN ARRAY p_secondary LOOP
     IF org_id=ANY(kept) THEN CONTINUE; END IF;
     SELECT name INTO label FROM organization WHERE tenant_id=s.tenant_id AND id=org_id FOR SHARE;
     IF NOT FOUND THEN RAISE EXCEPTION 'Secondary organisation unavailable' USING ERRCODE='42501'; END IF;
     new_id:=gen_random_uuid();
     INSERT INTO custom_object_record(id,tenant_id,custom_object_id,data,created_by)
       VALUES(new_id,s.tenant_id,assignment_object,CASE WHEN label_field IS NULL THEN '{}'::jsonb
       ELSE jsonb_build_object(label_field,label) END,s.member_id::text);
     INSERT INTO custom_object_relationship(tenant_id,relationship_definition_id,source_record_id,target_record_id,created_by)
       VALUES(s.tenant_id,org_def,CASE WHEN od.source_kind='custom_object' THEN new_id ELSE org_id END,
         CASE WHEN od.source_kind='custom_object' THEN org_id ELSE new_id END,s.member_id::text),
       (s.tenant_id,member_def,CASE WHEN md.source_kind='custom_object' THEN new_id ELSE s.member_id END,
         CASE WHEN md.source_kind='custom_object' THEN s.member_id ELSE new_id END,s.member_id::text);
   END LOOP;
 END IF;
 v_result:=form_member_relationship_apply(s.tenant_id,p_submission,s.member_id,before_depts,p_primary,sets);
 UPDATE form_member_affiliation_snapshot SET submission_id=p_submission,request=req,result=v_result
   WHERE id=p_token;
 RETURN v_result;
END $$;
REVOKE ALL ON FUNCTION public.form_member_affiliation_apply(uuid,uuid,uuid,uuid[],uuid[]) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.form_member_affiliation_apply(uuid,uuid,uuid,uuid[],uuid[]) TO service_role;
COMMIT;
