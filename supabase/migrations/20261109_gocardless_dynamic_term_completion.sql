-- Additive follow-up to the already-applied collection-policy migrations.
-- Settlement is financial evidence, not subscription expiry or a quoted total.
ALTER TABLE public.membership_payment_plans
  ADD COLUMN IF NOT EXISTS dynamic_completion_next_check_at timestamptz,
  ADD COLUMN IF NOT EXISTS dynamic_completion_error text;

CREATE TABLE IF NOT EXISTS public.gocardless_dynamic_term_completions (
  plan_id uuid PRIMARY KEY REFERENCES public.membership_payment_plans(id),
  tenant_id uuid NOT NULL REFERENCES public.tenant(id),
  billing_agreement_id uuid NOT NULL REFERENCES public.membership_billing_agreements(id),
  term_key text NOT NULL,
  history_table text NOT NULL CHECK (history_table IN ('member_membership_history','organisation_membership_history')),
  history_id uuid NOT NULL,
  required_collections integer NOT NULL CHECK (required_collections > 0),
  payment_evidence jsonb NOT NULL,
  completed_at timestamptz NOT NULL DEFAULT now(),
  notification_status text NOT NULL DEFAULT 'pending' CHECK (notification_status IN ('pending','sent','review')),
  notification_error text,
  notification_messages jsonb,
  notification_next_check_at timestamptz NOT NULL DEFAULT now(),
  notified_at timestamptz
);
CREATE TABLE IF NOT EXISTS public.gocardless_dynamic_completion_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id uuid NOT NULL REFERENCES public.gocardless_dynamic_term_completions(plan_id),
  tenant_id uuid NOT NULL REFERENCES public.tenant(id),
  recipient text NOT NULL,
  message jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sending','failed','uncertain','sent')),
  claim_token uuid,
  attempted_at timestamptz,
  retry_after timestamptz,
  sent_at timestamptz,
  provider_evidence jsonb,
  UNIQUE(plan_id,recipient)
);
ALTER TABLE public.gocardless_dynamic_term_completions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.gocardless_dynamic_completion_deliveries ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.gocardless_dynamic_term_completions,public.gocardless_dynamic_completion_deliveries FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE ON public.gocardless_dynamic_term_completions,public.gocardless_dynamic_completion_deliveries TO service_role;
CREATE INDEX IF NOT EXISTS gocardless_dynamic_completion_notice_due
  ON public.gocardless_dynamic_term_completions(notification_next_check_at) WHERE notification_status='pending';
CREATE INDEX IF NOT EXISTS gocardless_dynamic_completion_check_due
  ON public.membership_payment_plans(dynamic_completion_next_check_at)
  WHERE metadata->>'collection_mode'='dynamic' AND completed_at IS NULL;

CREATE OR REPLACE FUNCTION public.guard_gocardless_dynamic_completion_evidence()
RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Dynamic completion evidence cannot be deleted'; END IF;
  IF TG_TABLE_NAME='gocardless_dynamic_term_completions' THEN
    IF (to_jsonb(NEW)-ARRAY['notification_status','notification_error','notification_next_check_at','notified_at','notification_messages'])
      IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['notification_status','notification_error','notification_next_check_at','notified_at','notification_messages'])
      OR (OLD.notification_messages IS NOT NULL AND NEW.notification_messages IS DISTINCT FROM OLD.notification_messages) THEN
      RAISE EXCEPTION 'Dynamic completion evidence is immutable';
    END IF;
  ELSIF NEW.plan_id IS DISTINCT FROM OLD.plan_id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.recipient IS DISTINCT FROM OLD.recipient OR NEW.message IS DISTINCT FROM OLD.message THEN
    RAISE EXCEPTION 'Dynamic completion delivery request is immutable';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS guard_dynamic_completion_evidence ON public.gocardless_dynamic_term_completions;
CREATE TRIGGER guard_dynamic_completion_evidence BEFORE UPDATE OR DELETE ON public.gocardless_dynamic_term_completions
  FOR EACH ROW EXECUTE FUNCTION public.guard_gocardless_dynamic_completion_evidence();
DROP TRIGGER IF EXISTS guard_dynamic_delivery_evidence ON public.gocardless_dynamic_completion_deliveries;
CREATE TRIGGER guard_dynamic_delivery_evidence BEFORE UPDATE OR DELETE ON public.gocardless_dynamic_completion_deliveries
  FOR EACH ROW EXECUTE FUNCTION public.guard_gocardless_dynamic_completion_evidence();

CREATE OR REPLACE FUNCTION public.complete_gocardless_dynamic_term(p_tenant_id uuid,p_plan_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE
  p public.membership_payment_plans;
  a public.membership_billing_agreements;
  c public.gocardless_dynamic_term_completions;
  terms jsonb;
  first_date date;
  required integer;
  paid integer;
  history_name text;
  owner_column text;
  owner_id uuid;
  history_ids uuid[];
  evidence jsonb;
  completed timestamptz := now();
BEGIN
  SELECT * INTO p FROM public.membership_payment_plans WHERE id=p_plan_id AND tenant_id=p_tenant_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Dynamic completion plan not found in tenant'; END IF;
  SELECT * INTO c FROM public.gocardless_dynamic_term_completions WHERE plan_id=p.id AND tenant_id=p_tenant_id;
  IF FOUND THEN RETURN jsonb_build_object('completed',true,'created',false,'completion',to_jsonb(c)); END IF;
  SELECT * INTO a FROM public.membership_billing_agreements
    WHERE id=p.billing_agreement_id AND tenant_id=p_tenant_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Dynamic completion agreement not found in tenant'; END IF;
  terms := a.metadata->'dd';
  IF p.metadata->>'collection_mode' IS DISTINCT FROM 'dynamic'
    OR p.gocardless_subscription_id IS NOT NULL
    OR p.gocardless_mandate_id IS DISTINCT FROM a.gocardless_mandate_id
    OR a.gocardless_mandate_id IS NULL
    OR terms#>>'{collection_policy,version}' IS DISTINCT FROM '1'
    OR terms#>>'{collection_policy,pricing_policy}' IS DISTINCT FROM 'dynamic'
    OR terms->>'invoicing_mode' IS DISTINCT FROM 'per_instalment'
    OR terms#>>'{commitment,term_key}' IS NULL THEN
    RAISE EXCEPTION 'Dynamic completion requires matching purchased term and consent';
  END IF;
  IF p.status='payment_plan_cancelled' OR EXISTS(SELECT 1 FROM public.membership_monthly_arrears_period
      WHERE tenant_id=p_tenant_id AND plan_id=p.id AND settled_at IS NULL) THEN
    RETURN jsonb_build_object('completed',false,'reason','cancelled or unresolved arrears');
  END IF;
  first_date := (p.metadata->>'dynamic_first_date')::date;
  IF first_date IS NULL OR (terms->>'instalment_count')::integer NOT BETWEEN 1 AND 12
    OR first_date < (terms#>>'{commitment,term_start_date}')::date
    OR first_date > (terms#>>'{commitment,term_end_date}')::date THEN
    RAISE EXCEPTION 'Dynamic completion schedule is invalid';
  END IF;
  -- Anchor arithmetic is identical to reservation/attach RPCs. A late first
  -- collection can legitimately leave fewer dates than the quoted count.
  SELECT count(*) INTO required FROM generate_series(1,(terms->>'instalment_count')::integer) n
    WHERE (first_date+make_interval(months=>n-1))::date <= (terms#>>'{commitment,term_end_date}')::date;
  -- Serialize against mirror updates while committing the all-paid predicate.
  PERFORM g.id FROM public.gocardless_payments g
    JOIN public.gocardless_collection_reservations r ON r.gocardless_payment_id=g.gocardless_payment_id
    WHERE r.plan_id=p.id AND r.tenant_id=p_tenant_id
    ORDER BY g.gocardless_payment_id FOR UPDATE OF g;
  SELECT count(*),jsonb_agg(jsonb_build_object(
    'reservation_id',r.id,'collection_number',r.collection_number,'due_date',r.due_date,
    'requested_charge_date',r.requested_charge_date,'payment_id',g.gocardless_payment_id,
    'amount_minor',r.amount_minor,'currency',r.currency,'status',g.status) ORDER BY r.collection_number)
    INTO paid,evidence
    FROM public.gocardless_collection_reservations r
    JOIN public.gocardless_payments g ON g.gocardless_payment_id=r.gocardless_payment_id
      AND g.tenant_id=p_tenant_id AND g.plan_id=p.id
      AND g.gocardless_mandate_id=p.gocardless_mandate_id
      AND g.amount_minor=r.amount_minor AND upper(g.currency)=upper(r.currency)
      AND g.charge_date=r.requested_charge_date
    WHERE r.tenant_id=p_tenant_id AND r.plan_id=p.id AND r.billing_agreement_id=a.id
      AND r.term_key=terms#>>'{commitment,term_key}'
      AND r.collection_number BETWEEN 1 AND required
      AND r.due_date=(first_date+make_interval(months=>r.collection_number-1))::date
      AND r.requested_charge_date BETWEEN r.due_date AND (terms#>>'{commitment,term_end_date}')::date
      AND r.provider_charge_date=r.requested_charge_date
      AND r.status='submitted' AND g.status IN ('confirmed','paid_out')
      AND r.provider_evidence->>'status' IN ('confirmed','paid_out');
  IF required=0 OR paid<>required OR
    (SELECT count(*) FROM public.gocardless_collection_reservations WHERE plan_id=p.id)<>required THEN
    RETURN jsonb_build_object('completed',false,'required_collections',required,'paid_collections',paid);
  END IF;
  history_name := CASE WHEN a.member_id IS NOT NULL THEN 'member_membership_history' ELSE 'organisation_membership_history' END;
  owner_column := CASE WHEN a.member_id IS NOT NULL THEN 'member_id' ELSE 'organization_id' END;
  owner_id := COALESCE(a.member_id,a.organization_id);
  EXECUTE format('SELECT array_agg(id) FROM (SELECT id FROM public.%I WHERE tenant_id=$1 AND billing_agreement_id=$2 AND %I=$3 AND term_key=$4 FOR UPDATE) h',
    history_name,owner_column) INTO history_ids USING p_tenant_id,a.id,owner_id,terms#>>'{commitment,term_key}';
  IF COALESCE(array_length(history_ids,1),0)<>1 THEN RAISE EXCEPTION 'Dynamic completion needs exactly one tenant-owned term history'; END IF;
  -- Only payment progress changes: no financial totals, term dates, ownership
  -- or history snapshots are synthesized or rewritten.
  EXECUTE format('UPDATE public.%I SET payment_status=''paid'',paid_at=COALESCE(paid_at,$1) WHERE id=$2 AND tenant_id=$3',
    history_name) USING completed,history_ids[1],p_tenant_id;
  UPDATE public.membership_payment_plans SET status='expired',completed_at=COALESCE(completed_at,completed),
    dynamic_next_collection_date=NULL,dynamic_completion_error=NULL,updated_at=completed WHERE id=p.id;
  INSERT INTO public.membership_payment_status_history(tenant_id,entity_type,entity_id,from_status,to_status,reason,source)
    VALUES(p_tenant_id,'payment_plan',p.id,p.status,'expired','All authorized dynamic collections confirmed','system');
  INSERT INTO public.gocardless_dynamic_term_completions(
    plan_id,tenant_id,billing_agreement_id,term_key,history_table,history_id,required_collections,payment_evidence,completed_at)
    VALUES(p.id,p_tenant_id,a.id,terms#>>'{commitment,term_key}',history_name,history_ids[1],required,evidence,completed)
    RETURNING * INTO c;
  RETURN jsonb_build_object('completed',true,'created',true,'completion',to_jsonb(c));
END $$;

CREATE OR REPLACE FUNCTION public.prepare_gocardless_dynamic_completion_notice(
  p_tenant_id uuid,p_plan_id uuid,p_messages jsonb
) RETURNS public.gocardless_dynamic_term_completions
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE c public.gocardless_dynamic_term_completions;
BEGIN
  SELECT * INTO c FROM public.gocardless_dynamic_term_completions
    WHERE plan_id=p_plan_id AND tenant_id=p_tenant_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Dynamic completion not found in tenant'; END IF;
  IF c.notification_messages IS NOT NULL THEN RETURN c; END IF;
  IF jsonb_typeof(p_messages) IS DISTINCT FROM 'array' OR jsonb_array_length(p_messages)=0
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_messages) m WHERE
      m->>'tenantId' IS DISTINCT FROM p_tenant_id::text OR COALESCE(trim(m->>'to'),'')='')
    OR (SELECT count(DISTINCT lower(trim(m->>'to'))) FROM jsonb_array_elements(p_messages) m)<>jsonb_array_length(p_messages) THEN
    RAISE EXCEPTION 'Completion notice requires unique tenant-owned recipient messages';
  END IF;
  UPDATE public.gocardless_dynamic_term_completions SET notification_messages=p_messages
    WHERE plan_id=p_plan_id RETURNING * INTO c;
  RETURN c;
END $$;

-- Email transports cannot guarantee exactly-once after an ambiguous network
-- result. Retain that attempt for review instead of blindly sending twice.
-- Definitely rejected attempts are retryable; accepted recipients never resend.
CREATE OR REPLACE FUNCTION public.claim_gocardless_dynamic_completion_delivery(
  p_tenant_id uuid,p_plan_id uuid,p_recipient text,p_message jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE d public.gocardless_dynamic_completion_deliveries;
BEGIN
  PERFORM 1 FROM public.gocardless_dynamic_term_completions WHERE plan_id=p_plan_id AND tenant_id=p_tenant_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Dynamic completion does not exist in tenant'; END IF;
  IF COALESCE(trim(p_recipient),'')='' OR p_message->>'tenantId' IS DISTINCT FROM p_tenant_id::text
    OR lower(trim(p_message->>'to')) IS DISTINCT FROM lower(trim(p_recipient))
    OR NOT EXISTS(SELECT 1 FROM public.gocardless_dynamic_term_completions c,
      jsonb_array_elements(c.notification_messages) m WHERE c.plan_id=p_plan_id AND m=p_message) THEN
    RAISE EXCEPTION 'Dynamic completion recipient identity mismatch';
  END IF;
  INSERT INTO public.gocardless_dynamic_completion_deliveries(plan_id,tenant_id,recipient,message)
    VALUES(p_plan_id,p_tenant_id,lower(trim(p_recipient)),p_message)
    ON CONFLICT(plan_id,recipient) DO NOTHING;
  SELECT * INTO d FROM public.gocardless_dynamic_completion_deliveries
    WHERE plan_id=p_plan_id AND recipient=lower(trim(p_recipient)) FOR UPDATE;
  IF d.status='sending' AND d.attempted_at<now()-interval '15 minutes' THEN
    UPDATE public.gocardless_dynamic_completion_deliveries SET status='uncertain',
      provider_evidence=jsonb_build_object('error','Delivery worker interrupted; verify provider acceptance before retry')
      WHERE id=d.id RETURNING * INTO d;
  END IF;
  IF d.status IN ('sent','sending','uncertain') OR d.retry_after>now() THEN
    RETURN jsonb_build_object('claimed',false,'delivery',to_jsonb(d));
  END IF;
  UPDATE public.gocardless_dynamic_completion_deliveries SET status='sending',claim_token=gen_random_uuid(),attempted_at=now()
    WHERE id=d.id RETURNING * INTO d;
  RETURN jsonb_build_object('claimed',true,'delivery',to_jsonb(d));
END $$;

CREATE OR REPLACE FUNCTION public.finish_gocardless_dynamic_completion_delivery(
  p_tenant_id uuid,p_delivery_id uuid,p_claim_token uuid,p_status text,p_evidence jsonb
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  IF p_status NOT IN ('sent','failed','uncertain') THEN RAISE EXCEPTION 'Invalid completion delivery outcome'; END IF;
  UPDATE public.gocardless_dynamic_completion_deliveries SET status=p_status,provider_evidence=p_evidence,
    sent_at=CASE WHEN p_status='sent' THEN now() ELSE sent_at END,
    retry_after=CASE WHEN p_status='failed' THEN now()+interval '1 hour' ELSE NULL END
    WHERE id=p_delivery_id AND tenant_id=p_tenant_id AND claim_token=p_claim_token AND status='sending';
  IF NOT FOUND THEN RAISE EXCEPTION 'Completion delivery claim no longer owned'; END IF;
END $$;
REVOKE ALL ON FUNCTION public.complete_gocardless_dynamic_term(uuid,uuid) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.prepare_gocardless_dynamic_completion_notice(uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.claim_gocardless_dynamic_completion_delivery(uuid,uuid,text,jsonb) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.finish_gocardless_dynamic_completion_delivery(uuid,uuid,uuid,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.complete_gocardless_dynamic_term(uuid,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.prepare_gocardless_dynamic_completion_notice(uuid,uuid,jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_gocardless_dynamic_completion_delivery(uuid,uuid,text,jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.finish_gocardless_dynamic_completion_delivery(uuid,uuid,uuid,text,jsonb) TO service_role;

-- Explicit operator/provider reconciliation of an interrupted send. No
-- automatic retry of uncertainty and no rewriting the original attempt proof.
CREATE OR REPLACE FUNCTION public.resolve_gocardless_dynamic_completion_delivery(
  p_tenant_id uuid,p_delivery_id uuid,p_accepted boolean,p_verified_evidence jsonb
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE d public.gocardless_dynamic_completion_deliveries;
BEGIN
  SELECT * INTO d FROM public.gocardless_dynamic_completion_deliveries
    WHERE id=p_delivery_id AND tenant_id=p_tenant_id FOR UPDATE;
  IF NOT FOUND OR d.status IS DISTINCT FROM 'uncertain' THEN
    RAISE EXCEPTION 'Only an uncertain delivery in this tenant may be reconciled';
  END IF;
  IF p_accepted IS NULL OR p_verified_evidence->>'verified_by' IS NULL
    OR p_verified_evidence->>'reason' IS NULL
    OR (p_accepted AND p_verified_evidence->>'provider_message_id' IS NULL)
    OR (NOT p_accepted AND p_verified_evidence->>'provider_rejected' IS DISTINCT FROM 'true') THEN
    RAISE EXCEPTION 'Verified provider acceptance/rejection evidence is required';
  END IF;
  UPDATE public.gocardless_dynamic_completion_deliveries
    SET status=CASE WHEN p_accepted THEN 'sent' ELSE 'failed' END,
      sent_at=CASE WHEN p_accepted THEN now() ELSE NULL END,retry_after=now(),
      provider_evidence=COALESCE(provider_evidence,'{}'::jsonb)||jsonb_build_object(
        'review',p_verified_evidence,'reviewed_at',now(),'accepted',p_accepted)
    WHERE id=d.id;
  UPDATE public.gocardless_dynamic_term_completions SET notification_status='pending',
    notification_next_check_at=now(),notification_error=NULL
    WHERE plan_id=d.plan_id AND tenant_id=p_tenant_id AND notification_status<>'sent';
END $$;
REVOKE ALL ON FUNCTION public.resolve_gocardless_dynamic_completion_delivery(uuid,uuid,boolean,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_gocardless_dynamic_completion_delivery(uuid,uuid,boolean,jsonb) TO service_role;