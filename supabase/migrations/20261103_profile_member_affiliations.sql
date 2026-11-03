-- Separate profile boundary; no form submissions, tenant enablement or data cleanup.
BEGIN;
CREATE TABLE public.profile_affiliation_policy (
 tenant_id uuid PRIMARY KEY REFERENCES public.tenant(id),
 version bigint NOT NULL DEFAULT 1,
 config jsonb NOT NULL CHECK (jsonb_typeof(config)='object'),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.profile_affiliation_operation (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 member_id uuid NOT NULL REFERENCES public.member(id),
 policy_version bigint NOT NULL,
 config jsonb NOT NULL,
 snapshot jsonb NOT NULL,
 request jsonb,
 result jsonb,
 created_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL DEFAULT now()+interval '2 hours',
 committed_at timestamptz
);
ALTER TABLE public.profile_affiliation_policy ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profile_affiliation_operation ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.profile_affiliation_policy,public.profile_affiliation_operation FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.profile_affiliation_policy,public.profile_affiliation_operation TO service_role;

CREATE FUNCTION public.profile_affiliation_policy_save(p_tenant uuid,p_version bigint,p_config jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v profile_affiliation_policy%ROWTYPE;
BEGIN
 -- Serializes first inserts as well as updates. Only the admin API may call.
 PERFORM pg_advisory_xact_lock(hashtextextended('profile-affiliation-policy:'||p_tenant::text,0));
 SELECT * INTO v FROM profile_affiliation_policy WHERE tenant_id=p_tenant FOR UPDATE;
 IF coalesce(v.version,0)<>p_version THEN
   RAISE EXCEPTION 'Settings changed; reload before saving' USING ERRCODE='40001';
 END IF;
 IF jsonb_typeof(p_config->'enabled') IS DISTINCT FROM 'boolean' THEN
   RAISE EXCEPTION 'Invalid policy' USING ERRCODE='22023';
 END IF;
 INSERT INTO profile_affiliation_policy(tenant_id,version,config)
 VALUES(p_tenant,p_version+1,p_config)
 ON CONFLICT(tenant_id) DO UPDATE SET config=excluded.config,version=excluded.version,updated_at=now()
 RETURNING * INTO v;
 RETURN to_jsonb(v);
END $$;

CREATE FUNCTION public.profile_affiliation_state(p_tenant uuid,p_member uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public SET timezone='UTC' AS $$
 SELECT jsonb_build_object(
   'graph',public.form_member_affiliation_graph(p_tenant,p_member),
   'definitions',(SELECT coalesce(jsonb_agg(to_jsonb(d) ORDER BY id),'[]') FROM custom_object_relationship_definition d WHERE tenant_id=p_tenant),
   'objects',(SELECT coalesce(jsonb_agg(to_jsonb(o) ORDER BY id),'[]') FROM custom_object_definition o WHERE tenant_id=p_tenant),
   'fields',(SELECT coalesce(jsonb_agg(to_jsonb(f) ORDER BY id),'[]') FROM preference_field f WHERE tenant_id=p_tenant AND custom_object_id IS NOT NULL),
   'role_id',m.role_id,
   'permissions',(SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY p.id),'[]') FROM role_member_field_permission p WHERE p.role_id=m.role_id::text),
   'fieldPermissions',(SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY p.id),'[]') FROM custom_object_field_role_permission p WHERE p.tenant_id=p_tenant AND p.role_id::text=m.role_id::text))
 FROM member m WHERE tenant_id=p_tenant AND id=p_member
$$;

CREATE FUNCTION public.profile_affiliation_assert_permission(p_tenant uuid,p_member uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM member WHERE tenant_id=p_tenant AND id=p_member AND role_id IS NOT NULL)
 OR EXISTS(SELECT 1 FROM member m JOIN role_member_field_permission p ON p.role_id=m.role_id::text
   WHERE m.id=p_member AND m.tenant_id=p_tenant
   AND p.field_key IN ('organization_id','organization','organisation','departments','secondary_organizations')
   AND p.permission IS DISTINCT FROM 'read_write') THEN
   RAISE EXCEPTION 'Your role does not allow affiliation editing' USING ERRCODE='42501';
 END IF;
 IF EXISTS(SELECT 1 FROM member m
   JOIN custom_object_field_role_permission fp ON fp.tenant_id=m.tenant_id AND fp.role_id::text=m.role_id::text
   JOIN custom_object_definition o ON o.tenant_id=fp.tenant_id AND o.primary_display_field_id=fp.field_id
   JOIN custom_object_relationship_definition d ON d.tenant_id=o.tenant_id AND o.id IN(d.source_custom_object_id,d.target_custom_object_id)
   JOIN profile_affiliation_policy p ON p.tenant_id=m.tenant_id
   WHERE m.id=p_member AND m.tenant_id=p_tenant
   AND d.id::text IN(p.config->>'memberDepartmentDefinitionId',p.config->>'secondaryMemberDefinitionId')
   AND coalesce(to_jsonb(fp)->>'access_level',to_jsonb(fp)->>'access','none') NOT IN ('read','edit')) THEN
   RAISE EXCEPTION 'Affiliation labels are restricted for your role' USING ERRCODE='42501';
 END IF;
END $$;

CREATE FUNCTION public.profile_affiliation_capture(p_tenant uuid,p_member uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE p profile_affiliation_policy%ROWTYPE; s jsonb; token uuid;
BEGIN
 SELECT * INTO p FROM profile_affiliation_policy WHERE tenant_id=p_tenant FOR SHARE;
 IF NOT FOUND OR p.config->'enabled' IS DISTINCT FROM 'true'::jsonb THEN RETURN '{"active":false}'; END IF;
 PERFORM profile_affiliation_assert_permission(p_tenant,p_member);
 s:=profile_affiliation_state(p_tenant,p_member);
 IF s IS NULL OR octet_length(s::text)>1000000 THEN
   RAISE EXCEPTION 'Affiliations unavailable; ask an administrator' USING ERRCODE='22023';
 END IF;
 INSERT INTO profile_affiliation_operation(tenant_id,member_id,policy_version,config,snapshot)
 VALUES(p_tenant,p_member,p.version,p.config,s) RETURNING id INTO token;
 RETURN jsonb_build_object('active',true,'token',token,'snapshot',s,'config',p.config);
END $$;

-- Secondary organisations must include the complete active, exclusively-owned
-- bridge. Ambiguous/shared assignments cannot be self-edited.
CREATE FUNCTION public.profile_affiliation_secondary(p_tenant uuid,p_member uuid,p_config jsonb)
RETURNS uuid[] LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $$
DECLARE md uuid:=nullif(p_config->>'secondaryMemberDefinitionId','')::uuid;
 od uuid:=nullif(p_config->>'secondaryOrganizationDefinitionId','')::uuid;
 d custom_object_relationship_definition%ROWTYPE; r record; rid uuid; oid uuid; result uuid[]:='{}';
BEGIN
 IF md IS NULL THEN RETURN result; END IF;
 SELECT * INTO STRICT d FROM custom_object_relationship_definition WHERE tenant_id=p_tenant AND id=md AND status='active';
 FOR r IN SELECT * FROM custom_object_relationship WHERE tenant_id=p_tenant AND relationship_definition_id=md
   AND archived_at IS NULL AND CASE WHEN d.source_kind='member' THEN source_record_id=p_member ELSE target_record_id=p_member END LOOP
   rid:=CASE WHEN d.source_kind='member' THEN r.target_record_id ELSE r.source_record_id END;
   IF (SELECT count(*) FROM custom_object_relationship WHERE tenant_id=p_tenant AND relationship_definition_id=md
       AND archived_at IS NULL AND rid IN(source_record_id,target_record_id))<>1
     OR (SELECT count(*) FROM custom_object_relationship WHERE tenant_id=p_tenant AND relationship_definition_id=od
       AND archived_at IS NULL AND rid IN(source_record_id,target_record_id))<>1
     OR NOT EXISTS(SELECT 1 FROM custom_object_record WHERE tenant_id=p_tenant AND id=rid AND archived_at IS NULL) THEN
     RAISE EXCEPTION 'Secondary assignment needs administrator assistance' USING ERRCODE='22023';
   END IF;
   SELECT CASE WHEN x.source_record_id=rid THEN x.target_record_id ELSE x.source_record_id END INTO oid
     FROM custom_object_relationship x WHERE tenant_id=p_tenant AND relationship_definition_id=od
       AND archived_at IS NULL AND rid IN(source_record_id,target_record_id);
   IF oid=ANY(result) THEN RAISE EXCEPTION 'Duplicate secondary assignments need administrator assistance' USING ERRCODE='22023'; END IF;
   result:=array_append(result,oid);
 END LOOP;
 RETURN result;
END $$;

CREATE FUNCTION public.profile_affiliation_department_owner(p_tenant uuid,p_definition uuid,p_department uuid)
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
 SELECT CASE WHEN count(*)=1 THEN (array_agg(CASE WHEN d.source_kind='organization' THEN r.source_record_id ELSE r.target_record_id END))[1] END
 FROM custom_object_relationship r JOIN custom_object_relationship_definition d ON d.id=r.relationship_definition_id AND d.tenant_id=r.tenant_id
 WHERE r.tenant_id=p_tenant AND r.relationship_definition_id=p_definition AND r.archived_at IS NULL
 AND CASE WHEN d.source_kind='custom_object' THEN r.source_record_id=p_department ELSE r.target_record_id=p_department END
$$;

CREATE FUNCTION public.profile_affiliation_apply(p_tenant uuid,p_member uuid,p_token uuid,p_request jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE
 op profile_affiliation_operation%ROWTYPE; policy profile_affiliation_policy%ROWTYPE;
 d custom_object_relationship_definition%ROWTYPE; md custom_object_relationship_definition%ROWTYPE; od custom_object_relationship_definition%ROWTYPE;
 cfg jsonb; original jsonb; primary_id uuid; before_primary uuid; departments uuid[]; secondary uuid[]; before_secondary uuid[];
 old_departments uuid[]; owner_id uuid; related_id uuid; rid uuid; org_id uuid; assignment_object uuid; label_key text; label text;
 e record; value jsonb; false_values jsonb:='{}'; retained jsonb; after_retained jsonb;
 member_side text; other_side text; dep_object uuid; dep_owner uuid; kept uuid[]:='{}';
BEGIN
 IF jsonb_typeof(p_request) IS DISTINCT FROM 'object' OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_request) k WHERE k NOT IN ('primary','secondary','departments')) THEN
   RAISE EXCEPTION 'Invalid affiliation request' USING ERRCODE='22023';
 END IF;
 -- Same order as the form transaction. All generic graph writers are fenced.
 LOCK TABLE custom_object_relationship,custom_object_record IN SHARE ROW EXCLUSIVE MODE;
 LOCK TABLE custom_object_relationship_definition,custom_object_definition,preference_field,role_member_field_permission,custom_object_field_role_permission IN SHARE MODE;
 SELECT * INTO op FROM profile_affiliation_operation WHERE id=p_token AND tenant_id=p_tenant AND member_id=p_member FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Reload your affiliations' USING ERRCODE='42501'; END IF;
 SELECT * INTO policy FROM profile_affiliation_policy WHERE tenant_id=p_tenant FOR SHARE;
 IF NOT FOUND OR policy.config->'enabled' IS DISTINCT FROM 'true'::jsonb OR policy.version<>op.policy_version OR policy.config<>op.config THEN
   RAISE EXCEPTION 'Affiliation editing settings changed; reload or contact an administrator' USING ERRCODE='40001';
 END IF;
 PERFORM 1 FROM member WHERE tenant_id=p_tenant AND id=p_member FOR UPDATE;
 PERFORM profile_affiliation_assert_permission(p_tenant,p_member);
 IF op.result IS NOT NULL THEN
   IF op.request IS DISTINCT FROM p_request THEN RAISE EXCEPTION 'This save was already used for different changes' USING ERRCODE='23505'; END IF;
   RETURN op.result||'{"replayed":true}'::jsonb;
 END IF;
 IF op.expires_at<now() OR op.snapshot IS DISTINCT FROM profile_affiliation_state(p_tenant,p_member) THEN
   RAISE EXCEPTION 'Your affiliations changed or expired. Reload before saving; your draft has not been applied' USING ERRCODE='40001';
 END IF;
 cfg:=op.config; original:=op.snapshot->'graph';
 SELECT * INTO STRICT d FROM custom_object_relationship_definition WHERE tenant_id=p_tenant AND id=(cfg->>'memberDepartmentDefinitionId')::uuid AND status='active';
 member_side:=CASE WHEN d.source_kind='member' THEN 'source' ELSE 'target' END;
 other_side:=CASE WHEN member_side='source' THEN 'target' ELSE 'source' END;
 dep_object:=CASE WHEN member_side='source' THEN d.target_custom_object_id ELSE d.source_custom_object_id END;
 dep_owner:=(cfg->>'departmentOrganizationDefinitionId')::uuid;
 before_primary:=(original->>'organization_id')::uuid;
 primary_id:=CASE WHEN p_request?'primary' THEN (p_request->>'primary')::uuid ELSE before_primary END;
 before_secondary:=profile_affiliation_secondary(p_tenant,p_member,cfg);
 secondary:=before_secondary;
 IF p_request?'secondary' THEN
   IF jsonb_typeof(p_request->'secondary')<>'array' THEN RAISE EXCEPTION 'Invalid secondary selection'; END IF;
   SELECT coalesce(array_agg(x::uuid),'{}') INTO secondary FROM jsonb_array_elements_text(p_request->'secondary') x;
 END IF;
 SELECT coalesce(array_agg(CASE WHEN member_side='source' THEN r.target_record_id ELSE r.source_record_id END),'{}') INTO old_departments
 FROM custom_object_relationship r WHERE tenant_id=p_tenant AND relationship_definition_id=d.id AND archived_at IS NULL
   AND CASE WHEN member_side='source' THEN source_record_id=p_member ELSE target_record_id=p_member END;
 departments:=old_departments;
 IF p_request?'departments' THEN
   IF jsonb_typeof(p_request->'departments')<>'array' THEN RAISE EXCEPTION 'Invalid department selection'; END IF;
   SELECT coalesce(array_agg(x::uuid),'{}') INTO departments FROM jsonb_array_elements_text(p_request->'departments') x;
 END IF;
 IF cardinality(secondary)>100 OR cardinality(departments)>500
   OR array_position(secondary,NULL) IS NOT NULL OR array_position(departments,NULL) IS NOT NULL
   OR cardinality(secondary)<>(SELECT count(DISTINCT x) FROM unnest(secondary)x)
   OR cardinality(departments)<>(SELECT count(DISTINCT x) FROM unnest(departments)x)
   OR (primary_id=ANY(secondary) AND (primary_id IS DISTINCT FROM before_primary OR NOT(secondary @> before_secondary AND secondary <@ before_secondary))) THEN
   RAISE EXCEPTION 'Select distinct existing affiliations' USING ERRCODE='22023';
 END IF;
 IF nullif(cfg->>'secondaryMemberDefinitionId','') IS NULL AND cardinality(secondary)>0 THEN RAISE EXCEPTION 'Secondary editing not configured'; END IF;
 FOREACH related_id IN ARRAY array_append(secondary,primary_id) LOOP
   IF related_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM organization WHERE tenant_id=p_tenant AND organization.id=related_id) THEN
     RAISE EXCEPTION 'Organisation unavailable' USING ERRCODE='42501';
   END IF;
 END LOOP;
 -- Preserve old out-of-scope links. A newly invalidated retained ordinary link
 -- requires explicit removal; protected links may never be removed by a member.
 FOR e IN SELECT * FROM custom_object_relationship WHERE tenant_id=p_tenant AND relationship_definition_id=d.id AND archived_at IS NULL
   AND CASE WHEN member_side='source' THEN source_record_id=p_member ELSE target_record_id=p_member END LOOP
   related_id:=CASE WHEN member_side='source' THEN e.target_record_id ELSE e.source_record_id END;
   owner_id:=profile_affiliation_department_owner(p_tenant,dep_owner,related_id);
   IF NOT(related_id=ANY(departments)) AND EXISTS(SELECT 1 FROM jsonb_each(coalesce(e.field_values,'{}')) f WHERE f.value IS DISTINCT FROM 'false'::jsonb AND f.value IS DISTINCT FROM 'null'::jsonb) THEN
     RAISE EXCEPTION 'A protected respondent link requires administrator assistance' USING ERRCODE='42501';
   END IF;
   IF related_id=ANY(departments) AND coalesce(owner_id=before_primary OR owner_id=ANY(before_secondary),false)
     AND NOT coalesce(owner_id=primary_id OR owner_id=ANY(secondary),false) THEN
     RAISE EXCEPTION 'Review department removals for your proposed organisations. Protected links require administrator assistance' USING ERRCODE='22023';
   END IF;
 END LOOP;
 FOREACH related_id IN ARRAY departments LOOP
   IF related_id=ANY(old_departments) THEN CONTINUE; END IF;
   owner_id:=profile_affiliation_department_owner(p_tenant,dep_owner,related_id);
   IF NOT coalesce(owner_id=primary_id OR owner_id=ANY(secondary),false)
     OR NOT EXISTS(SELECT 1 FROM custom_object_record WHERE tenant_id=p_tenant AND custom_object_record.id=related_id AND custom_object_id=dep_object AND archived_at IS NULL)
     OR EXISTS(SELECT 1 FROM custom_object_relationship r WHERE tenant_id=p_tenant AND relationship_definition_id=d.id AND archived_at IS NOT NULL
       AND CASE WHEN member_side='source' THEN source_record_id=p_member AND target_record_id=related_id ELSE target_record_id=p_member AND source_record_id=related_id END
       AND EXISTS(SELECT 1 FROM jsonb_each(coalesce(r.field_values,'{}')) f WHERE f.value IS DISTINCT FROM 'false'::jsonb AND f.value IS DISTINCT FROM 'null'::jsonb)) THEN
     RAISE EXCEPTION 'Department unavailable or previously protected; contact an administrator' USING ERRCODE='42501';
   END IF;
 END LOOP;
 SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.id),'[]') INTO retained FROM custom_object_relationship r
 WHERE tenant_id=p_tenant AND relationship_definition_id=d.id AND archived_at IS NULL
 AND CASE WHEN member_side='source' THEN source_record_id=p_member AND target_record_id=ANY(departments) ELSE target_record_id=p_member AND source_record_id=ANY(departments) END;
 -- Only explicitly removed department edges are archived, never deleted.
 UPDATE custom_object_relationship SET archived_at=now(),archived_by=p_member::text
 WHERE tenant_id=p_tenant AND relationship_definition_id=d.id AND archived_at IS NULL
 AND CASE WHEN member_side='source' THEN source_record_id=p_member AND NOT(target_record_id=ANY(departments)) ELSE target_record_id=p_member AND NOT(source_record_id=ANY(departments)) END;
 IF nullif(cfg->>'secondaryMemberDefinitionId','') IS NOT NULL THEN
   SELECT * INTO STRICT md FROM custom_object_relationship_definition WHERE tenant_id=p_tenant AND id=(cfg->>'secondaryMemberDefinitionId')::uuid AND status='active';
   SELECT * INTO STRICT od FROM custom_object_relationship_definition WHERE tenant_id=p_tenant AND id=(cfg->>'secondaryOrganizationDefinitionId')::uuid AND status='active';
   assignment_object:=CASE WHEN md.source_kind='custom_object' THEN md.source_custom_object_id ELSE md.target_custom_object_id END;
   SELECT name INTO label_key FROM preference_field WHERE tenant_id=p_tenant AND custom_object_id=assignment_object AND id=nullif(cfg->>'secondaryLabelFieldId','')::uuid;
   FOR e IN SELECT * FROM custom_object_relationship WHERE tenant_id=p_tenant AND relationship_definition_id=md.id AND archived_at IS NULL
     AND CASE WHEN md.source_kind='member' THEN source_record_id=p_member ELSE target_record_id=p_member END LOOP
     rid:=CASE WHEN md.source_kind='member' THEN e.target_record_id ELSE e.source_record_id END;
     SELECT CASE WHEN od.source_kind='organization' THEN source_record_id ELSE target_record_id END INTO org_id
       FROM custom_object_relationship WHERE tenant_id=p_tenant AND relationship_definition_id=od.id AND archived_at IS NULL AND rid IN(source_record_id,target_record_id);
     IF org_id=ANY(secondary) THEN kept:=array_append(kept,org_id); CONTINUE; END IF;
     IF EXISTS(SELECT 1 FROM custom_object_relationship WHERE tenant_id=p_tenant AND archived_at IS NULL AND rid IN(source_record_id,target_record_id)
       AND (relationship_definition_id NOT IN(md.id,od.id) OR field_values<>'{}'::jsonb)) THEN
       RAISE EXCEPTION 'Secondary assignment needs administrator assistance' USING ERRCODE='42501';
     END IF;
     UPDATE custom_object_relationship SET archived_at=now(),archived_by=p_member::text WHERE tenant_id=p_tenant AND archived_at IS NULL AND rid IN(source_record_id,target_record_id);
     UPDATE custom_object_record SET archived_at=now(),archived_by=p_member::text,archive_reason='Removed through member profile',updated_at=now()
       WHERE tenant_id=p_tenant AND custom_object_record.id=rid;
   END LOOP;
   FOREACH org_id IN ARRAY secondary LOOP
     IF org_id=ANY(kept) THEN CONTINUE; END IF;
     SELECT name INTO STRICT label FROM organization WHERE tenant_id=p_tenant AND organization.id=org_id;
     rid:=gen_random_uuid();
     INSERT INTO custom_object_record(id,tenant_id,custom_object_id,data,created_by)
       VALUES(rid,p_tenant,assignment_object,CASE WHEN label_key IS NULL THEN '{}'::jsonb ELSE jsonb_build_object(label_key,label) END,p_member::text);
     INSERT INTO custom_object_relationship(tenant_id,relationship_definition_id,source_record_id,target_record_id,created_by)
       VALUES(p_tenant,od.id,CASE WHEN od.source_kind='custom_object' THEN rid ELSE org_id END,CASE WHEN od.source_kind='custom_object' THEN org_id ELSE rid END,p_member::text),
       (p_tenant,md.id,CASE WHEN md.source_kind='custom_object' THEN rid ELSE p_member END,CASE WHEN md.source_kind='custom_object' THEN p_member ELSE rid END,p_member::text);
   END LOOP;
 END IF;
 UPDATE member SET organization_id=primary_id WHERE tenant_id=p_tenant AND member.id=p_member AND organization_id IS DISTINCT FROM primary_id;
 FOR value IN SELECT x FROM jsonb_array_elements(coalesce(d.configuration->'relationship_fields',d.configuration->'relationshipFields','[]')) x LOOP
   IF coalesce(value->>'type',value->>'field_type')<>'boolean' OR coalesce(value->'default_value',value->'defaultValue',value->'default','false')<>'false' THEN
     RAISE EXCEPTION 'Unsafe relationship defaults' USING ERRCODE='42501';
   END IF;
   false_values:=false_values||jsonb_build_object(coalesce(value->>'key',value->>'name'),false);
 END LOOP;
 FOREACH related_id IN ARRAY departments LOOP
   IF related_id=ANY(old_departments) THEN CONTINUE; END IF;
   INSERT INTO custom_object_relationship(tenant_id,relationship_definition_id,source_record_id,target_record_id,field_values,created_by)
     VALUES(p_tenant,d.id,CASE WHEN member_side='source' THEN p_member ELSE related_id END,
       CASE WHEN member_side='source' THEN related_id ELSE p_member END,false_values,p_member::text);
 END LOOP;
 -- Catch legacy cleanup triggers rather than silently losing retained links.
 SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.id),'[]') INTO after_retained
 FROM custom_object_relationship r WHERE r.id IN(SELECT (x->>'id')::uuid FROM jsonb_array_elements(retained)x);
 IF retained IS DISTINCT FROM after_retained THEN RAISE EXCEPTION 'Legacy cleanup changed retained links; administrator assistance required' USING ERRCODE='40001'; END IF;
 UPDATE profile_affiliation_operation SET request=p_request,result='{"committed":true,"replayed":false}',committed_at=now() WHERE profile_affiliation_operation.id=p_token;
 RETURN '{"committed":true,"replayed":false}';
END $$;

-- Browser database credentials cannot change the primary affiliation directly.
CREATE FUNCTION public.profile_affiliation_choices(
 p_tenant uuid,p_member uuid,p_token uuid,p_kind text,p_search text,p_page integer,p_primary uuid,p_secondary uuid[]
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE op profile_affiliation_operation%ROWTYPE; p profile_affiliation_policy%ROWTYPE;
 d custom_object_relationship_definition%ROWTYPE; object_id uuid; label_key text; result jsonb;
BEGIN
 IF p_kind NOT IN ('organization','department') OR p_kind IS NULL OR p_page IS NULL OR p_page<1 OR p_page>10000
   OR p_search IS NULL OR length(p_search)>100 OR p_secondary IS NULL OR cardinality(p_secondary)>100 THEN
   RAISE EXCEPTION 'Invalid search' USING ERRCODE='22023';
 END IF;
 SELECT * INTO op FROM profile_affiliation_operation WHERE id=p_token AND tenant_id=p_tenant AND member_id=p_member;
 IF NOT FOUND OR op.expires_at<now() THEN RAISE EXCEPTION 'Reload your affiliations' USING ERRCODE='40001'; END IF;
 SELECT * INTO p FROM profile_affiliation_policy WHERE tenant_id=p_tenant;
 IF NOT FOUND OR p.config->'enabled' IS DISTINCT FROM 'true'::jsonb OR p.version<>op.policy_version
   OR op.snapshot IS DISTINCT FROM profile_affiliation_state(p_tenant,p_member) THEN
   RAISE EXCEPTION 'Affiliations or settings changed; reload before editing' USING ERRCODE='40001';
 END IF;
 PERFORM profile_affiliation_assert_permission(p_tenant,p_member);
 IF nullif(op.config->>'secondaryMemberDefinitionId','') IS NULL AND cardinality(p_secondary)>0 THEN
   RAISE EXCEPTION 'Secondary affiliations not configured' USING ERRCODE='42501';
 END IF;
 IF EXISTS(SELECT 1 FROM unnest(array_append(p_secondary,p_primary)) id WHERE id IS NOT NULL
   AND NOT EXISTS(SELECT 1 FROM organization o WHERE o.id=id AND o.tenant_id=p_tenant)) THEN
   RAISE EXCEPTION 'Organisation unavailable' USING ERRCODE='42501';
 END IF;
 IF p_kind='organization' THEN
   SELECT coalesce(jsonb_agg(x ORDER BY x.label,x.id),'[]') INTO result FROM (
     SELECT id,name AS label FROM organization WHERE tenant_id=p_tenant AND strpos(lower(name),lower(p_search))>0
       ORDER BY name,id LIMIT 26 OFFSET (p_page-1)*25
   ) x;
 ELSE
   SELECT * INTO STRICT d FROM custom_object_relationship_definition WHERE tenant_id=p_tenant AND id=(op.config->>'memberDepartmentDefinitionId')::uuid AND status='active';
   object_id:=CASE WHEN d.source_kind='custom_object' THEN d.source_custom_object_id ELSE d.target_custom_object_id END;
   SELECT f.name INTO STRICT label_key FROM custom_object_definition o JOIN preference_field f ON f.id=o.primary_display_field_id AND f.custom_object_id=o.id AND f.tenant_id=o.tenant_id
     WHERE o.id=object_id AND o.tenant_id=p_tenant;
   SELECT coalesce(jsonb_agg(x ORDER BY x.label,x.id),'[]') INTO result FROM (
     SELECT r.id,r.data->>label_key AS label,o.name AS "organizationLabel"
     FROM custom_object_record r JOIN organization o ON o.id=profile_affiliation_department_owner(p_tenant,(op.config->>'departmentOrganizationDefinitionId')::uuid,r.id) AND o.tenant_id=p_tenant
     WHERE r.tenant_id=p_tenant AND r.custom_object_id=object_id AND r.archived_at IS NULL
       AND (o.id=p_primary OR o.id=ANY(p_secondary)) AND strpos(lower(coalesce(r.data->>label_key,'')),lower(p_search))>0
     ORDER BY r.data->>label_key,r.id LIMIT 26 OFFSET (p_page-1)*25
   ) x;
 END IF;
 RETURN jsonb_build_object('hasMore',jsonb_array_length(result)>25,'items',
   (SELECT coalesce(jsonb_agg(value ORDER BY ordinality),'[]') FROM jsonb_array_elements(result) WITH ORDINALITY WHERE ordinality<=25));
END $$;
REVOKE ALL ON FUNCTION public.profile_affiliation_choices(uuid,uuid,uuid,text,text,integer,uuid,uuid[]) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.profile_affiliation_choices(uuid,uuid,uuid,text,text,integer,uuid,uuid[]) TO service_role;

-- All relationship writes go through the existing administrative APIs, forms
-- or the dedicated member transaction, never browser database credentials.
REVOKE INSERT,UPDATE,DELETE ON public.custom_object_relationship,public.custom_object_record FROM anon,authenticated;

-- Service/admin/form routes remain unchanged; the dedicated endpoint validates
-- member authority before invoking service-only functions.
CREATE FUNCTION public.profile_affiliation_direct_member_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$
BEGIN
 IF current_user IN ('anon','authenticated') AND NEW.organization_id IS DISTINCT FROM OLD.organization_id THEN
   RAISE EXCEPTION 'Use the member affiliation service' USING ERRCODE='42501';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER profile_affiliation_direct_member_guard BEFORE UPDATE OF organization_id ON public.member
 FOR EACH ROW EXECUTE FUNCTION public.profile_affiliation_direct_member_guard();

-- Column-level grants can survive a table-level REVOKE on older installations.
CREATE FUNCTION public.profile_affiliation_direct_graph_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$
BEGIN
 IF current_user IN ('anon','authenticated') THEN
   RAISE EXCEPTION 'Use an authorized relationship service' USING ERRCODE='42501';
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER profile_affiliation_direct_graph_guard BEFORE INSERT OR UPDATE OR DELETE ON public.custom_object_relationship
 FOR EACH ROW EXECUTE FUNCTION public.profile_affiliation_direct_graph_guard();
CREATE TRIGGER profile_affiliation_direct_record_guard BEFORE INSERT OR UPDATE OR DELETE ON public.custom_object_record
 FOR EACH ROW EXECUTE FUNCTION public.profile_affiliation_direct_graph_guard();

REVOKE ALL ON FUNCTION public.profile_affiliation_policy_save(uuid,bigint,jsonb),
 public.profile_affiliation_state(uuid,uuid),public.profile_affiliation_assert_permission(uuid,uuid),
 public.profile_affiliation_capture(uuid,uuid),public.profile_affiliation_secondary(uuid,uuid,jsonb),
 public.profile_affiliation_department_owner(uuid,uuid,uuid),public.profile_affiliation_apply(uuid,uuid,uuid,jsonb),
 public.profile_affiliation_direct_member_guard(),public.profile_affiliation_direct_graph_guard() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.profile_affiliation_policy_save(uuid,bigint,jsonb),
 public.profile_affiliation_capture(uuid,uuid),public.profile_affiliation_apply(uuid,uuid,uuid,jsonb) TO service_role;
COMMIT;
