-- Additive service-owned authority. Does not change any existing mandate.
BEGIN;
CREATE TABLE public.gocardless_replacement_release (
  environment text PRIMARY KEY CHECK (environment IN ('sandbox','live')),
  enabled boolean NOT NULL DEFAULT false,
  evidence_reference text NOT NULL,
  enabled_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.gocardless_mutation_intents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  environment text NOT NULL,
  mandate_id text NOT NULL,
  request_key text NOT NULL,
  operation_id uuid REFERENCES public.membership_mandate_replacements(id),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','confirmed','unknown')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(environment,mandate_id,request_key)
);
ALTER TABLE public.gocardless_replacement_release ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.gocardless_mutation_intents ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.gocardless_replacement_release,public.gocardless_mutation_intents FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.gocardless_replacement_release TO service_role;
GRANT SELECT ON public.gocardless_mutation_intents TO service_role;

CREATE FUNCTION public.begin_gocardless_mutation(p_environment text,p_mandate_id text,
  p_request_key text,p_operation_id uuid DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE o public.membership_mandate_replacements; result uuid;
BEGIN
  IF p_environment NOT IN ('live','sandbox') OR nullif(p_mandate_id,'') IS NULL
    OR nullif(p_request_key,'') IS NULL THEN RAISE EXCEPTION 'Invalid provider intent'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('gc-mandate:'||p_environment||':'||p_mandate_id,0));
  SELECT * INTO o FROM public.membership_mandate_replacements
    WHERE environment=p_environment AND (old_mandate_id=p_mandate_id OR new_mandate_id=p_mandate_id)
    AND (status='switching' OR (status='action_required' AND phase<>'authorization')
      OR (status='completed' AND old_mandate_id=p_mandate_id))
    ORDER BY created_at DESC LIMIT 1;
  IF FOUND AND (p_operation_id IS DISTINCT FROM o.id OR o.status<>'switching') THEN
    RAISE EXCEPTION 'Mandate handover owns collection authority' USING ERRCODE='40001';
  END IF;
  IF p_operation_id IS NOT NULL AND (o.id IS DISTINCT FROM p_operation_id OR o.status<>'switching') THEN
    RAISE EXCEPTION 'Invalid handover mutation authority';
  END IF;
  INSERT INTO public.gocardless_mutation_intents(environment,mandate_id,request_key,operation_id)
    VALUES(p_environment,p_mandate_id,p_request_key,p_operation_id)
    ON CONFLICT(environment,mandate_id,request_key) DO UPDATE SET updated_at=now(),state='pending'
    WHERE gocardless_mutation_intents.operation_id IS NOT DISTINCT FROM p_operation_id
    RETURNING id INTO result;
  IF result IS NULL THEN RAISE EXCEPTION 'Provider intent owner conflict'; END IF;
  RETURN result;
END $$;

CREATE FUNCTION public.finish_gocardless_mutation(p_id uuid,p_confirmed boolean)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  UPDATE public.gocardless_mutation_intents SET
    state=CASE WHEN p_confirmed OR state='confirmed' THEN 'confirmed' ELSE 'unknown' END,updated_at=now()
    WHERE id=p_id;
$$;

CREATE FUNCTION public.prepare_mandate_handover(p_id uuid,p_version integer,p_snapshot jsonb)
RETURNS public.membership_mandate_replacements LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE o public.membership_mandate_replacements; a jsonb; h jsonb; p jsonb;
BEGIN
  SELECT * INTO STRICT o FROM public.membership_mandate_replacements WHERE id=p_id FOR UPDATE;
  PERFORM pg_advisory_xact_lock(hashtextextended('gc-mandate:'||o.environment||':'||o.old_mandate_id,0));
  PERFORM pg_advisory_xact_lock(hashtextextended('gc-mandate:'||o.environment||':'||o.new_mandate_id,0));
  IF o.version<>p_version OR o.status NOT IN ('authorizing','awaiting_confirmation')
    OR o.phase<>'authorization' OR o.new_mandate_id IS NULL THEN RAISE EXCEPTION 'Stale handover preparation'; END IF;
  IF NOT EXISTS (SELECT FROM public.gocardless_replacement_release WHERE environment=o.environment AND enabled
    AND length(evidence_reference)>10 AND enabled_at < now()-interval '5 minutes') THEN
    RAISE EXCEPTION 'Handover release evidence is required';
  END IF;
  IF EXISTS(SELECT FROM public.gocardless_mutation_intents WHERE environment=o.environment
    AND mandate_id IN(o.old_mandate_id,o.new_mandate_id) AND state<>'confirmed') THEN
    RAISE EXCEPTION 'An unresolved provider mutation requires reconciliation';
  END IF;
  SELECT to_jsonb(x) INTO a FROM public.membership_billing_agreements x WHERE id=o.agreement_id FOR UPDATE;
  SELECT to_jsonb(x) INTO h FROM public.member_membership_history x WHERE id=o.history_id FOR UPDATE;
  SELECT to_jsonb(x) INTO p FROM public.membership_payment_plans x WHERE billing_agreement_id=o.agreement_id FOR UPDATE;
  IF a IS DISTINCT FROM p_snapshot->'agreement' OR h IS DISTINCT FROM p_snapshot->'history'
    OR coalesce(p,'null'::jsonb) IS DISTINCT FROM p_snapshot->'plan' THEN
    RAISE EXCEPTION 'Membership changed during handover preparation' USING ERRCODE='40001';
  END IF;
  IF (SELECT count(*) FROM public.membership_billing_agreements WHERE gocardless_mandate_id=o.old_mandate_id)<>1
    OR EXISTS(SELECT FROM public.membership_payment_plans WHERE gocardless_mandate_id=o.old_mandate_id
      AND billing_agreement_id<>o.agreement_id)
    OR EXISTS(SELECT FROM public.gocardless_collection_reservations r WHERE billing_agreement_id=o.agreement_id
      AND (r.status<>'submitted' OR NOT EXISTS (
        SELECT FROM jsonb_array_elements(p_snapshot->'payments') evidence
        WHERE evidence->>'id'=r.gocardless_payment_id AND evidence->>'status'='paid_out'))) THEN
    RAISE EXCEPTION 'Shared or unresolved collection authority requires assistance';
  END IF;
  UPDATE public.membership_mandate_replacements SET status='switching',phase='prepared',snapshot=p_snapshot
    WHERE id=o.id RETURNING * INTO o;
  RETURN o;
END $$;

-- Every reference write takes the same lock as provider intent and prepare.
-- Historical rows cannot be re-parented out of a fence. Existing consent,
-- history and financial terms are never rewritten by the commit RPC.
CREATE FUNCTION public.guard_mandate_handover_reference()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE r jsonb; previous jsonb; mid text; env text; o public.membership_mandate_replacements;
BEGIN
  IF TG_OP<>'DELETE' THEN r:=to_jsonb(NEW); ELSE r:=to_jsonb(OLD); END IF;
  IF TG_OP<>'INSERT' THEN previous:=to_jsonb(OLD); END IF;
  FOR mid,env IN SELECT DISTINCT v.m,v.e FROM (VALUES
    (r->>'gocardless_mandate_id',r->>'environment'),
    (previous->>'gocardless_mandate_id',previous->>'environment')) v(m,e)
    WHERE v.m IS NOT NULL ORDER BY v.m,v.e LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('gc-mandate:'||env||':'||mid,0));
    SELECT * INTO o FROM public.membership_mandate_replacements WHERE environment=env
      AND (old_mandate_id=mid OR new_mandate_id=mid)
      AND (status='switching' OR (status='action_required' AND phase<>'authorization')
        OR (status='completed' AND old_mandate_id=mid)) ORDER BY created_at DESC LIMIT 1;
    IF FOUND THEN
      IF current_setting('app.mandate_handover',true)=o.id::text AND TG_OP='UPDATE'
        AND o.phase='commit_intent'
        AND r->>'gocardless_mandate_id'=o.new_mandate_id
        AND (r-'gocardless_mandate_id'-'gocardless_customer_id'-'gocardless_subscription_id')
          =(previous-'gocardless_mandate_id'-'gocardless_customer_id'-'gocardless_subscription_id') THEN CONTINUE; END IF;
      RAISE EXCEPTION 'Mandate replacement fences collection references' USING ERRCODE='40001';
    END IF;
  END LOOP;
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;
CREATE TRIGGER zz_mandate_handover_agreement BEFORE INSERT OR UPDATE OR DELETE
  ON public.membership_billing_agreements FOR EACH ROW EXECUTE FUNCTION public.guard_mandate_handover_reference();
CREATE TRIGGER zz_mandate_handover_plan BEFORE INSERT OR UPDATE OR DELETE
  ON public.membership_payment_plans FOR EACH ROW EXECUTE FUNCTION public.guard_mandate_handover_reference();

CREATE FUNCTION public.guard_mandate_handover_child()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE r jsonb; previous jsonb; p public.membership_payment_plans;
BEGIN
  IF TG_OP<>'DELETE' THEN r:=to_jsonb(NEW); ELSE r:=to_jsonb(OLD); END IF;
  IF TG_OP<>'INSERT' THEN previous:=to_jsonb(OLD); END IF;
  FOR p IN SELECT * FROM public.membership_payment_plans WHERE id IN
    ((r->>'plan_id')::uuid,(previous->>'plan_id')::uuid) ORDER BY id FOR UPDATE LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('gc-mandate:'||p.environment||':'||p.gocardless_mandate_id,0));
    IF EXISTS(SELECT FROM public.membership_mandate_replacements
      WHERE environment=p.environment AND (old_mandate_id=p.gocardless_mandate_id OR new_mandate_id=p.gocardless_mandate_id)
      AND (status='switching' OR (status='action_required' AND phase<>'authorization'))) THEN
      RAISE EXCEPTION 'Mandate handover fences collection claims' USING ERRCODE='40001';
    END IF;
  END LOOP;
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;
DO $$
DECLARE child text;
BEGIN
  FOREACH child IN ARRAY ARRAY['gocardless_collection_reservations','member_amendment_provider_operation',
    'membership_monthly_collection_intent'] LOOP
    IF to_regclass('public.'||child) IS NOT NULL THEN
      EXECUTE format('CREATE TRIGGER zz_mandate_handover_claim BEFORE INSERT OR UPDATE OR DELETE ON public.%I
        FOR EACH ROW EXECUTE FUNCTION public.guard_mandate_handover_child()', child);
    END IF;
  END LOOP;
END $$;

CREATE FUNCTION public.commit_mandate_handover(p_id uuid,p_version integer)
RETURNS public.membership_mandate_replacements LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE o public.membership_mandate_replacements;
BEGIN
  SELECT * INTO STRICT o FROM public.membership_mandate_replacements WHERE id=p_id FOR UPDATE;
  IF o.version<>p_version OR o.status<>'switching' OR o.phase<>'commit_intent'
    OR o.new_mandate_id IS NULL THEN RAISE EXCEPTION 'Stale handover commit'; END IF;
  PERFORM set_config('app.mandate_handover',o.id::text,true);
  UPDATE public.membership_billing_agreements
    SET gocardless_mandate_id=o.new_mandate_id,gocardless_customer_id=o.new_customer_id
    WHERE id=o.agreement_id AND tenant_id=o.tenant_id AND gocardless_mandate_id=o.old_mandate_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Agreement collection authority changed'; END IF;
  IF o.snapshot->'plan'<>'null'::jsonb THEN
    UPDATE public.membership_payment_plans SET gocardless_mandate_id=o.new_mandate_id,
      gocardless_subscription_id=CASE WHEN o.snapshot->>'mode'='subscription'
        THEN o.new_subscription_id ELSE gocardless_subscription_id END
      WHERE id=(o.snapshot#>>'{plan,id}')::uuid AND tenant_id=o.tenant_id AND gocardless_mandate_id=o.old_mandate_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Plan collection authority changed'; END IF;
  END IF;
  UPDATE public.membership_mandate_replacements SET phase='retire_intent' WHERE id=o.id RETURNING * INTO o;
  RETURN o;
END $$;
REVOKE ALL ON FUNCTION public.begin_gocardless_mutation(text,text,text,uuid),
  public.finish_gocardless_mutation(uuid,boolean),public.prepare_mandate_handover(uuid,integer,jsonb),
  public.commit_mandate_handover(uuid,integer),public.guard_mandate_handover_reference() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.guard_mandate_handover_child() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.begin_gocardless_mutation(text,text,text,uuid),
  public.finish_gocardless_mutation(uuid,boolean),public.prepare_mandate_handover(uuid,integer,jsonb),
  public.commit_mandate_handover(uuid,integer) TO service_role;
COMMIT;
