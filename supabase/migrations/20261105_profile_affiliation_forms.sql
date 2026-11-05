BEGIN;
CREATE TABLE IF NOT EXISTS public.profile_affiliation_form_policy (
 tenant_id uuid PRIMARY KEY REFERENCES public.tenant(id),
 version bigint NOT NULL DEFAULT 1,
 config jsonb NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.profile_affiliation_form_policy ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.profile_affiliation_form_policy FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.profile_affiliation_form_policy TO service_role;
ALTER TABLE public.form_member_affiliation_snapshot
 ADD COLUMN IF NOT EXISTS profile_policy_version bigint,
 ADD COLUMN IF NOT EXISTS profile_group_id uuid,
 ADD COLUMN IF NOT EXISTS profile_requested_group_id uuid,
 ADD COLUMN IF NOT EXISTS profile_details jsonb;

CREATE OR REPLACE FUNCTION public.profile_affiliation_form_policy_save(p_tenant uuid,p_version bigint,p_config jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v bigint; target uuid; f form%ROWTYPE; cfg jsonb;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('profile-affiliation-policy:'||p_tenant::text,0));
 SELECT version INTO v FROM profile_affiliation_form_policy WHERE tenant_id=p_tenant FOR UPDATE;
 IF coalesce(v,0)<>p_version THEN RAISE EXCEPTION 'Settings changed; reload before saving' USING ERRCODE='40001'; END IF;
 IF p_config->>'version' IS DISTINCT FROM '1' OR p_config->>'enabled' NOT IN('true','false')
   OR jsonb_typeof(p_config->'mappings') IS DISTINCT FROM 'array' THEN
   RAISE EXCEPTION 'Invalid form routing policy' USING ERRCODE='22023';
 END IF;
 FOR target IN SELECT (value->>'formId')::uuid FROM jsonb_array_elements(p_config->'mappings')
   UNION SELECT nullif(p_config->>'fallbackFormId','')::uuid LOOP
   IF target IS NULL THEN CONTINUE; END IF;
   SELECT * INTO f FROM form WHERE id=target AND tenant_id=p_tenant FOR SHARE;
   SELECT config INTO cfg FROM form_member_affiliation_config WHERE form_id=target AND tenant_id=p_tenant FOR SHARE;
   IF f.id IS NULL OR cfg->>'purpose' IS DISTINCT FROM 'profile' OR cfg->>'enabled' IS DISTINCT FROM 'true'
     OR f.is_active IS DISTINCT FROM true OR f.archived_at IS NOT NULL
     OR f.require_authentication IS DISTINCT FROM true
     OR f.mutation_access_policy->>'mode' IS DISTINCT FROM 'authenticated_owner' THEN
     RAISE EXCEPTION 'Mapped form must be an active authenticated profile affiliation form' USING ERRCODE='22023';
   END IF;
 END LOOP;
 INSERT INTO profile_affiliation_form_policy(tenant_id,version,config) VALUES(p_tenant,1,p_config)
 ON CONFLICT(tenant_id) DO UPDATE SET version=profile_affiliation_form_policy.version+1,config=excluded.config,updated_at=now()
 RETURNING version INTO v;
 RETURN jsonb_build_object('version',v,'config',p_config);
END $$;
REVOKE ALL ON FUNCTION public.profile_affiliation_form_policy_save(uuid,bigint,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.profile_affiliation_form_policy_save(uuid,bigint,jsonb) TO service_role;

-- Database-side routing repeats the server decision under the policy/member
-- locks. A stale browser or an alternate public form URL is not authority.
CREATE OR REPLACE FUNCTION public.profile_affiliation_resolved_form(p_tenant uuid,p_member uuid,p_config jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE field text:=p_config->>'fieldId'; answer jsonb; entry jsonb; m member%ROWTYPE;
BEGIN
 SELECT * INTO STRICT m FROM member WHERE id=p_member AND tenant_id=p_tenant;
 IF field LIKE 'core:%' THEN
   IF substring(field FROM 6) NOT IN('job_title','status','role_id') THEN
     RAISE EXCEPTION 'Unsupported routing field' USING ERRCODE='22023';
   END IF;
   answer:=to_jsonb(m)->substring(field FROM 6);
 ELSIF field LIKE 'custom:%' THEN
   IF NOT EXISTS(SELECT 1 FROM preference_field WHERE id=substring(field FROM 8)::uuid
     AND tenant_id=p_tenant AND custom_object_id IS NULL
     AND (entity_scope IS NULL OR entity_scope='member') AND is_active IS DISTINCT FROM false) THEN
     RAISE EXCEPTION 'Routing field unavailable' USING ERRCODE='42501';
   END IF;
   SELECT to_jsonb(value) INTO answer FROM member_preference_value
     WHERE member_id=p_member AND field_id=substring(field FROM 8)::uuid;
 END IF;
 FOR entry IN SELECT value FROM jsonb_array_elements(p_config->'mappings') LOOP
   IF coalesce(answer #>> '{}','')=entry->>'value'
     OR (jsonb_typeof(answer)='array' AND answer @> jsonb_build_array(entry->>'value')) THEN
     RETURN (entry->>'formId')::uuid;
   END IF;
 END LOOP;
 RETURN nullif(p_config->>'fallbackFormId','')::uuid;
END $$;
REVOKE ALL ON FUNCTION public.profile_affiliation_resolved_form(uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.profile_form_affiliation_capture(p_tenant uuid,p_form uuid,p_member uuid,p_version bigint)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE policy profile_affiliation_form_policy%ROWTYPE; captured jsonb; group_id uuid; country text;
BEGIN
 SELECT * INTO policy FROM profile_affiliation_form_policy WHERE tenant_id=p_tenant FOR SHARE;
 IF policy.config->>'enabled' IS DISTINCT FROM 'true' OR policy.version<>p_version
   OR profile_affiliation_resolved_form(p_tenant,p_member,policy.config) IS DISTINCT FROM p_form THEN
   RAISE EXCEPTION 'Affiliation form selection changed' USING ERRCODE='40001';
 END IF;
 SELECT organization_group_id INTO group_id FROM member WHERE id=p_member AND tenant_id=p_tenant FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Member unavailable' USING ERRCODE='42501'; END IF;
 IF EXISTS(SELECT 1 FROM form_member_affiliation_review WHERE tenant_id=p_tenant AND member_id=p_member AND status='pending') THEN
   RAISE EXCEPTION 'An affiliation review is already pending; contact your administrator' USING ERRCODE='40001';
 END IF;
 captured:=form_member_affiliation_capture(p_tenant,p_form,p_member);
 IF captured->'config'->>'purpose' IS DISTINCT FROM 'profile' THEN
   RAISE EXCEPTION 'Profile form required' USING ERRCODE='42501';
 END IF;
 UPDATE form_member_affiliation_snapshot SET profile_policy_version=p_version,profile_group_id=group_id
 WHERE id=(captured->>'token')::uuid;
 -- Organisation country is optional; no country default may silently replace
 -- a known overseas affiliation. The server fills it from verified metadata.
 RETURN captured||jsonb_build_object('profile_group_id',group_id,'profile_policy_version',p_version);
END $$;
REVOKE ALL ON FUNCTION public.profile_form_affiliation_capture(uuid,uuid,uuid,bigint) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.profile_form_affiliation_capture(uuid,uuid,uuid,bigint) TO service_role;

CREATE OR REPLACE FUNCTION public.profile_form_affiliation_apply(
 p_token uuid,p_submission uuid,p_primary uuid,p_departments uuid[],p_secondary uuid[],p_group uuid,p_details jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE s form_member_affiliation_snapshot%ROWTYPE; policy profile_affiliation_form_policy%ROWTYPE;
 current_group uuid; result jsonb; original_departments uuid[]; edge jsonb; related uuid; new_departments uuid[];
BEGIN
 LOCK TABLE custom_object_relationship,custom_object_record IN SHARE ROW EXCLUSIVE MODE;
 SELECT * INTO STRICT s FROM form_member_affiliation_snapshot WHERE id=p_token FOR UPDATE;
 IF s.config->>'purpose' IS DISTINCT FROM 'profile' OR s.submission_id IS DISTINCT FROM p_submission THEN
   RAISE EXCEPTION 'Profile submission binding required' USING ERRCODE='42501';
 END IF;
 IF s.result->>'committed'='true' THEN
   IF s.profile_requested_group_id IS DISTINCT FROM p_group THEN
     RAISE EXCEPTION 'Request changed on replay' USING ERRCODE='23505';
   END IF;
   RETURN form_member_affiliation_apply_internal(p_token,p_submission,p_primary,p_departments,p_secondary);
 END IF;
 SELECT * INTO policy FROM profile_affiliation_form_policy WHERE tenant_id=s.tenant_id FOR SHARE;
 SELECT organization_group_id INTO current_group FROM member WHERE tenant_id=s.tenant_id AND id=s.member_id FOR UPDATE;
 IF policy.config->>'enabled' IS DISTINCT FROM 'true' OR policy.version IS DISTINCT FROM s.profile_policy_version
   OR profile_affiliation_resolved_form(s.tenant_id,s.member_id,policy.config) IS DISTINCT FROM s.form_id
   OR current_group IS DISTINCT FROM s.profile_group_id THEN
   RAISE EXCEPTION 'Affiliations or routing changed; reopen the form' USING ERRCODE='40001';
 END IF;
 IF EXISTS(SELECT 1 FROM form_member_affiliation_review WHERE tenant_id=s.tenant_id AND member_id=s.member_id AND status='pending') THEN
   RAISE EXCEPTION 'Another affiliation request is pending' USING ERRCODE='40001';
 END IF;
 IF p_group IS NOT NULL AND NOT EXISTS(SELECT 1 FROM organization_group WHERE id=p_group AND tenant_id=s.tenant_id) THEN
   RAISE EXCEPTION 'Organisation Group unavailable' USING ERRCODE='42501';
 END IF;
 IF p_group IS NOT NULL AND p_primary IS NOT NULL AND p_primary IS DISTINCT FROM (s.config->>'unknownOrganizationId')::uuid
   AND NOT EXISTS(SELECT 1 FROM organization WHERE id=p_primary AND tenant_id=s.tenant_id AND organization_group_id=p_group)
   AND (p_primary IS DISTINCT FROM (s.graph->>'organization_id')::uuid OR p_group IS DISTINCT FROM s.profile_group_id) THEN
   RAISE EXCEPTION 'Organisation is outside the selected group' USING ERRCODE='42501';
 END IF;
 original_departments:='{}';
 FOR edge IN SELECT value FROM jsonb_array_elements(s.graph->'links') WHERE value->>'relationship_definition_id'=s.config->>'memberDepartmentDefinitionId' LOOP
   related:=CASE WHEN edge->>'source_record_id'=s.member_id::text THEN (edge->>'target_record_id')::uuid ELSE (edge->>'source_record_id')::uuid END;
   original_departments:=array_append(original_departments,related);
   IF NOT related=ANY(p_departments) AND EXISTS(SELECT 1 FROM jsonb_each(coalesce(edge->'field_values','{}'))
     WHERE value IS DISTINCT FROM 'false'::jsonb AND value IS DISTINCT FROM 'null'::jsonb) THEN
     RAISE EXCEPTION 'Protected department links cannot be removed' USING ERRCODE='42501';
   END IF;
 END LOOP;
 SELECT coalesce(array_agg(id),'{}') INTO new_departments FROM unnest(p_departments) id WHERE NOT id=ANY(original_departments);
 IF EXISTS(SELECT 1 FROM custom_object_relationship r
   WHERE r.tenant_id=s.tenant_id AND r.relationship_definition_id=(s.config->>'memberDepartmentDefinitionId')::uuid
   AND r.archived_at IS NOT NULL
   AND ((r.source_record_id=s.member_id AND r.target_record_id=ANY(new_departments))
     OR (r.target_record_id=s.member_id AND r.source_record_id=ANY(new_departments)))
   AND EXISTS(SELECT 1 FROM jsonb_each(coalesce(r.field_values,'{}')) v
     WHERE v.value IS DISTINCT FROM 'false'::jsonb AND v.value IS DISTINCT FROM 'null'::jsonb)) THEN
   RAISE EXCEPTION 'Previously protected department links require administrator assistance' USING ERRCODE='42501';
 END IF;
 -- Validate new links against their final organisations; retain grandfathered
 -- existing links unless the member explicitly removes them.
 PERFORM validate_form_member_affiliation_plan(s.tenant_id,s.config,
   jsonb_build_object('primary',p_primary,'departments',new_departments,'secondary',p_secondary));
 result:=form_member_affiliation_apply_internal(p_token,p_submission,p_primary,p_departments,p_secondary);
 UPDATE member SET organization_group_id=p_group WHERE id=s.member_id AND tenant_id=s.tenant_id
   AND organization_group_id IS DISTINCT FROM p_group;
 UPDATE form_member_affiliation_snapshot SET profile_requested_group_id=p_group,profile_details=p_details
 WHERE id=p_token;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.profile_form_affiliation_apply(uuid,uuid,uuid,uuid[],uuid[],uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.profile_form_affiliation_apply(uuid,uuid,uuid,uuid[],uuid[],uuid,jsonb) TO service_role;

-- Warn before disabling an assigned form, regardless of which editor/API is used.
CREATE OR REPLACE FUNCTION public.guard_profile_affiliation_form_lifecycle()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM profile_affiliation_form_policy p WHERE p.tenant_id=OLD.tenant_id AND p.config->>'enabled'='true'
   AND (p.config->>'fallbackFormId'=OLD.id::text OR EXISTS(
     SELECT 1 FROM jsonb_array_elements(p.config->'mappings') x WHERE x->>'formId'=OLD.id::text))) THEN
   IF TG_OP='DELETE' THEN
     RAISE EXCEPTION 'This form is assigned to member affiliations. Change the profile form mapping before deleting it.' USING ERRCODE='23514';
   END IF;
   IF NEW.is_active IS DISTINCT FROM true OR NEW.archived_at IS NOT NULL
     OR NEW.require_authentication IS DISTINCT FROM true OR NEW.member_affiliation_enabled IS DISTINCT FROM true
     OR NEW.mutation_access_policy->>'mode' IS DISTINCT FROM 'authenticated_owner'
     OR NEW.deactivate_at IS DISTINCT FROM OLD.deactivate_at THEN
     RAISE EXCEPTION 'This form is assigned to member affiliations. Change its mapping before disabling or restricting it.' USING ERRCODE='23514';
   END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_profile_affiliation_form_lifecycle() FROM PUBLIC,anon,authenticated,service_role;
DROP TRIGGER IF EXISTS profile_affiliation_form_lifecycle ON public.form;
CREATE TRIGGER profile_affiliation_form_lifecycle BEFORE UPDATE OR DELETE ON public.form
 FOR EACH ROW EXECUTE FUNCTION public.guard_profile_affiliation_form_lifecycle();

CREATE OR REPLACE FUNCTION public.guard_profile_affiliation_bindings()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
 IF OLD.config->>'purpose'='profile' THEN
   RAISE EXCEPTION 'Verified profile affiliation bindings cannot be disabled or repurposed. Change the tenant form routing instead.' USING ERRCODE='42501';
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_profile_affiliation_bindings() FROM PUBLIC,anon,authenticated,service_role;
DROP TRIGGER IF EXISTS profile_affiliation_bindings ON public.form_member_affiliation_config;
CREATE TRIGGER profile_affiliation_bindings BEFORE UPDATE OR DELETE ON public.form_member_affiliation_config
 FOR EACH ROW EXECUTE FUNCTION public.guard_profile_affiliation_bindings();

-- Fence direct legacy saves in the same database transaction, including an
-- already-open modal when an administrator enables form mode.
DO $$
BEGIN
 IF to_regprocedure('public.profile_affiliation_apply_legacy(uuid,uuid,uuid,jsonb)') IS NULL
   AND to_regprocedure('public.profile_affiliation_apply(uuid,uuid,uuid,jsonb)') IS NOT NULL THEN
   ALTER FUNCTION public.profile_affiliation_apply(uuid,uuid,uuid,jsonb) RENAME TO profile_affiliation_apply_legacy;
   REVOKE ALL ON FUNCTION public.profile_affiliation_apply_legacy(uuid,uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role;
 END IF;
END $$;
CREATE OR REPLACE FUNCTION public.profile_affiliation_apply(p_tenant uuid,p_member uuid,p_token uuid,p_request jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE cfg jsonb;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('profile-affiliation-policy:'||p_tenant::text,0));
 SELECT config INTO cfg FROM profile_affiliation_form_policy WHERE tenant_id=p_tenant FOR SHARE;
 IF cfg->>'enabled'='true' THEN
   RAISE EXCEPTION 'Use the configured affiliation form' USING ERRCODE='42501';
 END IF;
 IF EXISTS(SELECT 1 FROM form_member_affiliation_snapshot WHERE tenant_id=p_tenant AND member_id=p_member
   AND config->>'purpose'='profile' AND submission_id IS NOT NULL AND result IS NULL) THEN
   RAISE EXCEPTION 'A saved affiliation submission needs recovery before direct editing' USING ERRCODE='40001';
 END IF;
 RETURN profile_affiliation_apply_legacy(p_tenant,p_member,p_token,p_request);
END $$;
REVOKE ALL ON FUNCTION public.profile_affiliation_apply(uuid,uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.profile_affiliation_apply(uuid,uuid,uuid,jsonb) TO service_role;
COMMIT;
