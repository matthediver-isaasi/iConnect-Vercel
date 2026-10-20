-- Additive. No backfill, provider calls or purchase changes. Review before apply.
BEGIN;
CREATE TABLE IF NOT EXISTS public.member_membership_amendment_settlement (
  id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  amendment_id uuid PRIMARY KEY REFERENCES public.member_membership_amendment(id),
  tenant_id uuid NOT NULL REFERENCES public.tenant(id),
  member_id uuid NOT NULL REFERENCES public.member(id),
  actor_id uuid NOT NULL,
  choice text NOT NULL CHECK (choice IN ('collect','credit','refund','none')),
  state text NOT NULL CHECK (state IN ('reserved','awaiting_payment','uncertain','settled','applied','conflict')),
  context jsonb NOT NULL,
  evidence jsonb NOT NULL DEFAULT '{}',
  error_code text,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.member_membership_amendment_event (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  amendment_id uuid NOT NULL REFERENCES public.member_membership_amendment(id),
  actor_id uuid NOT NULL,
  kind text NOT NULL,
  evidence jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.member_membership_amendment_application (
  id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  amendment_id uuid PRIMARY KEY REFERENCES public.member_membership_amendment(id),
  tenant_id uuid NOT NULL,
  member_id uuid NOT NULL,
  source_record_id uuid NOT NULL UNIQUE REFERENCES public.member_membership_history(id),
  effective_date date NOT NULL,
  expires_on date NOT NULL,
  snapshot jsonb NOT NULL,
  applied_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.member_membership_amendment_notification (
  id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  amendment_id uuid NOT NULL REFERENCES public.member_membership_amendment(id),
  tenant_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('settlement','settled','applied')),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','sending','sent','uncertain')),
  evidence jsonb NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(amendment_id,kind)
);
CREATE INDEX IF NOT EXISTS member_amendment_settlement_due
  ON public.member_membership_amendment_settlement(next_attempt_at,amendment_id)
  WHERE state IN ('reserved','awaiting_payment','uncertain','settled');

ALTER TABLE public.member_membership_amendment_settlement ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.member_membership_amendment_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.member_membership_amendment_application ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.member_membership_amendment_notification ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.member_membership_amendment_settlement, public.member_membership_amendment_event,
  public.member_membership_amendment_application, public.member_membership_amendment_notification
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.member_membership_amendment_settlement, public.member_membership_amendment_event,
  public.member_membership_amendment_application, public.member_membership_amendment_notification TO service_role;
DROP TRIGGER IF EXISTS member_amendment_event_immutable ON public.member_membership_amendment_event;
CREATE TRIGGER member_amendment_event_immutable BEFORE UPDATE OR DELETE
  ON public.member_membership_amendment_event FOR EACH ROW EXECUTE FUNCTION public.reject_member_amendment_mutation();
DROP TRIGGER IF EXISTS member_amendment_application_immutable ON public.member_membership_amendment_application;
CREATE TRIGGER member_amendment_application_immutable BEFORE UPDATE OR DELETE
  ON public.member_membership_amendment_application FOR EACH ROW EXECUTE FUNCTION public.reject_member_amendment_mutation();

-- Mirrors assessMemberAmendmentOperationalScope in the dependency-light reader.
-- Source is a typed history row converted to JSON, so its dates are valid ISO
-- dates. Never widen this predicate independently from operational readers.
CREATE OR REPLACE FUNCTION public.member_amendment_operational_scope_supported(p_source jsonb,p_target jsonb)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=public,pg_temp AS $$
  SELECT COALESCE(
    p_source->>'id' IS NOT NULL AND p_source->>'member_id' IS NOT NULL
    AND p_source->>'organization_id' IS NULL
    AND COALESCE(p_source->>'membership_source','') <> 'organisation'
    AND p_source->>'billing_agreement_id' IS NULL
    AND p_source->>'term_start_date' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
    AND p_source->>'membership_renewal_date' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
    AND p_source->>'term_anchor_date' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
    AND p_source->>'term_anchor_date' <= p_source->>'term_start_date'
    AND p_source->>'term_key' LIKE 'rolling:%'
    AND p_source->'term_duration_months' = '12'::jsonb
    AND p_source->'commitment_snapshot'->>'payment_frequency' = 'upfront'
    AND p_source->'commitment_snapshot'->>'billing_period' = 'annual'
    AND p_source->'commitment_snapshot'->>'start_mode' = 'immediate'
    AND p_source->'commitment_snapshot'->'config'->>'start_mode' = 'immediate'
    AND p_source->'commitment_snapshot'->'config'->>'billing_period' = 'annual'
    AND p_source->'commitment_snapshot'->'config'->>'structure_scope_type' = 'member'
    AND p_source->'commitment_snapshot'->'config'->>'tenant_id' = p_source->>'tenant_id'
    AND p_source->'commitment_snapshot'->'config'->>'id' = p_source->>'config_id'
    AND COALESCE(p_source->>'payment_method','') NOT IN
      ('direct_debit','gocardless','card_monthly','monthly_card','monthly_direct_debit')
    AND p_target->>'start_mode' = 'immediate'
    AND p_target->>'billing_period' = 'annual'
    AND p_target->>'structure_scope_type' = 'member'
    AND p_target->>'tenant_id' = p_source->>'tenant_id',
    false);
$$;
REVOKE ALL ON FUNCTION public.member_amendment_operational_scope_supported(jsonb,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.member_amendment_operational_scope_supported(jsonb,jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.reserve_member_amendment_settlement(
  p_tenant_id uuid,p_amendment_id uuid,p_actor_id uuid,p_choice text,p_context jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE a public.member_membership_amendment; s public.member_membership_amendment_settlement;
  source public.member_membership_history; m jsonb; today date := (now() AT TIME ZONE 'UTC')::date;
  target jsonb; band jsonb; vat jsonb;
BEGIN
  SELECT * INTO a FROM public.member_membership_amendment WHERE tenant_id=p_tenant_id AND id=p_amendment_id;
  IF NOT FOUND OR p_actor_id IS NULL THEN RAISE EXCEPTION 'Amendment not found' USING ERRCODE='40001'; END IF;
  IF NOT public.member_amendment_operational_scope_supported(a.quote->'sourceSnapshot',a.quote->'targetSnapshot'->'config') THEN
    RAISE EXCEPTION 'Unsupported operational amendment scope: only personal twelve-month upfront rolling immediate-to-immediate'
      USING ERRCODE='40001';
  END IF;
  SELECT to_jsonb(t) INTO m FROM public.member t WHERE tenant_id=p_tenant_id AND id=a.member_id FOR UPDATE;
  SELECT * INTO s FROM public.member_membership_amendment_settlement WHERE amendment_id=a.id FOR UPDATE;
  IF FOUND THEN
    IF s.choice IS DISTINCT FROM p_choice THEN RAISE EXCEPTION 'Settlement choice is already locked' USING ERRCODE='40001'; END IF;
    RETURN jsonb_build_object('settlement',to_jsonb(s),'claimed',false);
  END IF;
  SELECT * INTO source FROM public.member_membership_history WHERE id=a.source_record_id AND tenant_id=p_tenant_id FOR UPDATE;
  IF NOT public.member_amendment_operational_scope_supported(to_jsonb(source),a.quote->'targetSnapshot'->'config') THEN
    RAISE EXCEPTION 'Unsupported operational amendment scope: only personal twelve-month upfront rolling immediate-to-immediate'
      USING ERRCODE='40001';
  END IF;
  IF to_jsonb(source) IS DISTINCT FROM a.quote->'sourceSnapshot'
    OR source.status IS DISTINCT FROM 'active' OR source.payment_status IS DISTINCT FROM 'paid'
    OR source.membership_renewal_date <= today OR a.quote->>'effectiveDate' IS DISTINCT FROM today::text
    OR source.billing_agreement_id IS NOT NULL
    OR source.commitment_snapshot->>'payment_frequency' IS DISTINCT FROM 'upfront'
    OR COALESCE((m->>'membership_paused')::boolean,false)
    OR EXISTS (SELECT 1 FROM public.member_membership_amendment_application WHERE source_record_id=source.id)
    OR EXISTS (SELECT 1 FROM public.member_membership_history h WHERE h.tenant_id=p_tenant_id
      AND h.member_id=a.member_id AND h.id<>source.id AND h.status='active'
      AND (h.membership_renewal_date>today OR h.term_end_date>=today))
  THEN RAISE EXCEPTION 'Purchase, term, pause or successor changed; review required' USING ERRCODE='40001'; END IF;
  SELECT to_jsonb(t) INTO target FROM public.membership_tier_config t
    WHERE t.id=(a.request->>'configId')::uuid AND t.tenant_id=p_tenant_id FOR SHARE;
  SELECT to_jsonb(b) INTO band FROM public.membership_tier_band b
    WHERE b.id=(a.request->>'bandId')::uuid AND b.tenant_id=p_tenant_id FOR SHARE;
  SELECT to_jsonb(v) INTO vat FROM public.system_settings v
    WHERE v.tenant_id=p_tenant_id AND v.setting_key='xero_vat_rates_'||p_tenant_id::text FOR SHARE;
  IF target IS DISTINCT FROM a.quote->'targetSnapshot'->'config'
    OR COALESCE(band,'null'::jsonb) IS DISTINCT FROM a.quote->'targetSnapshot'->'band'
    OR COALESCE(vat,'null'::jsonb) IS DISTINCT FROM a.quote->'targetSnapshot'->'vatSetting'
    OR EXISTS(SELECT 1 FROM public.membership_tier_discount WHERE tenant_id=p_tenant_id AND config_id=(a.request->>'configId')::uuid)
    OR EXISTS(SELECT 1 FROM public.membership_tier_vat_override WHERE tenant_id=p_tenant_id AND config_id=(a.request->>'configId')::uuid)
  THEN RAISE EXCEPTION 'Target pricing or saved tax changed; review required' USING ERRCODE='40001'; END IF;
  IF NOT public.member_amendment_operational_scope_supported(to_jsonb(source),target) THEN
    RAISE EXCEPTION 'Unsupported operational target scope' USING ERRCODE='40001';
  END IF;
  IF NOT (p_choice='collect' AND (a.quote->'delta'->>'grossMinor')::bigint>0
       OR p_choice IN ('credit','refund') AND (a.quote->'delta'->>'grossMinor')::bigint<0
       OR p_choice='none' AND (a.quote->'delta'->>'netMinor')::bigint=0 AND (a.quote->'delta'->>'vatMinor')::bigint=0)
  THEN RAISE EXCEPTION 'Settlement direction mismatch' USING ERRCODE='22023'; END IF;
  INSERT INTO public.member_membership_amendment_settlement(amendment_id,tenant_id,member_id,actor_id,choice,state,context)
    VALUES(a.id,p_tenant_id,a.member_id,p_actor_id,p_choice,'reserved',p_context) RETURNING * INTO s;
  INSERT INTO public.member_membership_amendment_event(tenant_id,amendment_id,actor_id,kind,evidence)
    VALUES(p_tenant_id,a.id,p_actor_id,'settlement_reserved',jsonb_build_object('choice',p_choice));
  RETURN jsonb_build_object('settlement',to_jsonb(s),'claimed',true);
END; $$;

CREATE OR REPLACE FUNCTION public.finish_member_amendment_settlement(
  p_tenant_id uuid,p_amendment_id uuid,p_actor_id uuid,p_state text,p_evidence jsonb,p_error_code text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE s public.member_membership_amendment_settlement;
BEGIN
  SELECT * INTO s FROM public.member_membership_amendment_settlement
    WHERE tenant_id=p_tenant_id AND amendment_id=p_amendment_id FOR UPDATE;
  IF NOT FOUND OR p_actor_id IS NULL THEN RAISE EXCEPTION 'Settlement not found' USING ERRCODE='40001'; END IF;
  IF s.state IN ('applied','conflict') THEN RETURN to_jsonb(s); END IF;
  IF p_state NOT IN ('awaiting_payment','uncertain','settled','conflict')
    OR (s.state='settled' AND p_state NOT IN ('settled','uncertain','conflict')) THEN
    RAISE EXCEPTION 'Invalid settlement transition' USING ERRCODE='40001';
  END IF;
  UPDATE public.member_membership_amendment_settlement SET state=p_state,evidence=p_evidence,
    error_code=p_error_code,updated_at=now(),next_attempt_at=now()+interval '10 minutes'
    WHERE amendment_id=s.amendment_id RETURNING * INTO s;
  INSERT INTO public.member_membership_amendment_event(tenant_id,amendment_id,actor_id,kind,evidence)
    VALUES(p_tenant_id,p_amendment_id,p_actor_id,p_state,p_evidence);
  IF p_state IN ('awaiting_payment','settled') THEN
    INSERT INTO public.member_membership_amendment_notification(amendment_id,tenant_id,kind)
      VALUES(p_amendment_id,p_tenant_id,CASE WHEN p_state='settled' THEN 'settled' ELSE 'settlement' END) ON CONFLICT DO NOTHING;
  END IF;
  RETURN to_jsonb(s);
END; $$;

CREATE OR REPLACE FUNCTION public.apply_member_membership_amendment(
  p_tenant_id uuid,p_amendment_id uuid,p_actor_id uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE a public.member_membership_amendment; s public.member_membership_amendment_settlement;
  source public.member_membership_history; m jsonb; result public.member_membership_amendment_application;
  today date := (now() AT TIME ZONE 'UTC')::date;
  target jsonb;
BEGIN
  SELECT * INTO a FROM public.member_membership_amendment WHERE tenant_id=p_tenant_id AND id=p_amendment_id;
  IF NOT FOUND OR p_actor_id IS NULL THEN RAISE EXCEPTION 'Amendment not found' USING ERRCODE='40001'; END IF;
  IF NOT public.member_amendment_operational_scope_supported(a.quote->'sourceSnapshot',a.quote->'targetSnapshot'->'config') THEN
    RAISE EXCEPTION 'Unsupported operational amendment scope: only personal twelve-month upfront rolling immediate-to-immediate'
      USING ERRCODE='40001';
  END IF;
  SELECT to_jsonb(t) INTO m FROM public.member t WHERE tenant_id=p_tenant_id AND id=a.member_id FOR UPDATE;
  SELECT * INTO s FROM public.member_membership_amendment_settlement WHERE amendment_id=a.id FOR UPDATE;
  SELECT * INTO result FROM public.member_membership_amendment_application WHERE amendment_id=a.id;
  IF FOUND THEN RETURN to_jsonb(result); END IF;
  IF s.state IS DISTINCT FROM 'settled' THEN RAISE EXCEPTION 'Verified settlement is required' USING ERRCODE='40001'; END IF;
  SELECT * INTO source FROM public.member_membership_history WHERE id=a.source_record_id AND tenant_id=p_tenant_id FOR UPDATE;
  SELECT to_jsonb(t) INTO target FROM public.membership_tier_config t
    WHERE t.id=(a.request->>'configId')::uuid AND t.tenant_id=p_tenant_id FOR SHARE;
  IF NOT public.member_amendment_operational_scope_supported(to_jsonb(source),a.quote->'targetSnapshot'->'config')
    OR NOT public.member_amendment_operational_scope_supported(to_jsonb(source),target)
    OR to_jsonb(source) IS DISTINCT FROM a.quote->'sourceSnapshot' OR source.status IS DISTINCT FROM 'active'
    OR source.payment_status IS DISTINCT FROM 'paid' OR source.membership_renewal_date<=today
    OR COALESCE((m->>'membership_paused')::boolean,false)
    OR EXISTS (SELECT 1 FROM public.member_membership_history h WHERE h.tenant_id=p_tenant_id
      AND h.member_id=a.member_id AND h.id<>source.id AND h.status='active'
      AND (h.membership_renewal_date>today OR h.term_end_date>=today))
  THEN
    UPDATE public.member_membership_amendment_settlement SET state='conflict',error_code='late_settlement_conflict',updated_at=now()
      WHERE amendment_id=a.id;
    INSERT INTO public.member_membership_amendment_event(tenant_id,amendment_id,actor_id,kind)
      VALUES(p_tenant_id,a.id,p_actor_id,'late_settlement_conflict');
    RETURN jsonb_build_object('conflict',true,'code','late_settlement_conflict');
  END IF;
  INSERT INTO public.member_membership_amendment_application
    (amendment_id,tenant_id,member_id,source_record_id,effective_date,expires_on,snapshot,applied_by)
    VALUES(a.id,p_tenant_id,a.member_id,a.source_record_id,(a.quote->>'effectiveDate')::date,
      source.membership_renewal_date,a.quote,p_actor_id) RETURNING * INTO result;
  UPDATE public.member_membership_amendment_settlement SET state='applied',updated_at=now() WHERE amendment_id=a.id;
  INSERT INTO public.member_membership_amendment_event(tenant_id,amendment_id,actor_id,kind,evidence)
    VALUES(p_tenant_id,a.id,p_actor_id,'applied',to_jsonb(result));
  INSERT INTO public.member_membership_amendment_notification(amendment_id,tenant_id,kind)
    VALUES(a.id,p_tenant_id,'applied') ON CONFLICT DO NOTHING;
  RETURN to_jsonb(result);
END; $$;

CREATE OR REPLACE FUNCTION public.claim_member_amendment_notification(p_tenant_id uuid,p_amendment_id uuid,p_kind text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE n public.member_membership_amendment_notification;
BEGIN
  UPDATE public.member_membership_amendment_notification SET state='sending',updated_at=now()
    WHERE tenant_id=p_tenant_id AND amendment_id=p_amendment_id AND kind=p_kind AND state='pending'
    RETURNING * INTO n;
  RETURN CASE WHEN FOUND THEN to_jsonb(n) ELSE NULL END;
END; $$;
CREATE OR REPLACE FUNCTION public.finish_member_amendment_notification(
  p_tenant_id uuid,p_amendment_id uuid,p_kind text,p_state text,p_evidence jsonb
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF p_state NOT IN ('sent','uncertain','pending') THEN RAISE EXCEPTION 'Invalid notification outcome'; END IF;
  UPDATE public.member_membership_amendment_notification SET state=p_state,evidence=p_evidence,updated_at=now()
    WHERE tenant_id=p_tenant_id AND amendment_id=p_amendment_id AND kind=p_kind AND state='sending';
END; $$;
CREATE OR REPLACE FUNCTION public.recover_stale_member_amendment_notifications()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE affected integer;
BEGIN
  -- A worker could have died after Mailgun accepted the message. Never resend
  -- these automatically: make ambiguity explicit for finance investigation.
  UPDATE public.member_membership_amendment_notification
    SET state='uncertain',evidence=evidence||'{"reason":"delivery_worker_interrupted"}'::jsonb,updated_at=now()
    WHERE state='sending' AND updated_at<now()-interval '15 minutes';
  GET DIAGNOSTICS affected=ROW_COUNT;
  RETURN affected;
END; $$;
REVOKE ALL ON FUNCTION public.reserve_member_amendment_settlement(uuid,uuid,uuid,text,jsonb),
  public.finish_member_amendment_settlement(uuid,uuid,uuid,text,jsonb,text),
  public.apply_member_membership_amendment(uuid,uuid,uuid),
  public.claim_member_amendment_notification(uuid,uuid,text),
  public.finish_member_amendment_notification(uuid,uuid,text,text,jsonb),
  public.recover_stale_member_amendment_notifications()
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_member_amendment_settlement(uuid,uuid,uuid,text,jsonb),
  public.finish_member_amendment_settlement(uuid,uuid,uuid,text,jsonb,text),
  public.apply_member_membership_amendment(uuid,uuid,uuid),
  public.claim_member_amendment_notification(uuid,uuid,text),
  public.finish_member_amendment_notification(uuid,uuid,text,text,jsonb),
  public.recover_stale_member_amendment_notifications() TO service_role;
COMMIT;
