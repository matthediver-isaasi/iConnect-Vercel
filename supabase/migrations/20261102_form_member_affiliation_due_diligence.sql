-- Additive, opt-in integration. Existing DD configurations remain NULL and
-- existing submissions are neither enrolled nor transitioned.
BEGIN;
ALTER TABLE public.form ADD COLUMN IF NOT EXISTS member_affiliation_enabled boolean NOT NULL DEFAULT false;
CREATE FUNCTION public.protect_form_member_affiliation_marker()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
 -- A duplicated form starts unconfigured. Generic form saves cannot enable or
 -- disable the protected execution mode independently of its private config.
 NEW.member_affiliation_enabled:=EXISTS(
   SELECT 1 FROM form_member_affiliation_config c
   WHERE c.form_id=NEW.id AND c.tenant_id=NEW.tenant_id AND c.config->>'enabled'='true');
 RETURN NEW;
END $$;
CREATE TRIGGER protect_form_member_affiliation_marker BEFORE INSERT OR UPDATE OF member_affiliation_enabled
 ON public.form FOR EACH ROW EXECUTE FUNCTION public.protect_form_member_affiliation_marker();
ALTER TABLE public.form_due_diligence_config ADD COLUMN IF NOT EXISTS affiliation_review jsonb;
CREATE FUNCTION public.guard_affiliation_due_diligence_config()
RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$
BEGIN
 IF TG_OP='DELETE' THEN
   IF OLD.affiliation_review IS NOT NULL THEN
     RAISE EXCEPTION 'Dedicated affiliation workflows cannot be deleted' USING ERRCODE='42501';
   END IF;
   RETURN OLD;
 END IF;
 IF TG_OP='UPDATE' AND OLD.affiliation_review IS NOT NULL
   AND NEW.affiliation_review IS DISTINCT FROM OLD.affiliation_review THEN
   RAISE EXCEPTION 'Affiliation workflow purpose is immutable' USING ERRCODE='42501';
 END IF;
 IF NEW.affiliation_review IS NOT NULL THEN
   IF NEW.affiliation_review->>'enabled' IS DISTINCT FROM 'true'
     OR NEW.affiliation_review->>'version' IS DISTINCT FROM '1'
     OR NEW.affiliation_review->>'approved_stage_id' IS NULL
     OR NEW.affiliation_review->>'rejected_stage_id' IS NULL
     OR NEW.affiliation_review->>'approved_stage_id'=NEW.affiliation_review->>'rejected_stage_id'
     OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.workflow_stages) s WHERE s->>'id'=NEW.affiliation_review->>'approved_stage_id')
     OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.workflow_stages) s WHERE s->>'id'=NEW.affiliation_review->>'rejected_stage_id')
     OR coalesce(to_jsonb(NEW)->'status_change_webhooks','[]'::jsonb) NOT IN ('[]'::jsonb,'null'::jsonb)
     OR nullif(to_jsonb(NEW)->>'on_first_edit_stage','') IS NOT NULL THEN
     RAISE EXCEPTION 'Invalid dedicated affiliation workflow' USING ERRCODE='22023';
   END IF;
   IF EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.workflow_stages) stage,
     LATERAL jsonb_object_keys(stage) key
     WHERE key NOT IN('id','label','name','color','is_initial','order','description','selection_conditions')) THEN
     RAISE EXCEPTION 'Dedicated affiliation stages cannot contain automatic actions or timers' USING ERRCODE='22023';
   END IF;
   IF TG_OP='UPDATE' AND OLD.affiliation_review IS NULL THEN
     RAISE EXCEPTION 'Create a separate affiliation workflow; existing workflows cannot be converted' USING ERRCODE='42501';
   END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER guard_affiliation_due_diligence_config BEFORE INSERT OR UPDATE OR DELETE
 ON public.form_due_diligence_config FOR EACH ROW EXECUTE FUNCTION public.guard_affiliation_due_diligence_config();
ALTER TABLE public.form_member_affiliation_review
 ADD COLUMN due_diligence_submission_id uuid REFERENCES public.form_submission_due_diligence(id),
 ADD COLUMN review_form_submission_id uuid REFERENCES public.form_submission(id),
 ADD COLUMN resolution jsonb,
 ADD COLUMN proposed_resolution jsonb,
 ADD COLUMN resolution_version integer NOT NULL DEFAULT 0,
 ADD COLUMN resolved_by text,
 ADD COLUMN resolved_at timestamptz,
 ADD COLUMN decided_by text,
 ADD COLUMN decided_at timestamptz,
 ADD COLUMN decision_occurrence_id text;
CREATE UNIQUE INDEX form_member_affiliation_review_dd_unique
 ON public.form_member_affiliation_review(due_diligence_submission_id)
 WHERE due_diligence_submission_id IS NOT NULL;

CREATE FUNCTION public.open_form_member_affiliation_review(p_tenant_id uuid,p_review_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE r form_member_affiliation_review%ROWTYPE; cfg jsonb; review_form uuid;
 policy jsonb; stages jsonb; first_stage text; sub_id uuid; dd_id uuid; answers jsonb; member_json jsonb;
BEGIN
 SELECT * INTO r FROM form_member_affiliation_review WHERE id=p_review_id AND tenant_id=p_tenant_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Review not found' USING ERRCODE='42501'; END IF;
 IF r.due_diligence_submission_id IS NOT NULL THEN
   RETURN jsonb_build_object('id',r.due_diligence_submission_id,'replayed',true);
 END IF;
 SELECT config INTO cfg FROM form_member_affiliation_snapshot WHERE id=r.snapshot_id AND tenant_id=p_tenant_id;
 review_form:=nullif(cfg->>'dueDiligenceReviewFormId','')::uuid;
 IF review_form IS NULL OR review_form=r.form_id THEN
   RAISE EXCEPTION 'A separate affiliation review form is required' USING ERRCODE='22023';
 END IF;
 PERFORM 1 FROM form WHERE id=review_form AND tenant_id=p_tenant_id AND require_authentication=true FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Review form unavailable' USING ERRCODE='42501'; END IF;
 SELECT affiliation_review,workflow_stages INTO policy,stages FROM form_due_diligence_config
   WHERE form_id=review_form AND tenant_id=p_tenant_id FOR SHARE;
 IF policy->>'enabled' IS DISTINCT FROM 'true' OR policy->>'version' IS DISTINCT FROM '1' THEN
   RAISE EXCEPTION 'Affiliation review workflow is not configured' USING ERRCODE='22023';
 END IF;
 SELECT value->>'id' INTO first_stage FROM jsonb_array_elements(stages)
   WHERE value->>'is_initial'='true' LIMIT 1;
 IF first_stage IS NULL OR first_stage IN(policy->>'approved_stage_id',policy->>'rejected_stage_id') THEN
   RAISE EXCEPTION 'A non-decision initial review stage is required' USING ERRCODE='22023';
 END IF;
 sub_id:=gen_random_uuid(); dd_id:=gen_random_uuid();
 SELECT to_jsonb(m) INTO member_json FROM member m WHERE m.id=r.member_id AND m.tenant_id=p_tenant_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'Review member unavailable' USING ERRCODE='42501'; END IF;
 answers:=jsonb_build_object('affiliation_requested_changes',r.details,'affiliation_source_submission',r.submission_id,
   'member_name',coalesce(nullif(btrim(concat_ws(' ',member_json->>'first_name',member_json->>'last_name')),''),'Member'),
   'member_email',member_json->>'email');
 INSERT INTO form_submission(id,tenant_id,form_id,created_member_id,submission_data)
   VALUES(sub_id,p_tenant_id,review_form,r.member_id,answers);
 -- Deliberately no initialization actions, emails, payment processing or join
 -- pipelines. The record is visible through the existing DD list/detail APIs.
 INSERT INTO form_submission_due_diligence(id,tenant_id,form_submission_id,application_uid,
   original_form_values,reviewed_form_values,field_review_status,workflow_status,history_log)
 VALUES(dd_id,p_tenant_id,sub_id,'AFF-'||dd_id::text,answers,answers,'{}',first_stage,
   jsonb_build_array(jsonb_build_object('timestamp',now(),'event_type','affiliation_review_requested',
     'user_email','System','details',jsonb_build_object('source_submission_id',r.submission_id))));
 UPDATE form_member_affiliation_review SET due_diligence_submission_id=dd_id,review_form_submission_id=sub_id WHERE id=r.id;
 RETURN jsonb_build_object('id',dd_id,'replayed',false);
END $$;
REVOKE ALL ON FUNCTION public.open_form_member_affiliation_review(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.open_form_member_affiliation_review(uuid,uuid) TO service_role;

CREATE FUNCTION public.validate_form_member_affiliation_plan(p_tenant_id uuid,p_config jsonb,p_resolution jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE cfg jsonb:=p_config; primary_id uuid;
 departments uuid[]; secondary_ids uuid[]; orgs uuid[]; parent_def uuid; dept_def uuid;
BEGIN
 IF jsonb_typeof(p_resolution) IS DISTINCT FROM 'object'
   OR NOT (p_resolution ?& ARRAY['primary','departments','secondary'])
   OR jsonb_typeof(p_resolution->'departments') IS DISTINCT FROM 'array'
   OR jsonb_typeof(p_resolution->'secondary') IS DISTINCT FROM 'array'
   OR jsonb_array_length(p_resolution->'departments')>500
   OR jsonb_array_length(p_resolution->'secondary')>100 THEN
   RAISE EXCEPTION 'Supply a complete resolved affiliation selection' USING ERRCODE='22023';
 END IF;
 primary_id:=(p_resolution->>'primary')::uuid;
 SELECT coalesce(array_agg(value::uuid),'{}') INTO departments FROM jsonb_array_elements_text(p_resolution->'departments');
 SELECT coalesce(array_agg(value::uuid),'{}') INTO secondary_ids FROM jsonb_array_elements_text(p_resolution->'secondary');
 IF array_position(departments,NULL) IS NOT NULL OR array_position(secondary_ids,NULL) IS NOT NULL
   OR cardinality(departments)<>(SELECT count(DISTINCT x) FROM unnest(departments)x)
   OR cardinality(secondary_ids)<>(SELECT count(DISTINCT x) FROM unnest(secondary_ids)x)
   OR primary_id=ANY(secondary_ids) THEN
   RAISE EXCEPTION 'Duplicate or invalid affiliation selection' USING ERRCODE='22023';
 END IF;
 orgs:=secondary_ids;
 IF primary_id IS NOT NULL THEN orgs:=array_append(orgs,primary_id); END IF;
 IF EXISTS(SELECT 1 FROM unnest(orgs)x WHERE NOT EXISTS(
   SELECT 1 FROM organization o WHERE o.id=x AND o.tenant_id=p_tenant_id)) THEN
   RAISE EXCEPTION 'Organisation unavailable' USING ERRCODE='42501';
 END IF;
 dept_def:=nullif(cfg->>'memberDepartmentDefinitionId','')::uuid;
 parent_def:=nullif(cfg->>'departmentOrganizationDefinitionId','')::uuid;
 IF cardinality(departments)>0 THEN
   IF dept_def IS NULL OR parent_def IS NULL THEN
     RAISE EXCEPTION 'Department eligibility configuration is incomplete' USING ERRCODE='22023';
   END IF;
   IF EXISTS(SELECT 1 FROM unnest(departments)x WHERE NOT EXISTS(
     SELECT 1 FROM custom_object_record c
     JOIN custom_object_relationship_definition md ON md.id=dept_def AND md.tenant_id=c.tenant_id AND md.status='active'
     JOIN custom_object_relationship_definition pd ON pd.id=parent_def AND pd.tenant_id=c.tenant_id AND pd.status='active'
     JOIN custom_object_relationship e ON e.relationship_definition_id=pd.id AND e.tenant_id=c.tenant_id AND e.archived_at IS NULL
     WHERE c.id=x AND c.tenant_id=p_tenant_id AND c.archived_at IS NULL
       AND ((md.source_kind='member' AND md.target_kind='custom_object' AND md.target_custom_object_id=c.custom_object_id)
         OR (md.target_kind='member' AND md.source_kind='custom_object' AND md.source_custom_object_id=c.custom_object_id))
       AND ((pd.source_kind='organization' AND pd.target_kind='custom_object' AND pd.target_custom_object_id=c.custom_object_id
          AND e.target_record_id=c.id AND e.source_record_id=ANY(orgs))
         OR (pd.target_kind='organization' AND pd.source_kind='custom_object' AND pd.source_custom_object_id=c.custom_object_id
          AND e.source_record_id=c.id AND e.target_record_id=ANY(orgs)))
   )) THEN RAISE EXCEPTION 'A department is not eligible for the resolved organisations' USING ERRCODE='42501'; END IF;
 END IF;
END $$;
REVOKE ALL ON FUNCTION public.validate_form_member_affiliation_plan(uuid,jsonb,jsonb) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.validate_form_member_affiliation_resolution(p_tenant_id uuid,p_review_id uuid,p_resolution jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE cfg jsonb;
BEGIN
 SELECT s.config INTO cfg FROM form_member_affiliation_review r
 JOIN form_member_affiliation_snapshot s ON s.id=r.snapshot_id AND s.tenant_id=r.tenant_id
 WHERE r.id=p_review_id AND r.tenant_id=p_tenant_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'Review not found' USING ERRCODE='42501'; END IF;
 PERFORM validate_form_member_affiliation_plan(p_tenant_id,cfg,p_resolution);
END $$;
REVOKE ALL ON FUNCTION public.validate_form_member_affiliation_resolution(uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role;

ALTER FUNCTION public.form_member_affiliation_apply(uuid,uuid,uuid,uuid[],uuid[]) RENAME TO form_member_affiliation_apply_internal;
REVOKE ALL ON FUNCTION public.form_member_affiliation_apply_internal(uuid,uuid,uuid,uuid[],uuid[]) FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.form_member_affiliation_apply(
 p_token uuid,p_submission uuid,p_primary uuid,p_departments uuid[],p_secondary uuid[]
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE s form_member_affiliation_snapshot%ROWTYPE;
BEGIN
 LOCK TABLE custom_object_relationship,custom_object_record IN SHARE ROW EXCLUSIVE MODE;
 SELECT * INTO s FROM form_member_affiliation_snapshot WHERE id=p_token FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Snapshot unavailable' USING ERRCODE='42501'; END IF;
 IF s.result->>'committed' IS DISTINCT FROM 'true' THEN
   PERFORM validate_form_member_affiliation_plan(s.tenant_id,s.config,
     jsonb_build_object('primary',p_primary,'departments',p_departments,'secondary',p_secondary));
 END IF;
 RETURN form_member_affiliation_apply_internal(p_token,p_submission,p_primary,p_departments,p_secondary);
END $$;
REVOKE ALL ON FUNCTION public.form_member_affiliation_apply(uuid,uuid,uuid,uuid[],uuid[]) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.form_member_affiliation_apply(uuid,uuid,uuid,uuid[],uuid[]) TO service_role;

CREATE FUNCTION public.save_form_member_affiliation_resolution(
 p_tenant_id uuid,p_review_id uuid,p_actor text,p_resolution jsonb,p_expected_version integer
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE r form_member_affiliation_review%ROWTYPE;
BEGIN
 IF nullif(btrim(p_actor),'') IS NULL THEN RAISE EXCEPTION 'Reviewer required' USING ERRCODE='42501'; END IF;
 SELECT * INTO r FROM form_member_affiliation_review WHERE tenant_id=p_tenant_id AND id=p_review_id FOR UPDATE;
 IF NOT FOUND OR r.due_diligence_submission_id IS NULL THEN RAISE EXCEPTION 'Review unavailable' USING ERRCODE='42501'; END IF;
 IF r.status<>'pending' OR r.resolution_version IS DISTINCT FROM p_expected_version THEN
   RAISE EXCEPTION 'Review changed; reload before saving' USING ERRCODE='40001';
 END IF;
 PERFORM validate_form_member_affiliation_resolution(p_tenant_id,p_review_id,p_resolution);
 UPDATE form_member_affiliation_review SET resolution=p_resolution,resolution_version=resolution_version+1,
   resolved_by=p_actor,resolved_at=now() WHERE id=r.id;
 RETURN jsonb_build_object('status','saved','version',r.resolution_version+1,'resolution',p_resolution);
END $$;
REVOKE ALL ON FUNCTION public.save_form_member_affiliation_resolution(uuid,uuid,text,jsonb,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.save_form_member_affiliation_resolution(uuid,uuid,text,jsonb,integer) TO service_role;

CREATE FUNCTION public.decide_form_member_affiliation_review(
 p_tenant_id uuid,p_review_id uuid,p_due_diligence_submission_id uuid,p_stage_id text,
 p_occurrence_id text,p_actor text,p_decision text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE r form_member_affiliation_review%ROWTYPE; dd form_submission_due_diligence%ROWTYPE;
 s form_member_affiliation_snapshot%ROWTYPE; policy jsonb; review_form uuid;
 desired_stage text; result jsonb; departments uuid[]; secondary_ids uuid[];
BEGIN
 IF p_decision IS NULL OR p_decision NOT IN('approve','reject')
   OR nullif(btrim(p_actor),'') IS NULL OR nullif(p_occurrence_id,'') IS NULL THEN
   RAISE EXCEPTION 'Verified review decision required' USING ERRCODE='42501';
 END IF;
 -- Same graph lock order as the normal affiliation transaction.
 LOCK TABLE custom_object_relationship,custom_object_record IN SHARE ROW EXCLUSIVE MODE;
 SELECT * INTO r FROM form_member_affiliation_review WHERE id=p_review_id AND tenant_id=p_tenant_id FOR UPDATE;
 IF NOT FOUND OR r.due_diligence_submission_id IS DISTINCT FROM p_due_diligence_submission_id THEN
   RAISE EXCEPTION 'Review case mismatch' USING ERRCODE='42501';
 END IF;
 SELECT * INTO dd FROM form_submission_due_diligence WHERE id=p_due_diligence_submission_id
   AND tenant_id=p_tenant_id FOR UPDATE;
 IF NOT FOUND OR dd.form_submission_id IS DISTINCT FROM r.review_form_submission_id
   OR dd.workflow_status IS DISTINCT FROM p_stage_id
   OR coalesce(nullif(to_jsonb(dd)->>'stage_action_occurrence_id',''),dd.id::text) IS DISTINCT FROM p_occurrence_id THEN
   RAISE EXCEPTION 'Review stage changed; reload before deciding' USING ERRCODE='40001';
 END IF;
 SELECT form_id INTO review_form FROM form_submission WHERE id=r.review_form_submission_id AND tenant_id=p_tenant_id;
 SELECT affiliation_review INTO policy FROM form_due_diligence_config WHERE form_id=review_form AND tenant_id=p_tenant_id FOR SHARE;
 desired_stage:=CASE WHEN p_decision='approve' THEN policy->>'approved_stage_id' ELSE policy->>'rejected_stage_id' END;
 IF policy->>'enabled' IS DISTINCT FROM 'true' OR policy->>'version' IS DISTINCT FROM '1'
   OR desired_stage IS DISTINCT FROM p_stage_id THEN
   RAISE EXCEPTION 'This stage cannot decide affiliation reviews' USING ERRCODE='42501';
 END IF;
 IF r.status<>'pending' THEN
   IF (r.status='approved' AND p_decision='approve') OR (r.status='rejected' AND p_decision='reject') THEN
     RETURN jsonb_build_object('status',CASE WHEN r.status='approved' THEN 'already_applied' ELSE 'already_rejected' END);
   END IF;
   RAISE EXCEPTION 'Review already decided' USING ERRCODE='40001';
 END IF;
 IF p_decision='approve' THEN
   IF r.resolution IS NULL THEN RAISE EXCEPTION 'Resolve and save all affiliations before approval' USING ERRCODE='22023'; END IF;
   PERFORM validate_form_member_affiliation_resolution(p_tenant_id,p_review_id,r.resolution);
   SELECT * INTO s FROM form_member_affiliation_snapshot WHERE id=r.snapshot_id AND tenant_id=p_tenant_id FOR UPDATE;
   IF NOT FOUND OR s.member_id IS DISTINCT FROM r.member_id OR s.submission_id IS DISTINCT FROM r.submission_id
     OR s.result->>'review_id' IS DISTINCT FROM r.id::text OR s.result->>'status' IS DISTINCT FROM 'awaiting_review' THEN
     RAISE EXCEPTION 'Original affiliation request could not be verified' USING ERRCODE='42501';
   END IF;
   -- Review may take longer than the member's browser token lifetime. Only this
   -- verified admin decision extends it; apply still checks original graph/config.
   UPDATE form_member_affiliation_snapshot SET request=NULL,result=NULL,expires_at=now()+interval '1 minute' WHERE id=s.id;
   SELECT coalesce(array_agg(value::uuid),'{}') INTO departments FROM jsonb_array_elements_text(r.resolution->'departments');
   SELECT coalesce(array_agg(value::uuid),'{}') INTO secondary_ids FROM jsonb_array_elements_text(r.resolution->'secondary');
   result:=form_member_affiliation_apply(s.id,r.submission_id,(r.resolution->>'primary')::uuid,departments,secondary_ids);
   IF result->>'committed' IS DISTINCT FROM 'true' THEN
     RAISE EXCEPTION 'Affiliation application was not confirmed' USING ERRCODE='40001';
   END IF;
 END IF;
 UPDATE form_member_affiliation_review SET status=CASE WHEN p_decision='approve' THEN 'approved' ELSE 'rejected' END,
   decided_by=p_actor,decided_at=now(),decision_occurrence_id=p_occurrence_id WHERE id=r.id;
 RETURN jsonb_build_object('status',CASE WHEN p_decision='approve' THEN 'applied' ELSE 'rejected' END);
END $$;
REVOKE ALL ON FUNCTION public.decide_form_member_affiliation_review(uuid,uuid,uuid,text,text,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.decide_form_member_affiliation_review(uuid,uuid,uuid,text,text,text,text) TO service_role;

-- Only prospectively opted-in forms with a dedicated review workflow enqueue
-- DD cases. Creation is in the same transaction as deferral, so there is no
-- acknowledged review request which has silently lost its DD case.
ALTER FUNCTION public.form_member_affiliation_defer(uuid,uuid,jsonb) RENAME TO form_member_affiliation_defer_internal;
REVOKE ALL ON FUNCTION public.form_member_affiliation_defer_internal(uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.form_member_affiliation_defer(p_token uuid,p_submission uuid,p_details jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE result jsonb; s form_member_affiliation_snapshot%ROWTYPE;
BEGIN
 result:=form_member_affiliation_defer_internal(p_token,p_submission,p_details);
 SELECT * INTO s FROM form_member_affiliation_snapshot WHERE id=p_token;
 IF nullif(s.config->>'dueDiligenceReviewFormId','') IS NOT NULL THEN
   PERFORM open_form_member_affiliation_review(s.tenant_id,(result->>'review_id')::uuid);
 END IF;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.form_member_affiliation_defer(uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.form_member_affiliation_defer(uuid,uuid,jsonb) TO service_role;

CREATE FUNCTION public.defer_form_member_affiliation_change(
 p_token uuid,p_submission uuid,p_details jsonb,p_proposal jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE result jsonb; r form_member_affiliation_review%ROWTYPE; canonical jsonb;
 primary_id uuid; departments uuid[]; secondary_ids uuid[];
BEGIN
 IF jsonb_typeof(p_proposal) IS DISTINCT FROM 'object'
   OR NOT (p_proposal ?& ARRAY['primary','departments','secondary'])
   OR jsonb_typeof(p_proposal->'departments') IS DISTINCT FROM 'array'
   OR jsonb_typeof(p_proposal->'secondary') IS DISTINCT FROM 'array'
   OR jsonb_array_length(p_proposal->'departments')>500
   OR jsonb_array_length(p_proposal->'secondary')>100 THEN
   RAISE EXCEPTION 'Invalid affiliation proposal' USING ERRCODE='22023';
 END IF;
 primary_id:=(p_proposal->>'primary')::uuid;
 SELECT coalesce(array_agg(value::uuid),'{}') INTO departments FROM jsonb_array_elements_text(p_proposal->'departments');
 SELECT coalesce(array_agg(value::uuid),'{}') INTO secondary_ids FROM jsonb_array_elements_text(p_proposal->'secondary');
 IF array_position(departments,NULL) IS NOT NULL OR array_position(secondary_ids,NULL) IS NOT NULL THEN
   RAISE EXCEPTION 'Invalid affiliation proposal targets' USING ERRCODE='22023';
 END IF;
 canonical:=jsonb_build_object('primary',primary_id,'departments',departments,'secondary',secondary_ids);
 result:=form_member_affiliation_defer(p_token,p_submission,p_details);
 SELECT * INTO r FROM form_member_affiliation_review WHERE id=(result->>'review_id')::uuid FOR UPDATE;
 IF r.proposed_resolution IS NOT NULL AND r.proposed_resolution IS DISTINCT FROM canonical THEN
   RAISE EXCEPTION 'Affiliation proposal changed on retry' USING ERRCODE='40001';
 END IF;
 UPDATE form_member_affiliation_review SET proposed_resolution=canonical WHERE id=r.id AND proposed_resolution IS NULL;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.defer_form_member_affiliation_change(uuid,uuid,jsonb,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.defer_form_member_affiliation_change(uuid,uuid,jsonb,jsonb) TO service_role;

CREATE FUNCTION public.configure_form_member_affiliations(p_tenant_id uuid,p_form_id uuid,p_config jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE source_form form%ROWTYPE; old_config jsonb; cfg jsonb; review_form uuid; new_config_id uuid;
BEGIN
 SELECT * INTO source_form FROM form WHERE id=p_form_id AND tenant_id=p_tenant_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Form unavailable' USING ERRCODE='42501'; END IF;
 IF jsonb_typeof(p_config) IS DISTINCT FROM 'object' OR p_config->>'version' IS DISTINCT FROM '1'
   OR p_config->>'enabled' IS NULL
   OR p_config->>'enabled' NOT IN('true','false') THEN RAISE EXCEPTION 'Invalid configuration' USING ERRCODE='22023'; END IF;
 SELECT config INTO old_config FROM form_member_affiliation_config WHERE tenant_id=p_tenant_id AND form_id=p_form_id;
 review_form:=nullif(old_config->>'dueDiligenceReviewFormId','')::uuid;
 IF p_config->>'enabled'='true' THEN
   IF source_form.require_authentication IS DISTINCT FROM true
     OR source_form.mutation_access_policy->>'mode' IS DISTINCT FROM 'authenticated_owner' THEN
     RAISE EXCEPTION 'Authenticated-owner form required' USING ERRCODE='42501';
   END IF;
   IF review_form IS NULL THEN
     review_form:=gen_random_uuid(); new_config_id:=gen_random_uuid();
     INSERT INTO form(id,tenant_id,name,slug,fields,pages,is_active,require_authentication,mutation_access_policy,due_diligence_required)
       VALUES(review_form,p_tenant_id,coalesce(source_form.name,'Membership')||' — affiliation review',
       'affiliation-review-'||review_form::text,
       '[{"id":"member_name","type":"text","label":"Member"},{"id":"member_email","type":"email","label":"Email"}]',
       '[]',false,true,'{"version":1,"mode":"authenticated_owner"}',true);
     INSERT INTO form_due_diligence_config(id,tenant_id,form_id,workflow_stages,affiliation_review,applicant_name_field,applicant_email_field)
       VALUES(new_config_id,p_tenant_id,review_form,
         '[{"id":"review","label":"Review affiliations","is_initial":true,"order":0},{"id":"approved","label":"Approve affiliations","order":1},{"id":"rejected","label":"Leave affiliations unchanged","order":2}]',
         '{"version":1,"enabled":true,"approved_stage_id":"approved","rejected_stage_id":"rejected"}',
         'member_name','member_email');
   END IF;
 END IF;
 cfg:=(p_config-'dueDiligenceReviewFormId')||jsonb_build_object('dueDiligenceReviewFormId',review_form);
 INSERT INTO form_member_affiliation_config(tenant_id,form_id,config) VALUES(p_tenant_id,p_form_id,cfg)
 ON CONFLICT(tenant_id,form_id) DO UPDATE SET config=excluded.config,updated_at=now();
 UPDATE form SET member_affiliation_enabled=(cfg->>'enabled')::boolean WHERE id=p_form_id AND tenant_id=p_tenant_id;
 RETURN cfg;
END $$;
REVOKE ALL ON FUNCTION public.configure_form_member_affiliations(uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.configure_form_member_affiliations(uuid,uuid,jsonb) TO service_role;
COMMIT;
