BEGIN;
ALTER TABLE public.member_lifecycle_record ADD COLUMN IF NOT EXISTS history_review jsonb;
ALTER TABLE public.member_lifecycle_record ADD COLUMN IF NOT EXISTS login_review jsonb;
CREATE OR REPLACE FUNCTION public.member_lifecycle_record_evidence(
  p_tenant_id uuid,p_member_id uuid,p_revision bigint,p_source text,p_evidence jsonb,p_actor text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE v_record public.member_lifecycle_record; v_before jsonb; v_today date:=CURRENT_DATE;
BEGIN
  IF p_source IS NULL OR p_source NOT IN ('membership','portal_login') OR p_tenant_id IS NULL OR p_member_id IS NULL
    OR p_revision IS NULL OR p_revision<0 OR p_actor IS NULL OR length(btrim(p_actor)) NOT BETWEEN 1 AND 200
    OR jsonb_typeof(p_evidence) IS DISTINCT FROM 'object'
    OR length(COALESCE(btrim(p_evidence->>'reference'),'')) NOT BETWEEN 1 AND 2000 THEN
    RAISE EXCEPTION 'Documented evidence is required' USING ERRCODE='22023';
  END IF;
  IF p_source='membership' AND (
    COALESCE(p_evidence->>'historyKind','') NOT IN ('former','never')
    OR COALESCE(p_evidence->>'fingerprint','') !~ '^[0-9a-f]{64}$'
    OR (p_evidence->>'historyKind'='former' AND (
      p_evidence->>'graceEndDate' IS NULL OR (p_evidence->>'graceEndDate')::date>v_today))) THEN
    RAISE EXCEPTION 'Invalid membership history evidence' USING ERRCODE='22023';
  END IF;
  IF p_source='portal_login' AND NULLIF(p_evidence->>'lastOccurredAt','') IS NOT NULL
    AND (p_evidence->>'lastOccurredAt')::date>v_today THEN
    RAISE EXCEPTION 'Login evidence cannot be in the future' USING ERRCODE='22023';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.member m LEFT JOIN public.organization o ON o.id=m.organization_id
    WHERE m.id=p_member_id AND COALESCE(m.tenant_id,o.tenant_id)=p_tenant_id) THEN
    RAISE EXCEPTION 'Member unavailable in this tenant' USING ERRCODE='22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('member-lifecycle-record:'||p_tenant_id||':'||p_member_id,0));
  INSERT INTO public.member_lifecycle_record(tenant_id,member_id) VALUES(p_tenant_id,p_member_id) ON CONFLICT DO NOTHING;
  SELECT * INTO v_record FROM public.member_lifecycle_record
    WHERE tenant_id=p_tenant_id AND member_id=p_member_id FOR UPDATE;
  IF NOT FOUND OR v_record.revision<>p_revision OR v_record.state='deleted' THEN
    RAISE EXCEPTION 'Member review changed; reload before deciding' USING ERRCODE='PT409';
  END IF;
  v_before:=to_jsonb(v_record)-'updated_at';
  -- Allowlisted provenance only; no browser-authored actor, timestamps or flags.
  p_evidence:=CASE WHEN p_source='membership' THEN jsonb_build_object(
    'historyKind',p_evidence->'historyKind','graceEndDate',p_evidence->'graceEndDate','fingerprint',p_evidence->'fingerprint')
    ELSE jsonb_build_object('lastOccurredAt',NULLIF(p_evidence->>'lastOccurredAt','')) END
    ||jsonb_build_object('reference',btrim(p_evidence->>'reference'),'reviewedAt',now(),'actor',p_actor);
  UPDATE public.member_lifecycle_record SET
    history_review=CASE WHEN p_source='membership' THEN p_evidence ELSE history_review END,
    login_review=CASE WHEN p_source='portal_login' THEN p_evidence ELSE login_review END,
    revision=revision+1,updated_at=now()
    WHERE tenant_id=p_tenant_id AND member_id=p_member_id RETURNING * INTO v_record;
  INSERT INTO public.member_lifecycle_record_audit(tenant_id,member_id,revision,action,reason,actor,before_state,after_state)
    VALUES(p_tenant_id,p_member_id,v_record.revision,'evidence:'||p_source,p_evidence->>'reference',p_actor,
      v_before,to_jsonb(v_record)-'updated_at');
  RETURN to_jsonb(v_record);
END $$;
REVOKE ALL ON FUNCTION public.member_lifecycle_record_evidence(uuid,uuid,bigint,text,jsonb,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.member_lifecycle_record_evidence(uuid,uuid,bigint,text,jsonb,text) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
