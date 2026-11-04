-- Explicit, service-only lifecycle authority. No live survey is activated by
-- this migration; legacy availability remains the conservative fallback.
BEGIN;
CREATE TABLE IF NOT EXISTS public.survey_lifecycle_confirmation (
  token uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  form_id uuid NOT NULL,
  actor text NOT NULL,
  action text NOT NULL,
  assignment_id uuid,
  impact jsonb NOT NULL,
  expires_at timestamptz NOT NULL DEFAULT now() + interval '10 minutes'
);
CREATE TABLE IF NOT EXISTS public.survey_lifecycle_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  form_id uuid NOT NULL,
  assignment_id uuid,
  actor text NOT NULL,
  action text NOT NULL,
  previous_state text NOT NULL,
  new_state text NOT NULL,
  impact jsonb NOT NULL,
  acknowledged boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE public.survey_lifecycle_confirmation ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.survey_lifecycle_audit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.survey_lifecycle_confirmation, public.survey_lifecycle_audit FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.survey_effective_lifecycle(f public.form)
RETURNS text LANGUAGE sql STABLE SET search_path=public AS $$
 SELECT CASE WHEN f.archived_at IS NOT NULL THEN 'archived'
 WHEN f.survey_settings->>'lifecycle_state' IN ('draft','active','paused','closed','archived')
 THEN f.survey_settings->>'lifecycle_state'
 WHEN f.survey_settings->>'status'='archived' THEN 'archived'
 WHEN f.is_active IS NOT TRUE THEN 'paused'
 WHEN f.survey_settings->>'status'='published' THEN 'active'
 ELSE 'draft' END
$$;

CREATE OR REPLACE FUNCTION public.manage_survey_lifecycle(
 p_tenant uuid,p_actor text,p_form uuid,p_operation text,p_action text DEFAULT NULL,
 p_assignment uuid DEFAULT NULL,p_token uuid DEFAULT NULL,
 p_acknowledged boolean DEFAULT false,p_delete_confirmation text DEFAULT NULL,p_changes jsonb DEFAULT '{}')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE f public.form; a public.event_survey_assignment; c public.survey_lifecycle_confirmation;
 state text; target text; impact jsonb; events jsonb; responses bigint; invitations bigint;
 assignments bigint; eligible boolean; tok uuid; history jsonb;
 dependency record; predicate text; found_dependency boolean;
BEGIN
 IF p_actor IS NULL OR btrim(p_actor)='' THEN RAISE EXCEPTION 'Administrator required'; END IF;
 SELECT * INTO f FROM public.form WHERE id=p_form AND tenant_id=p_tenant FOR UPDATE;
 IF NOT FOUND OR f.form_type<>'survey' THEN RAISE EXCEPTION 'Survey unavailable'; END IF;
 state:=public.survey_effective_lifecycle(f);
 IF p_operation='history' THEN
   SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.created_at DESC),'[]') INTO history
   FROM (SELECT action,previous_state,new_state,actor,created_at,assignment_id
     FROM public.survey_lifecycle_audit WHERE tenant_id=p_tenant AND form_id=p_form
     ORDER BY created_at DESC LIMIT 200) x;
   RETURN jsonb_build_object('state',state,'history',history);
 END IF;
 IF p_action NOT IN ('pause','close','archive','restore','activate','delete','remove_assignment','reattach_assignment','update_assignment')
 OR p_operation NOT IN ('preview','execute') THEN RAISE EXCEPTION 'Invalid action'; END IF;
 IF (p_action='pause' AND state<>'active')
 OR (p_action='close' AND state NOT IN ('active','paused'))
 OR (p_action='restore' AND state<>'archived')
 OR (p_action='activate' AND state NOT IN ('paused','closed'))
 OR (p_action='archive' AND state='archived')
 THEN RAISE EXCEPTION 'Invalid lifecycle transition'; END IF;
 IF p_action IN ('remove_assignment','reattach_assignment','update_assignment') THEN
   SELECT * INTO a FROM public.event_survey_assignment
   WHERE id=p_assignment AND form_id=p_form AND tenant_id=p_tenant FOR UPDATE;
   IF NOT FOUND THEN RAISE EXCEPTION 'Assignment unavailable'; END IF;
   IF p_action='update_assignment' THEN
     IF jsonb_typeof(p_changes)<>'object' OR (p_changes - 'opens_at' - 'closes_at' - 'access_mode')<>'{}'::jsonb
     OR p_changes->>'access_mode' NOT IN ('public','authenticated')
     THEN RAISE EXCEPTION 'Invalid assignment settings'; END IF;
     IF (p_changes->>'opens_at')::timestamptz >= (p_changes->>'closes_at')::timestamptz
     THEN RAISE EXCEPTION 'Closing time must be after opening time'; END IF;
   END IF;
 ELSIF p_assignment IS NOT NULL THEN RAISE EXCEPTION 'Unexpected assignment'; END IF;
 SELECT count(*),coalesce(jsonb_agg(jsonb_build_object('id',id,'title',event_title,'status',status,
   'opens_at',opens_at,'closes_at',closes_at,'access_mode',access_mode) ORDER BY id),'[]')
 INTO assignments,events FROM public.event_survey_assignment WHERE form_id=p_form AND tenant_id=p_tenant;
 SELECT count(*) INTO responses FROM public.form_submission WHERE form_id=p_form AND tenant_id=p_tenant;
 SELECT count(*) INTO invitations FROM public.certificate_survey_entitlement e
 JOIN public.event_survey_assignment s ON s.id=e.assignment_id
 WHERE s.form_id=p_form AND s.tenant_id=p_tenant;
 eligible:=assignments=0 AND responses=0 AND invitations=0
   AND NOT EXISTS(SELECT 1 FROM public.survey_version WHERE form_id=p_form)
   AND NOT EXISTS(SELECT 1 FROM public.survey_completion WHERE form_id=p_form AND tenant_id=p_tenant);
 -- Include all declared dependencies, even cascades that would otherwise be
 -- silently removed by a permanent delete. Composite tenant/form FKs count too.
 IF eligible THEN
   FOR dependency IN SELECT fk.conrelid,fk.conkey,fk.confkey,n.nspname,r.relname
     FROM pg_constraint fk JOIN pg_class r ON r.oid=fk.conrelid
     JOIN pg_namespace n ON n.oid=r.relnamespace
     WHERE fk.contype='f' AND fk.confrelid='public.form'::regclass
   LOOP
     SELECT string_agg(format('r.%I IS NOT DISTINCT FROM %L',child.attname,to_jsonb(f)->>parent.attname),' AND ')
     INTO predicate
     FROM unnest(dependency.conkey,dependency.confkey) AS keys(child_num,parent_num)
     JOIN pg_attribute child ON child.attrelid=dependency.conrelid AND child.attnum=keys.child_num
     JOIN pg_attribute parent ON parent.attrelid='public.form'::regclass AND parent.attnum=keys.parent_num;
     EXECUTE format('SELECT EXISTS(SELECT 1 FROM %I.%I r WHERE %s)',dependency.nspname,dependency.relname,predicate)
       INTO found_dependency;
     IF found_dependency THEN eligible:=false; EXIT; END IF;
   END LOOP;
 END IF;
 target:=CASE p_action WHEN 'pause' THEN 'paused' WHEN 'close' THEN 'closed'
 WHEN 'archive' THEN 'archived' WHEN 'restore' THEN 'paused'
 WHEN 'activate' THEN 'active' WHEN 'delete' THEN 'deleted' ELSE state END;
 impact:=jsonb_build_object('form_id',p_form,'name',f.name,'state',state,'action',p_action,
 'assignment_id',p_assignment,'events',events,'response_count',responses,
 'invitation_count',invitations,'assignment_count',assignments,'reversible',p_action<>'delete',
 'stops_submissions',p_action IN ('pause','close','archive','delete','remove_assignment','update_assignment'),
 'changes',p_changes,
 'deletion_allowed',eligible,'version',f.survey_settings->'current_version',
 'configuration',md5(to_jsonb(f)::text));
 IF p_operation='preview' THEN
   INSERT INTO public.survey_lifecycle_confirmation(tenant_id,form_id,actor,action,assignment_id,impact)
   VALUES(p_tenant,p_form,p_actor,p_action,p_assignment,impact) RETURNING token INTO tok;
   RETURN jsonb_build_object('impact',impact-'configuration','confirmation_token',tok);
 END IF;
 SELECT * INTO c FROM public.survey_lifecycle_confirmation WHERE token=p_token FOR UPDATE;
 IF NOT FOUND OR p_acknowledged IS DISTINCT FROM true OR c.tenant_id<>p_tenant OR c.form_id<>p_form OR c.actor<>p_actor
 OR c.action<>p_action OR c.assignment_id IS DISTINCT FROM p_assignment OR c.expires_at<now()
 OR c.impact IS DISTINCT FROM impact THEN RAISE EXCEPTION 'Stale or invalid confirmation'; END IF;
 IF p_action='delete' AND (NOT eligible OR p_delete_confirmation IS DISTINCT FROM 'DELETE') THEN
   RAISE EXCEPTION 'Survey has dependencies or deletion was not confirmed';
 END IF;
 IF p_action='activate' AND NOT EXISTS(SELECT 1 FROM public.survey_version
 WHERE form_id=p_form AND tenant_id=p_tenant AND version_number=(f.survey_settings->>'current_version')::integer)
 THEN RAISE EXCEPTION 'Publish the survey first'; END IF;
 PERFORM set_config('iconnect.survey_lifecycle_write','on',true);
 IF p_action='update_assignment' THEN
   UPDATE public.event_survey_assignment SET
   opens_at=CASE WHEN p_changes ? 'opens_at' THEN (p_changes->>'opens_at')::timestamptz ELSE opens_at END,
   closes_at=CASE WHEN p_changes ? 'closes_at' THEN (p_changes->>'closes_at')::timestamptz ELSE closes_at END,
   access_mode=coalesce(p_changes->>'access_mode',access_mode),updated_at=now()
   WHERE id=p_assignment AND tenant_id=p_tenant;
 ELSIF p_action IN ('remove_assignment','reattach_assignment') THEN
   UPDATE public.event_survey_assignment SET
     status=CASE WHEN p_action='remove_assignment' THEN 'archived' ELSE 'active' END,
     archived_at=CASE WHEN p_action='remove_assignment' THEN now() ELSE NULL END,
     archived_by=CASE WHEN p_action='remove_assignment' THEN p_actor ELSE NULL END,
     updated_at=now() WHERE id=p_assignment AND tenant_id=p_tenant;
 ELSIF p_action='delete' THEN
   DELETE FROM public.form WHERE id=p_form AND tenant_id=p_tenant;
 ELSE
   UPDATE public.form SET
     survey_settings=coalesce(survey_settings,'{}')||jsonb_build_object('lifecycle_state',target,
       'status',CASE WHEN target='active' THEN 'published' WHEN target='archived' THEN 'archived' ELSE 'draft' END),
     is_active=(target='active'),archived_at=CASE WHEN target='archived' THEN now() ELSE NULL END
   WHERE id=p_form AND tenant_id=p_tenant;
 END IF;
 INSERT INTO public.survey_lifecycle_audit(tenant_id,form_id,assignment_id,actor,action,previous_state,new_state,impact,acknowledged)
 VALUES(p_tenant,p_form,p_assignment,p_actor,p_action,
 CASE WHEN p_assignment IS NOT NULL THEN a.status ELSE state END,
 CASE WHEN p_action='remove_assignment' THEN 'removed' WHEN p_action='reattach_assignment' THEN 'attached' ELSE target END,
 impact-'configuration',true);
 DELETE FROM public.survey_lifecycle_confirmation WHERE token=p_token;
 PERFORM set_config('iconnect.survey_lifecycle_write','off',true);
 RETURN jsonb_build_object('success',true,'state',target);
END $$;
REVOKE ALL ON FUNCTION public.manage_survey_lifecycle(uuid,text,uuid,text,text,uuid,uuid,boolean,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.manage_survey_lifecycle(uuid,text,uuid,text,text,uuid,uuid,boolean,text,jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.survey_effective_lifecycle(public.form) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.survey_effective_lifecycle(public.form) TO service_role;
-- Serialize submissions and invitations with lifecycle changes. These guards
-- supplement the existing anonymity, eligibility and snapshot validators.
CREATE OR REPLACE FUNCTION public.guard_survey_lifecycle_submission()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE f public.form; a public.event_survey_assignment;
BEGIN
 SELECT * INTO f FROM public.form WHERE id=NEW.form_id FOR UPDATE;
 IF f.form_type IS DISTINCT FROM 'survey' THEN RETURN NEW; END IF;
 IF f.tenant_id IS DISTINCT FROM NEW.tenant_id OR public.survey_effective_lifecycle(f)<>'active'
 OR f.is_active IS NOT TRUE OR f.archived_at IS NOT NULL
 OR ((to_jsonb(f)->>'deactivate_at')::timestamptz IS NOT NULL AND (to_jsonb(f)->>'deactivate_at')::timestamptz<=now())
 THEN RAISE EXCEPTION 'Survey is not accepting responses'; END IF;
 IF NEW.survey_assignment_id IS NOT NULL THEN
   SELECT * INTO a FROM public.event_survey_assignment WHERE id=NEW.survey_assignment_id FOR UPDATE;
   IF NOT FOUND OR a.tenant_id<>NEW.tenant_id OR a.form_id<>NEW.form_id OR a.status<>'active'
   OR (a.opens_at IS NOT NULL AND now()<a.opens_at) OR (a.closes_at IS NOT NULL AND now()>=a.closes_at)
   THEN RAISE EXCEPTION 'Survey assignment unavailable'; END IF;
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS guard_survey_lifecycle_submission ON public.form_submission;
CREATE TRIGGER guard_survey_lifecycle_submission BEFORE INSERT ON public.form_submission
FOR EACH ROW EXECUTE FUNCTION public.guard_survey_lifecycle_submission();

CREATE OR REPLACE FUNCTION public.guard_survey_lifecycle_assignment()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Remove an assignment through survey lifecycle management'; END IF;
 PERFORM 1 FROM public.form WHERE id=NEW.form_id AND tenant_id=NEW.tenant_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Survey unavailable'; END IF;
 IF TG_OP='INSERT' THEN
   INSERT INTO public.survey_lifecycle_audit(tenant_id,form_id,assignment_id,actor,action,previous_state,new_state,impact,acknowledged)
   VALUES(NEW.tenant_id,NEW.form_id,NEW.id,coalesce(to_jsonb(NEW)->>'created_by','unknown'),
   'attach_assignment','unattached','attached',jsonb_build_object('event_title',NEW.event_title),false);
 END IF;
 IF TG_OP='UPDATE' AND current_setting('iconnect.survey_lifecycle_write',true) IS DISTINCT FROM 'on'
 AND (NEW.status IS DISTINCT FROM OLD.status OR NEW.opens_at IS DISTINCT FROM OLD.opens_at
 OR NEW.closes_at IS DISTINCT FROM OLD.closes_at OR NEW.access_mode IS DISTINCT FROM OLD.access_mode)
 THEN RAISE EXCEPTION 'Review assignment impact before changing availability'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS guard_survey_lifecycle_assignment ON public.event_survey_assignment;
CREATE TRIGGER guard_survey_lifecycle_assignment BEFORE INSERT OR UPDATE OR DELETE ON public.event_survey_assignment
FOR EACH ROW EXECUTE FUNCTION public.guard_survey_lifecycle_assignment();

CREATE OR REPLACE FUNCTION public.guard_survey_lifecycle_form()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE state text; published boolean;
BEGIN
 IF OLD.form_type IS DISTINCT FROM 'survey' THEN
   IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
 END IF;
 IF current_setting('iconnect.survey_lifecycle_write',true)='on' THEN
   IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
 END IF;
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Use survey lifecycle deletion'; END IF;
 IF NEW.form_type IS DISTINCT FROM OLD.form_type OR NEW.is_active IS DISTINCT FROM OLD.is_active
 OR NEW.archived_at IS DISTINCT FROM OLD.archived_at
 OR (to_jsonb(NEW)->'deactivate_at') IS DISTINCT FROM (to_jsonb(OLD)->'deactivate_at')
 OR NEW.survey_settings->>'lifecycle_state' IS DISTINCT FROM OLD.survey_settings->>'lifecycle_state'
 THEN RAISE EXCEPTION 'Use survey lifecycle management'; END IF;
 state:=public.survey_effective_lifecycle(OLD);
 IF state='active' AND (
 (to_jsonb(NEW)->'access_policy') IS DISTINCT FROM (to_jsonb(OLD)->'access_policy')
 OR (to_jsonb(NEW)->'require_authentication') IS DISTINCT FROM (to_jsonb(OLD)->'require_authentication'))
 THEN RAISE EXCEPTION 'Pause the survey before changing who can access existing links'; END IF;
 published:=NEW.survey_settings->>'current_version' IS DISTINCT FROM OLD.survey_settings->>'current_version'
 AND EXISTS(SELECT 1 FROM public.survey_version WHERE form_id=NEW.id AND tenant_id=NEW.tenant_id
 AND version_number=(NEW.survey_settings->>'current_version')::integer);
 IF current_setting('iconnect.survey_publishing',true)='on' AND state='draft' THEN state:='active'; END IF;
 NEW.survey_settings:=coalesce(NEW.survey_settings,'{}')||jsonb_build_object(
 'lifecycle_state',state,'status',CASE WHEN state='active' THEN 'published' WHEN state='archived' THEN 'archived' ELSE 'draft' END);
 IF current_setting('iconnect.survey_publishing',true)='on' THEN NEW.survey_settings:=NEW.survey_settings||'{"has_unpublished_changes":false}'::jsonb; END IF;
 NEW.is_active:=(state='active');
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS guard_survey_lifecycle_form ON public.form;
CREATE TRIGGER guard_survey_lifecycle_form BEFORE UPDATE OR DELETE ON public.form
FOR EACH ROW EXECUTE FUNCTION public.guard_survey_lifecycle_form();
CREATE OR REPLACE FUNCTION public.guard_survey_lifecycle_invitation()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE f public.form; a public.event_survey_assignment;
BEGIN
 SELECT * INTO a FROM public.event_survey_assignment WHERE id=NEW.assignment_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'Survey assignment unavailable'; END IF;
 SELECT * INTO f FROM public.form WHERE id=a.form_id AND tenant_id=a.tenant_id FOR UPDATE;
 IF NOT FOUND OR public.survey_effective_lifecycle(f)<>'active' THEN RAISE EXCEPTION 'Survey unavailable'; END IF;
 SELECT * INTO a FROM public.event_survey_assignment WHERE id=NEW.assignment_id FOR UPDATE;
 IF a.status<>'active' OR (a.closes_at IS NOT NULL AND now()>=a.closes_at) THEN
 RAISE EXCEPTION 'Survey assignment unavailable'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS guard_survey_lifecycle_invitation ON public.certificate_survey_entitlement;
CREATE TRIGGER guard_survey_lifecycle_invitation BEFORE INSERT ON public.certificate_survey_entitlement
FOR EACH ROW EXECUTE FUNCTION public.guard_survey_lifecycle_invitation();
REVOKE ALL ON FUNCTION public.guard_survey_lifecycle_form(),public.guard_survey_lifecycle_assignment(),
 public.guard_survey_lifecycle_submission(),public.guard_survey_lifecycle_invitation() FROM PUBLIC,anon,authenticated,service_role;
-- Keep the established immutable snapshot publisher, adding one common row
-- lock and explicit publication context. Republish-without-changes still works.
DO $$
BEGIN
 IF to_regprocedure('public.publish_survey_legacy(uuid,uuid,jsonb,jsonb,jsonb,jsonb,text)') IS NULL
 AND to_regprocedure('public.publish_survey(uuid,uuid,jsonb,jsonb,jsonb,jsonb,text)') IS NOT NULL THEN
 ALTER FUNCTION public.publish_survey(uuid,uuid,jsonb,jsonb,jsonb,jsonb,text) RENAME TO publish_survey_legacy;
 END IF;
 IF to_regprocedure('public.publish_survey_legacy(uuid,uuid,jsonb,jsonb,jsonb,jsonb,text)') IS NOT NULL THEN
 REVOKE ALL ON FUNCTION public.publish_survey_legacy(uuid,uuid,jsonb,jsonb,jsonb,jsonb,text) FROM PUBLIC,anon,authenticated,service_role;
 END IF;
END $$;
CREATE OR REPLACE FUNCTION public.publish_survey(
 p_tenant_id uuid,p_form_id uuid,p_fields jsonb,p_pages jsonb,p_visibility_rules jsonb,p_survey_settings jsonb,p_published_by text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE f public.form; result jsonb; previous text;
BEGIN
 SELECT * INTO f FROM public.form WHERE id=p_form_id AND tenant_id=p_tenant_id FOR UPDATE;
 IF NOT FOUND OR f.form_type<>'survey' THEN RAISE EXCEPTION 'Survey unavailable'; END IF;
 previous:=public.survey_effective_lifecycle(f);
 IF previous='archived' THEN RAISE EXCEPTION 'Restore the survey before publishing'; END IF;
 PERFORM set_config('iconnect.survey_publishing','on',true);
 result:=public.publish_survey_legacy(p_tenant_id,p_form_id,p_fields,p_pages,p_visibility_rules,
   (p_survey_settings-'lifecycle_state'-'has_unpublished_changes') ||
   CASE WHEN f.survey_settings ? 'lifecycle_state'
     THEN jsonb_build_object('lifecycle_state',f.survey_settings->>'lifecycle_state') ELSE '{}'::jsonb END,p_published_by);
 SELECT * INTO f FROM public.form WHERE id=p_form_id AND tenant_id=p_tenant_id;
 INSERT INTO public.survey_lifecycle_audit(tenant_id,form_id,actor,action,previous_state,new_state,impact,acknowledged)
 VALUES(p_tenant_id,p_form_id,coalesce(p_published_by,'unknown'),'publish',previous,
 public.survey_effective_lifecycle(f),jsonb_build_object('name',f.name,'version',f.survey_settings->'current_version'),false);
 PERFORM set_config('iconnect.survey_publishing','off',true);
 RETURN result||jsonb_build_object('survey_settings',f.survey_settings);
END $$;
REVOKE ALL ON FUNCTION public.publish_survey(uuid,uuid,jsonb,jsonb,jsonb,jsonb,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.publish_survey(uuid,uuid,jsonb,jsonb,jsonb,jsonb,text) TO service_role;
COMMIT;
