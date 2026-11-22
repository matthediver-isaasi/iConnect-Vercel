BEGIN;
CREATE OR REPLACE FUNCTION public.member_lifecycle_guarded_annual_expiry(p_tenant_id uuid,p_action_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE a public.membership_expiry_action; m public.member;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('member-lifecycle-policy:'||p_tenant_id::text,0));
  SELECT * INTO a FROM public.membership_expiry_action WHERE id=p_action_id AND tenant_id=p_tenant_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Expiry journal unavailable' USING ERRCODE='22023'; END IF;
  IF a.history_type='member' AND EXISTS(SELECT 1 FROM public.member_lifecycle_runtime
      WHERE tenant_id=p_tenant_id AND approved_at IS NOT NULL) THEN
    RETURN jsonb_build_object('skipped',true,'reason','Lifecycle owns individual post-grace access');
  END IF;
  IF a.action_state='completed' THEN RETURN jsonb_build_object('completed',true); END IF;
  IF a.action_state<>'pending' THEN RAISE EXCEPTION 'Expiry journal needs review' USING ERRCODE='PT409'; END IF;
  SELECT * INTO m FROM public.member WHERE id=a.member_id AND tenant_id=p_tenant_id FOR UPDATE;
  IF NOT FOUND OR m.lifecycle_state IN ('archived','minimised','deleted')
    OR COALESCE(to_jsonb(m)->>'membership_paused','false')='true'
    OR EXISTS(SELECT 1 FROM public.role WHERE id=m.role_id AND is_tenant_admin IS TRUE) THEN
    RETURN jsonb_build_object('skipped',true,'reason','Protected member access');
  END IF;
  PERFORM public.apply_annual_expiry_role(p_tenant_id,p_action_id);
  IF a.login_disabled THEN
    UPDATE public.member SET login_enabled=false WHERE id=a.member_id AND tenant_id=p_tenant_id
      AND login_enabled IS NOT DISTINCT FROM a.previous_login_enabled;
    DELETE FROM public.session WHERE sess->>'memberId'=a.member_id::text
      AND (sess->>'tenantId' IS NULL OR sess->>'tenantId'=p_tenant_id::text)
      AND COALESCE(sess->>'userType','member')='member'
      AND NULLIF(sess->>'tenantUserId','') IS NULL
      AND COALESCE(sess->>'originalUserType','member')<>'tenant_user';
  END IF;
  UPDATE public.membership_expiry_action SET action_state='completed',completed_at=now()
    WHERE id=p_action_id AND tenant_id=p_tenant_id AND action_state='pending';
  RETURN jsonb_build_object('completed',true);
END $$;
REVOKE ALL ON FUNCTION public.member_lifecycle_guarded_annual_expiry(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.member_lifecycle_guarded_annual_expiry(uuid,uuid) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
