BEGIN;
ALTER TABLE public.member_lifecycle_record ADD COLUMN IF NOT EXISTS previous_state text;
ALTER TABLE public.member_lifecycle_record ADD COLUMN IF NOT EXISTS previous_role_id uuid;
ALTER TABLE public.member_lifecycle_record ADD COLUMN IF NOT EXISTS assigned_role_id uuid;
CREATE TABLE IF NOT EXISTS public.member_lifecycle_operation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  member_id uuid NOT NULL,
  record_revision bigint NOT NULL,
  action text NOT NULL CHECK(action IN ('former','guest','archive','restore','minimise','delete','deletion_review','evidence_review')),
  status text NOT NULL CHECK(status IN ('completed','blocked','needs_attention')),
  reason text NOT NULL,
  actor text NOT NULL,
  policy_revision bigint,
  notice_prepared boolean NOT NULL DEFAULT false,
  role_before uuid,
  role_after uuid,
  role_delivery text NOT NULL DEFAULT 'not_applicable' CHECK(role_delivery IN ('not_applicable','pending','completed','needs_review')),
  delivery_next_at timestamptz NOT NULL DEFAULT now(),
  delivery_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,member_id,record_revision,action)
);
CREATE INDEX IF NOT EXISTS member_lifecycle_operation_tenant ON public.member_lifecycle_operation(tenant_id,created_at DESC,id);
ALTER TABLE public.member_lifecycle_operation ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.member_lifecycle_operation FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.member_lifecycle_operation TO service_role;
DROP POLICY IF EXISTS lifecycle_operation_service ON public.member_lifecycle_operation;
CREATE POLICY lifecycle_operation_service ON public.member_lifecycle_operation FOR SELECT TO service_role USING(true);

DROP FUNCTION IF EXISTS public.member_lifecycle_transition(uuid,uuid,bigint,bigint,text,text,text,text,uuid,boolean);
CREATE OR REPLACE FUNCTION public.member_lifecycle_transition(
  p_tenant_id uuid,p_member_id uuid,p_revision bigint,p_policy_revision bigint,p_stamp text,
  p_action text,p_reason text,p_actor text,p_role_id uuid DEFAULT NULL,p_automatic boolean DEFAULT false,p_lease_token uuid DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE r public.member_lifecycle_record; m public.member; p public.member_lifecycle_policy;
  before_record jsonb; next_state text; op public.member_lifecycle_operation;
BEGIN
  IF p_tenant_id IS NULL OR p_member_id IS NULL OR p_revision IS NULL OR p_revision<0
    OR p_actor IS NULL OR length(btrim(p_actor)) NOT BETWEEN 1 AND 200
    OR p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 1 AND 2000
    OR p_action IS NULL OR p_action NOT IN ('former','guest','archive','restore','deletion_review','evidence_review')
    OR p_automatic IS NULL THEN RAISE EXCEPTION 'Invalid lifecycle transition' USING ERRCODE='22023'; END IF;
  PERFORM public.member_lifecycle_lock_sources(p_stamp);
  SELECT * INTO p FROM public.member_lifecycle_policy WHERE tenant_id=p_tenant_id FOR UPDATE;
  IF NOT FOUND OR p.revision<>p_policy_revision OR (p_automatic AND NOT p.enabled) THEN
    RAISE EXCEPTION 'Lifecycle policy changed or processing paused' USING ERRCODE='PT409';
  END IF;
  IF p_automatic AND NOT EXISTS(SELECT 1 FROM public.member_lifecycle_runtime
    WHERE tenant_id=p_tenant_id AND lease_token=p_lease_token AND lease_until>now()
      AND approved_revision=p_policy_revision FOR SHARE) THEN
    RAISE EXCEPTION 'Lifecycle run lease expired or was paused' USING ERRCODE='PT409';
  END IF;
  SELECT * INTO m FROM public.member WHERE id=p_member_id FOR UPDATE;
  IF NOT FOUND OR COALESCE(m.tenant_id,(SELECT tenant_id FROM public.organization WHERE id=m.organization_id))
    IS DISTINCT FROM p_tenant_id THEN RAISE EXCEPTION 'Member unavailable' USING ERRCODE='22023'; END IF;
  IF p_action NOT IN ('evidence_review','deletion_review')
    AND EXISTS(SELECT 1 FROM public.role WHERE id=m.role_id AND is_tenant_admin IS TRUE) THEN
    RAISE EXCEPTION 'Administrator role needs separate access review' USING ERRCODE='PT409';
  END IF;
  INSERT INTO public.member_lifecycle_record(tenant_id,member_id) VALUES(p_tenant_id,p_member_id) ON CONFLICT DO NOTHING;
  SELECT * INTO r FROM public.member_lifecycle_record WHERE tenant_id=p_tenant_id AND member_id=p_member_id FOR UPDATE;
  IF r.revision<>p_revision OR r.state='deleted'
    OR (r.state='minimised' AND p_action NOT IN ('evidence_review','deletion_review'))
    OR (p_action<>'restore' AND (r.hold OR r.exempt
      OR (r.review_after IS NOT NULL AND r.review_after>(now() AT TIME ZONE COALESCE(p.policy->>'timezone','UTC'))::date))) THEN
    RAISE EXCEPTION 'Member decision changed or is held' USING ERRCODE='PT409';
  END IF;
  before_record:=to_jsonb(r)-'updated_at';
  IF p_action IN ('former','guest') THEN
    IF p_role_id IS NULL OR p_role_id IS DISTINCT FROM (p.policy->>(p_action||'RoleId'))::uuid
      OR NOT EXISTS(SELECT 1 FROM public.role role WHERE role.id=p_role_id AND role.tenant_id=p_tenant_id
        AND COALESCE(to_jsonb(role)->>'is_active','true')='true' AND NOT COALESCE(role.is_tenant_admin,false)) THEN
      RAISE EXCEPTION 'Configured role is no longer available' USING ERRCODE='PT409';
    END IF;
    IF r.state='archived' THEN RAISE EXCEPTION 'Explicit restore required' USING ERRCODE='PT409'; END IF;
    next_state:=p_action;
    UPDATE public.member SET role_id=p_role_id WHERE id=p_member_id;
  ELSIF p_action='archive' THEN
    IF r.state='archived' THEN RAISE EXCEPTION 'Already archived' USING ERRCODE='PT409'; END IF;
    next_state:='archived';
  ELSIF p_action='restore' THEN
    IF p_automatic OR r.state<>'archived' THEN RAISE EXCEPTION 'Only intact archived records can be restored' USING ERRCODE='PT409'; END IF;
    next_state:=COALESCE(r.previous_state,'former');
    -- Restoration preserves current roles and purchased terms. It cannot grant
    -- a paid role merely because that role existed before archival.
  ELSE next_state:=r.state;
  END IF;
  UPDATE public.member_lifecycle_record SET state=next_state,revision=revision+1,updated_at=now(),
    previous_state=CASE WHEN p_action='archive' THEN r.state ELSE previous_state END,
    archived_at=CASE WHEN p_action='archive' THEN now() WHEN p_action='restore' THEN NULL ELSE archived_at END,
    previous_role_id=CASE WHEN p_action IN ('former','guest') THEN m.role_id ELSE previous_role_id END,
    assigned_role_id=CASE WHEN p_action IN ('former','guest') THEN p_role_id ELSE assigned_role_id END
    WHERE tenant_id=p_tenant_id AND member_id=p_member_id RETURNING * INTO r;
  INSERT INTO public.member_lifecycle_record_audit(tenant_id,member_id,revision,action,reason,actor,before_state,after_state)
    VALUES(p_tenant_id,p_member_id,r.revision,p_action,p_reason,p_actor,before_record,to_jsonb(r)-'updated_at');
  INSERT INTO public.member_lifecycle_operation(tenant_id,member_id,record_revision,action,status,reason,actor,
    policy_revision,role_before,role_after,role_delivery)
    VALUES(p_tenant_id,p_member_id,r.revision,p_action,'completed',p_reason,p_actor,
      p.revision,m.role_id,CASE WHEN p_action IN ('former','guest') THEN p_role_id ELSE m.role_id END,
      CASE WHEN p_action IN ('former','guest') AND m.role_id IS DISTINCT FROM p_role_id THEN 'pending' ELSE 'not_applicable' END)
    RETURNING * INTO op;
  RETURN jsonb_build_object('memberId',p_member_id,'revision',r.revision,'state',r.state,'operationId',op.id);
END $$;
REVOKE ALL ON FUNCTION public.member_lifecycle_transition(uuid,uuid,bigint,bigint,text,text,text,text,uuid,boolean,uuid)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.member_lifecycle_transition(uuid,uuid,bigint,bigint,text,text,text,text,uuid,boolean,uuid)
  TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
