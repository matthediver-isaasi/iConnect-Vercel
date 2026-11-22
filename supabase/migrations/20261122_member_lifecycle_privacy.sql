BEGIN;
ALTER TABLE public.member_lifecycle_record ADD COLUMN IF NOT EXISTS financial_refs jsonb;
CREATE TABLE IF NOT EXISTS public.member_lifecycle_impact(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,member_id uuid NOT NULL,
  record_revision bigint NOT NULL,policy_revision bigint NOT NULL,source_stamp text NOT NULL,
  action text NOT NULL CHECK(action IN ('minimise','delete')),actor text NOT NULL,reason text NOT NULL,
  plan jsonb NOT NULL,financial_refs jsonb NOT NULL,expires_at timestamptz NOT NULL DEFAULT now()+interval '15 minutes',
  consumed_at timestamptz,result jsonb
);
CREATE TABLE IF NOT EXISTS public.member_lifecycle_cleanup(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,member_id uuid NOT NULL,
  operation_id uuid NOT NULL REFERENCES public.member_lifecycle_operation(id),kind text NOT NULL,
  resource_reference text NOT NULL,state text NOT NULL DEFAULT 'needs_review' CHECK(state IN ('needs_review','completed')),
  reason text NOT NULL DEFAULT 'Verify ownership and separate retention before removing stored media',
  created_at timestamptz NOT NULL DEFAULT now(),resolved_at timestamptz,resolved_by text,
  UNIQUE(operation_id,kind)
);
ALTER TABLE public.member_lifecycle_impact ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.member_lifecycle_cleanup ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.member_lifecycle_impact,public.member_lifecycle_cleanup FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.member_lifecycle_impact,public.member_lifecycle_cleanup TO service_role;
DROP POLICY IF EXISTS lifecycle_impact_service ON public.member_lifecycle_impact;
CREATE POLICY lifecycle_impact_service ON public.member_lifecycle_impact FOR SELECT TO service_role USING(true);
DROP POLICY IF EXISTS lifecycle_cleanup_service ON public.member_lifecycle_cleanup;
CREATE POLICY lifecycle_cleanup_service ON public.member_lifecycle_cleanup FOR SELECT TO service_role USING(true);

CREATE OR REPLACE FUNCTION public.member_lifecycle_privacy_fields(p_tenant_id uuid,p_member_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE m jsonb; fields jsonb;
BEGIN
  SELECT to_jsonb(member) INTO m FROM public.member member LEFT JOIN public.organization org ON org.id=member.organization_id
    WHERE member.id=p_member_id AND COALESCE(member.tenant_id,org.tenant_id)=p_tenant_id;
  IF m IS NULL THEN RAISE EXCEPTION 'Member unavailable' USING ERRCODE='22023'; END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'name',column_name,'hasValue',m->column_name IS NOT NULL AND m->column_name<>'null'::jsonb
      AND m->column_name<>'""'::jsonb AND m->column_name<>'[]'::jsonb AND m->column_name<>'{}'::jsonb,
    'canRemove',is_nullable='YES' OR data_type IN ('text','character varying','json','jsonb','boolean','integer','bigint','numeric')
  ) ORDER BY ordinal_position),'[]') INTO fields
    FROM information_schema.columns WHERE table_schema='public' AND table_name='member' AND is_generated='NEVER';
  RETURN fields || COALESCE((
    SELECT jsonb_agg(jsonb_build_object('name','custom:'||v.field_id::text,'hasValue',true,'canRemove',f.id IS NOT NULL,
      'label',COALESCE(to_jsonb(f)->>'label',to_jsonb(f)->>'name','Unresolved custom field')))
      FROM public.member_preference_value v LEFT JOIN public.preference_field f ON f.id=v.field_id AND f.tenant_id=p_tenant_id
      WHERE v.member_id=p_member_id
  ),'[]');
END $$;
CREATE OR REPLACE FUNCTION public.member_lifecycle_save_impact(
  p_tenant_id uuid,p_member_id uuid,p_revision bigint,p_policy_revision bigint,p_stamp text,
  p_action text,p_actor text,p_reason text,p_plan jsonb,p_financial_refs jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE impact public.member_lifecycle_impact;
BEGIN
  PERFORM public.member_lifecycle_lock_sources(p_stamp);
  IF p_action IS NULL OR p_action NOT IN ('minimise','delete') OR p_actor IS NULL OR length(btrim(p_actor)) NOT BETWEEN 1 AND 200
    OR p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 1 AND 2000
    OR jsonb_typeof(p_plan->'fieldsRemoved') IS DISTINCT FROM 'array'
    OR jsonb_typeof(p_plan->'blockers') IS DISTINCT FROM 'array' OR jsonb_array_length(p_plan->'blockers')<>0
    OR jsonb_typeof(p_financial_refs) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'Complete documented impact required' USING ERRCODE='22023';
  END IF;
  INSERT INTO public.member_lifecycle_record(tenant_id,member_id)
    SELECT p_tenant_id,m.id FROM public.member m LEFT JOIN public.organization o ON o.id=m.organization_id
      WHERE m.id=p_member_id AND COALESCE(m.tenant_id,o.tenant_id)=p_tenant_id ON CONFLICT DO NOTHING;
  IF NOT EXISTS(SELECT 1 FROM public.member_lifecycle_record WHERE tenant_id=p_tenant_id AND member_id=p_member_id
      AND revision=p_revision AND NOT hold AND NOT exempt)
    OR NOT EXISTS(SELECT 1 FROM public.member_lifecycle_policy WHERE tenant_id=p_tenant_id AND revision=p_policy_revision) THEN
    RAISE EXCEPTION 'Member or policy changed' USING ERRCODE='PT409';
  END IF;
  INSERT INTO public.member_lifecycle_impact(tenant_id,member_id,record_revision,policy_revision,source_stamp,action,actor,reason,plan,financial_refs)
    VALUES(p_tenant_id,p_member_id,p_revision,p_policy_revision,public.member_lifecycle_source_stamp(),p_action,p_actor,p_reason,p_plan,p_financial_refs)
    RETURNING * INTO impact;
  RETURN jsonb_build_object('impactToken',impact.id,'expiresAt',impact.expires_at);
END $$;
CREATE OR REPLACE FUNCTION public.member_lifecycle_apply_impact(
  p_tenant_id uuid,p_member_id uuid,p_token uuid,p_actor text,p_action text,p_confirmation text,p_reason text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE impact public.member_lifecycle_impact; r public.member_lifecycle_record; m jsonb; before_record jsonb;
  field text; column_info record; value_sql text; op uuid; outstanding integer;
BEGIN
  SELECT * INTO impact FROM public.member_lifecycle_impact WHERE id=p_token AND tenant_id=p_tenant_id
    AND member_id=p_member_id AND actor=p_actor AND action=p_action FOR UPDATE;
  IF NOT FOUND OR p_confirmation IS DISTINCT FROM upper(p_action) OR p_reason IS DISTINCT FROM impact.reason THEN
    RAISE EXCEPTION 'Explicit matching confirmation required' USING ERRCODE='22023';
  END IF;
  IF impact.consumed_at IS NOT NULL THEN RETURN impact.result; END IF;
  IF impact.expires_at<=now() THEN RAISE EXCEPTION 'Impact preview expired' USING ERRCODE='PT409'; END IF;
  PERFORM public.member_lifecycle_lock_sources(impact.source_stamp);
  SELECT * INTO r FROM public.member_lifecycle_record WHERE tenant_id=p_tenant_id AND member_id=p_member_id FOR UPDATE;
  IF NOT FOUND OR r.revision<>impact.record_revision OR r.hold OR r.exempt OR r.state='deleted'
    OR (p_action='minimise' AND r.state<>'archived') OR NOT EXISTS(
      SELECT 1 FROM public.member_lifecycle_policy WHERE tenant_id=p_tenant_id AND revision=impact.policy_revision
        AND (r.review_after IS NULL OR r.review_after<=(now() AT TIME ZONE COALESCE(policy->>'timezone','UTC'))::date)
    ) THEN RAISE EXCEPTION 'Member or policy changed; generate a new impact' USING ERRCODE='PT409'; END IF;
  SELECT to_jsonb(member) INTO m FROM public.member member WHERE id=p_member_id FOR UPDATE;
  IF m IS NULL THEN RAISE EXCEPTION 'Member unavailable' USING ERRCODE='PT409'; END IF;
  before_record:=to_jsonb(r)-'updated_at';
  UPDATE public.member SET tenant_id=p_tenant_id WHERE id=p_member_id;
  FOR field IN SELECT jsonb_array_elements_text(impact.plan->'fieldsRemoved') LOOP
    IF field=ANY(ARRAY['id','tenant_id','lifecycle_state','lifecycle_generation','created_at','updated_at','created_date','updated_date','created_on','updated_on',
      'role_id','role_effective_from','membership_paused','membership_cancelled','membership_paused_at','membership_cancelled_at',
      'login_enabled','show_in_directory','is_guest','guest_expires_at']) THEN
      RAISE EXCEPTION 'Protected field in impact' USING ERRCODE='22023';
    END IF;
    IF field LIKE 'custom:%' THEN
      DELETE FROM public.member_preference_value WHERE member_id=p_member_id AND field_id=substring(field FROM 8)::uuid;
      CONTINUE;
    END IF;
    SELECT * INTO column_info FROM information_schema.columns
      WHERE table_schema='public' AND table_name='member' AND column_name=field AND is_generated='NEVER';
    IF NOT FOUND THEN RAISE EXCEPTION 'Field schema changed' USING ERRCODE='PT409'; END IF;
    value_sql:=CASE WHEN field='email' THEN quote_literal('deleted_'||p_member_id||'@deleted.local')
      WHEN column_info.is_nullable='YES' THEN 'NULL'
      WHEN column_info.data_type IN ('text','character varying') THEN quote_literal('')
      WHEN column_info.data_type IN ('json','jsonb') THEN quote_literal('{}')
      WHEN column_info.data_type='boolean' THEN 'false'
      WHEN column_info.data_type IN ('integer','bigint','numeric') THEN '0'
      ELSE NULL END;
    IF value_sql IS NULL THEN RAISE EXCEPTION 'Field cannot be erased safely' USING ERRCODE='PT409'; END IF;
    EXECUTE format('UPDATE public.member SET %I=%s WHERE id=$1',field,value_sql) USING p_member_id;
  END LOOP;
  UPDATE public.member SET show_in_directory=false WHERE id=p_member_id;
  -- Only the member link is cleared. Separate identity, tenant-user and team
  -- credentials are deliberately not deleted or deactivated.
  UPDATE public.tenant_membership SET member_id=NULL WHERE member_id=p_member_id AND tenant_id=p_tenant_id;
  UPDATE public.member_lifecycle_record SET state=CASE WHEN p_action='delete' THEN 'deleted' ELSE 'minimised' END,
    financial_refs=impact.financial_refs,revision=revision+1,updated_at=now()
    WHERE tenant_id=p_tenant_id AND member_id=p_member_id RETURNING * INTO r;
  INSERT INTO public.member_lifecycle_record_audit(tenant_id,member_id,revision,action,reason,actor,before_state,after_state)
    VALUES(p_tenant_id,p_member_id,r.revision,p_action,p_reason,p_actor,before_record,to_jsonb(r)-'updated_at');
  INSERT INTO public.member_lifecycle_operation(tenant_id,member_id,record_revision,action,status,reason,actor)
    VALUES(p_tenant_id,p_member_id,r.revision,p_action,'completed',p_reason,p_actor) RETURNING id INTO op;
  IF (impact.plan->'fieldsRemoved') ? 'profile_photo_url' AND NULLIF(m->>'profile_photo_url','') IS NOT NULL THEN
    INSERT INTO public.member_lifecycle_cleanup(tenant_id,member_id,operation_id,kind,resource_reference)
      VALUES(p_tenant_id,p_member_id,op,'profile_media',m->>'profile_photo_url');
  END IF;
  SELECT count(*) INTO outstanding FROM public.member_lifecycle_cleanup WHERE operation_id=op AND state<>'completed';
  IF outstanding>0 THEN UPDATE public.member_lifecycle_operation SET status='needs_attention' WHERE id=op; END IF;
  impact.result:=jsonb_build_object('memberId',p_member_id,'revision',r.revision,'state',r.state,'operationId',op,
    'cleanupPending',outstanding,'scope','Member profile removed; protected history and separate accounts retained');
  UPDATE public.member_lifecycle_impact SET consumed_at=now(),result=impact.result WHERE id=impact.id;
  RETURN impact.result;
END $$;
CREATE OR REPLACE FUNCTION public.member_lifecycle_resolve_cleanup(
  p_tenant_id uuid,p_id uuid,p_actor text,p_reason text,p_confirmation text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE cleanup public.member_lifecycle_cleanup;
BEGIN
  IF p_confirmation IS DISTINCT FROM 'VERIFIED REMOVED' OR p_actor IS NULL OR length(btrim(p_actor)) NOT BETWEEN 1 AND 200
    OR p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 1 AND 2000 THEN
    RAISE EXCEPTION 'Independent storage verification and reason required' USING ERRCODE='22023';
  END IF;
  SELECT * INTO cleanup FROM public.member_lifecycle_cleanup WHERE id=p_id AND tenant_id=p_tenant_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Cleanup record unavailable' USING ERRCODE='22023'; END IF;
  IF cleanup.state='completed' THEN RETURN jsonb_build_object('cleanupId',p_id,'state','completed'); END IF;
  UPDATE public.member_lifecycle_cleanup SET state='completed',resource_reference='',reason=p_reason,
    resolved_at=now(),resolved_by=p_actor WHERE id=p_id;
  IF NOT EXISTS(SELECT 1 FROM public.member_lifecycle_cleanup WHERE operation_id=cleanup.operation_id AND state<>'completed') THEN
    UPDATE public.member_lifecycle_operation SET status='completed' WHERE id=cleanup.operation_id;
  END IF;
  RETURN jsonb_build_object('cleanupId',p_id,'state','completed');
END $$;
REVOKE ALL ON FUNCTION public.member_lifecycle_privacy_fields(uuid,uuid),
  public.member_lifecycle_save_impact(uuid,uuid,bigint,bigint,text,text,text,text,jsonb,jsonb),
  public.member_lifecycle_apply_impact(uuid,uuid,uuid,text,text,text,text),
  public.member_lifecycle_resolve_cleanup(uuid,uuid,text,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.member_lifecycle_privacy_fields(uuid,uuid),
  public.member_lifecycle_save_impact(uuid,uuid,bigint,bigint,text,text,text,text,jsonb,jsonb),
  public.member_lifecycle_apply_impact(uuid,uuid,uuid,text,text,text,text),
  public.member_lifecycle_resolve_cleanup(uuid,uuid,text,text,text) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
