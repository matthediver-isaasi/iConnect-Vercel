BEGIN;
CREATE TABLE IF NOT EXISTS public.member_lifecycle_notice(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL,member_id uuid NOT NULL,
  notice_key text NOT NULL,recipient text NOT NULL,kind text NOT NULL,reason text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sending','sent','cancelled','needs_review')),
  attempts integer NOT NULL DEFAULT 0,lease_token uuid,lease_until timestamptz,
  next_at timestamptz NOT NULL DEFAULT now(),created_at timestamptz NOT NULL DEFAULT now(),sent_at timestamptz,
  outcome_code text,UNIQUE(tenant_id,notice_key,recipient)
);
ALTER TABLE public.member_lifecycle_notice ADD COLUMN IF NOT EXISTS reviewed_by text;
ALTER TABLE public.member_lifecycle_notice ADD COLUMN IF NOT EXISTS reviewed_at timestamptz;
ALTER TABLE public.member_lifecycle_notice ADD COLUMN IF NOT EXISTS review_reason text;
ALTER TABLE public.member_lifecycle_notice ADD COLUMN IF NOT EXISTS policy_revision bigint;
ALTER TABLE public.member_lifecycle_notice ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.member_lifecycle_notice FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.member_lifecycle_notice TO service_role;
DROP POLICY IF EXISTS lifecycle_notice_service ON public.member_lifecycle_notice;
CREATE POLICY lifecycle_notice_service ON public.member_lifecycle_notice FOR SELECT TO service_role USING(true);
CREATE OR REPLACE FUNCTION public.member_lifecycle_enqueue_notice(
  p_tenant_id uuid,p_member_id uuid,p_key text,p_recipient text,p_kind text,p_reason text,p_revision bigint
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF p_revision IS NULL OR p_revision<1 OR p_key IS NULL OR p_key!~'^[0-9a-f]{64}$' OR p_recipient!~'^(member|tenant_user):[0-9a-f-]{36}$'
    OR p_kind NOT IN ('approaching','review','archived') OR length(p_reason)>2000 THEN
    RAISE EXCEPTION 'Invalid lifecycle notification' USING ERRCODE='22023';
  END IF;
  INSERT INTO public.member_lifecycle_notice(tenant_id,member_id,notice_key,recipient,kind,reason,policy_revision)
    VALUES(p_tenant_id,p_member_id,p_key,p_recipient,p_kind,p_reason,p_revision) ON CONFLICT DO NOTHING;
END $$;
CREATE OR REPLACE FUNCTION public.member_lifecycle_operation_delivery(
  p_id uuid,p_tenant_id uuid,p_kind text,p_state text
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF p_kind='notice' AND p_state='prepared' THEN
    UPDATE public.member_lifecycle_operation SET notice_prepared=true WHERE id=p_id AND tenant_id=p_tenant_id;
  ELSIF p_kind='role' AND p_state IN ('pending','completed','needs_review') THEN
    UPDATE public.member_lifecycle_operation SET role_delivery=p_state
      WHERE id=p_id AND tenant_id=p_tenant_id AND role_delivery IN ('pending','needs_review');
  ELSIF p_kind='outbox' AND p_state IN ('retry','complete') THEN
    UPDATE public.member_lifecycle_operation SET
      delivery_next_at=now()+CASE WHEN p_state='retry' THEN interval '15 minutes' ELSE interval '0' END,
      delivery_error=CASE WHEN p_state='retry' THEN 'Delivery requires retry or reviewer configuration' ELSE NULL END
      WHERE id=p_id AND tenant_id=p_tenant_id;
  ELSE RAISE EXCEPTION 'Invalid operation delivery outcome'; END IF;
END $$;
CREATE OR REPLACE FUNCTION public.member_lifecycle_resolve_notice(
  p_tenant_id uuid,p_id uuid,p_actor text,p_resolution text,p_reason text,p_confirmation text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE n public.member_lifecycle_notice;
BEGIN
  IF p_resolution IS NULL OR p_resolution NOT IN ('sent','retry')
    OR p_confirmation IS DISTINCT FROM (CASE WHEN p_resolution='sent' THEN 'VERIFIED DELIVERY' ELSE 'VERIFIED NOT SENT' END)
    OR p_actor IS NULL OR length(btrim(p_actor)) NOT BETWEEN 1 AND 200
    OR p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 1 AND 2000 THEN
    RAISE EXCEPTION 'Verified provider outcome and documented reason required' USING ERRCODE='22023';
  END IF;
  SELECT * INTO n FROM public.member_lifecycle_notice WHERE tenant_id=p_tenant_id AND id=p_id FOR UPDATE;
  IF NOT FOUND OR n.status<>'needs_review' THEN RAISE EXCEPTION 'Notification changed; refresh before deciding' USING ERRCODE='PT409'; END IF;
  UPDATE public.member_lifecycle_notice SET status=CASE WHEN p_resolution='sent' THEN 'sent' ELSE 'pending' END,
    next_at=now(),outcome_code=CASE WHEN p_resolution='sent' THEN 'administrator_verified_delivery' ELSE 'administrator_verified_not_sent' END,
    reviewed_by=p_actor,reviewed_at=now(),review_reason=p_reason,lease_token=NULL,lease_until=NULL WHERE id=p_id;
  RETURN jsonb_build_object('noticeId',p_id,'status',CASE WHEN p_resolution='sent' THEN 'sent' ELSE 'pending' END);
END $$;
CREATE OR REPLACE FUNCTION public.member_lifecycle_claim_notice(p_token uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE n public.member_lifecycle_notice;
BEGIN
  -- An expired send lease is ambiguous, not proof that the provider rejected it.
  UPDATE public.member_lifecycle_notice SET status='needs_review',outcome_code='interrupted_send_requires_reconciliation',
    lease_token=NULL,lease_until=NULL WHERE status='sending' AND lease_until<=now();
  SELECT * INTO n FROM public.member_lifecycle_notice WHERE status='pending' AND next_at<=now()
    ORDER BY next_at,id FOR UPDATE SKIP LOCKED LIMIT 1;
  IF NOT FOUND THEN RETURN NULL; END IF;
  UPDATE public.member_lifecycle_notice SET status='sending',attempts=attempts+1,lease_token=p_token,
    lease_until=now()+interval '2 minutes' WHERE id=n.id RETURNING * INTO n;
  RETURN to_jsonb(n);
END $$;
CREATE OR REPLACE FUNCTION public.member_lifecycle_finish_notice(
  p_id uuid,p_token uuid,p_status text,p_outcome text
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF p_status IS NULL OR p_status NOT IN ('sent','pending','cancelled','needs_review') THEN RAISE EXCEPTION 'Invalid delivery outcome'; END IF;
  UPDATE public.member_lifecycle_notice SET status=CASE WHEN p_status='pending' AND attempts>=5 THEN 'needs_review' ELSE p_status END,
    sent_at=CASE WHEN p_status='sent' THEN now() ELSE sent_at END,outcome_code=left(p_outcome,200),
    next_at=now()+interval '15 minutes',lease_token=NULL,lease_until=NULL
    WHERE id=p_id AND lease_token=p_token AND status='sending' AND lease_until>now();
  IF NOT FOUND THEN RAISE EXCEPTION 'Notification lease expired' USING ERRCODE='PT409'; END IF;
END $$;
REVOKE ALL ON FUNCTION public.member_lifecycle_enqueue_notice(uuid,uuid,text,text,text,text,bigint),
  public.member_lifecycle_claim_notice(uuid),public.member_lifecycle_finish_notice(uuid,uuid,text,text),
  public.member_lifecycle_operation_delivery(uuid,uuid,text,text),
  public.member_lifecycle_resolve_notice(uuid,uuid,text,text,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.member_lifecycle_enqueue_notice(uuid,uuid,text,text,text,text,bigint),
  public.member_lifecycle_claim_notice(uuid),public.member_lifecycle_finish_notice(uuid,uuid,text,text),
  public.member_lifecycle_operation_delivery(uuid,uuid,text,text),
  public.member_lifecycle_resolve_notice(uuid,uuid,text,text,text,text) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
