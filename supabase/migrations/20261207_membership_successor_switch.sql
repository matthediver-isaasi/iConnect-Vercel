-- Provider-reconciled renewal switching. Apply using the pinned DEST runner;
-- never release provider identity based on elapsed reservation age.
BEGIN;
-- Never expire a provider operation based on its age. An interrupted creator
-- needs reconciliation, not a new charge with an expired idempotency key.
ALTER TABLE public.membership_successor_election
  ADD COLUMN provider_work_token uuid,
  ADD COLUMN switch_state text NOT NULL DEFAULT 'idle'
    CHECK (switch_state IN ('idle','reconciling','released')),
  ADD COLUMN switch_receipts jsonb,
  ADD COLUMN switched_at timestamptz;
ALTER TABLE public.membership_payment_quote ADD COLUMN cancelled_for_switch_at timestamptz;
ALTER TABLE public.membership_billing_agreements ADD COLUMN cancelled_for_switch_at timestamptz;
ALTER TABLE public.member_membership_history ADD COLUMN cancelled_for_switch_at timestamptz;
ALTER TABLE public.organisation_membership_history ADD COLUMN cancelled_for_switch_at timestamptz;
-- Generic service-backed entity updates must not manufacture retirement
-- evidence. Only SECURITY DEFINER reconciliation functions may set this column.
DO $$
DECLARE t text; columns text;
BEGIN
  FOREACH t IN ARRAY ARRAY['membership_payment_quote','membership_billing_agreements',
    'member_membership_history','organisation_membership_history'] LOOP
    IF has_table_privilege('service_role','public.' || t,'UPDATE') THEN
      SELECT string_agg(quote_ident(attname),',' ORDER BY attnum) INTO columns
        FROM pg_attribute WHERE attrelid=('public.' || t)::regclass AND attnum>0
          AND NOT attisdropped AND attname<>'cancelled_for_switch_at';
      EXECUTE format('REVOKE UPDATE ON public.%I FROM service_role',t);
      EXECUTE format('GRANT UPDATE (%s) ON public.%I TO service_role',columns,t);
    END IF;
  END LOOP;
END $$;

-- Retain every pending history row and its original financial identity. Only a
-- server-confirmed cancellation removes it from uniqueness/overlap authority.
DO $$
DECLARE t text; owner_column text; index_name text; definition text; predicate text;
BEGIN
  FOREACH t IN ARRAY ARRAY['member_membership_history','organisation_membership_history'] LOOP
    owner_column:=CASE WHEN t='member_membership_history' THEN 'member_id' ELSE 'organization_id' END;
    FOREACH index_name IN ARRAY ARRAY[
      CASE WHEN t='member_membership_history' THEN 'member_membership_history_member_year_uniq'
        ELSE 'organisation_membership_history_org_year_uniq' END,
      t || '_rolling_term_uniq', t || '_rolling_successor_uniq'
    ] LOOP
      SELECT pg_get_indexdef(to_regclass('public.' || index_name)) INTO definition;
      predicate:=CASE WHEN index_name LIKE '%year_uniq' THEN 'term_key IS NULL'
        WHEN index_name LIKE '%term_uniq' THEN 'term_key IS NOT NULL' ELSE 'previous_term_id IS NOT NULL' END;
      IF definition IS NULL OR position(predicate IN definition)=0
        OR position('cancelled_for_switch_at' IN definition)>0 THEN
        RAISE EXCEPTION 'History uniqueness contract changed';
      END IF;
      EXECUTE format('DROP INDEX public.%I',index_name);
      EXECUTE replace(definition,predicate,predicate || ' AND cancelled_for_switch_at IS NULL');
    END LOOP;
    SELECT pg_get_constraintdef(oid) INTO definition FROM pg_constraint
      WHERE conrelid=('public.' || t)::regclass AND conname=t || '_rolling_no_overlap';
    IF definition IS NULL OR position('term_key IS NOT NULL' IN definition)=0 THEN
      RAISE EXCEPTION 'History overlap contract changed';
    END IF;
    EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT %I',t,t || '_rolling_no_overlap');
    EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I %s',t,t || '_rolling_no_overlap',
      replace(definition,'term_key IS NOT NULL','term_key IS NOT NULL AND cancelled_for_switch_at IS NULL'));
  END LOOP;
END $$;

DROP INDEX public.membership_payment_quote_member_term_uniq;
CREATE UNIQUE INDEX membership_payment_quote_member_term_uniq
  ON public.membership_payment_quote(tenant_id,member_id,term_key)
  WHERE organization_id IS NULL AND term_key IS NOT NULL AND cancelled_for_switch_at IS NULL;
DROP INDEX public.membership_payment_quote_org_term_uniq;
CREATE UNIQUE INDEX membership_payment_quote_org_term_uniq
  ON public.membership_payment_quote(tenant_id,organization_id,term_key)
  WHERE organization_id IS NOT NULL AND term_key IS NOT NULL AND cancelled_for_switch_at IS NULL;

CREATE FUNCTION public.begin_membership_successor_provider_work(p_tenant_id uuid,p_election_id uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE token uuid:=gen_random_uuid();
BEGIN
  UPDATE public.membership_successor_election SET provider_work_token=token
    WHERE id=p_election_id AND tenant_id=p_tenant_id AND status='reserved'
      AND switch_state='idle' AND provider_work_token IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'Renewal provider operation is busy or fenced'; END IF;
  RETURN token;
END $$;
CREATE FUNCTION public.finish_membership_successor_provider_work(p_tenant_id uuid,p_election_id uuid,p_token uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  UPDATE public.membership_successor_election SET provider_work_token=NULL
    WHERE id=p_election_id AND tenant_id=p_tenant_id AND provider_work_token=p_token;
  IF NOT FOUND THEN RAISE EXCEPTION 'Provider operation ownership changed'; END IF;
  RETURN true;
END $$;

-- Called under the owner advisory lock. Only unpaid, uncommitted setup children
-- may be retired; current-term instalments never match this election.
CREATE FUNCTION public.begin_membership_successor_switch(
  p_tenant_id uuid,p_election_id uuid,p_payer_member_id uuid,p_organization_id uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE e public.membership_successor_election%ROWTYPE;
  q public.membership_payment_quote%ROWTYPE; attempts jsonb; agreements jsonb;
BEGIN
  SELECT * INTO e FROM public.membership_successor_election
    WHERE id=p_election_id AND tenant_id=p_tenant_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Renewal does not belong to this payer and owner'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('rolling:' || p_tenant_id::text || ':' ||
    CASE WHEN e.organization_id IS NULL THEN 'member_id' ELSE 'organization_id' END || ':' ||
    coalesce(e.organization_id,e.member_id)::text,0));
  SELECT * INTO e FROM public.membership_successor_election
    WHERE id=p_election_id AND tenant_id=p_tenant_id FOR UPDATE;
  IF NOT FOUND OR e.origin<>'form' OR e.quote->>'payerMemberId' IS DISTINCT FROM p_payer_member_id::text
    OR (e.organization_id IS NOT NULL AND e.organization_id IS DISTINCT FROM p_organization_id)
    OR (e.organization_id IS NULL AND e.member_id IS DISTINCT FROM p_payer_member_id)
    OR NOT EXISTS(SELECT 1 FROM public.member m WHERE m.id=p_payer_member_id
      AND m.tenant_id=p_tenant_id AND (e.organization_id IS NULL OR m.organization_id=e.organization_id)) THEN
    RAISE EXCEPTION 'Renewal does not belong to this payer and owner';
  END IF;
  IF e.status='released' AND e.switch_state='released' THEN RETURN '{"released":true}'::jsonb; END IF;
  IF e.status<>'reserved' THEN
    RAISE EXCEPTION 'Renewal reservation is no longer active';
  END IF;
  -- A creator with unbound provider identity is refused below. Once every
  -- provider object is bound, terminal cancellation fences even a paused
  -- creator: late binds/history writes are rejected by the switch trigger.
  -- Childless creators must first insert a quote/agreement, also fenced.
  SELECT coalesce(jsonb_agg(to_jsonb(a)),'[]'::jsonb) INTO agreements
    FROM public.membership_billing_agreements a WHERE membership_successor_election_id=e.id;
  IF jsonb_array_length(agreements)>1 OR EXISTS(
    SELECT 1 FROM jsonb_array_elements(agreements) a
    WHERE a->>'status' IS DISTINCT FROM 'payment_setup_required'
      OR a->>'tenant_id' IS DISTINCT FROM p_tenant_id::text
      OR a->>'gocardless_mandate_id' IS NOT NULL
      OR a->>'gocardless_subscription_id' IS NOT NULL OR a->>'stripe_subscription_id' IS NOT NULL
      OR a->>'provider' NOT IN ('stripe','gocardless')
      OR (a->>'provider'='stripe' AND a->>'stripe_checkout_session_id' IS NULL)
      OR (a->>'provider'='gocardless' AND a->>'gocardless_billing_request_id' IS NULL)
      OR EXISTS(SELECT 1 FROM public.membership_payment_plans p
        WHERE coalesce(to_jsonb(p)->>'billing_agreement_id',to_jsonb(p)->>'agreement_id')=a->>'id')
  ) THEN RAISE EXCEPTION 'A completed or unresolved provider agreement cannot be switched'; END IF;
  IF EXISTS(
    SELECT 1 FROM (
      SELECT to_jsonb(h) r FROM public.member_membership_history h WHERE membership_successor_election_id=e.id
      UNION ALL
      SELECT to_jsonb(h) r FROM public.organisation_membership_history h WHERE membership_successor_election_id=e.id
    ) histories WHERE r->>'status' IS DISTINCT FROM 'pending_payment_setup'
      OR r->>'payment_status' IS DISTINCT FROM 'unpaid'
      OR r->>'paid_at' IS NOT NULL OR r->>'stripe_payment_intent_id' IS NOT NULL
      OR r->>'invoice_id' IS NOT NULL OR r->>'xero_invoice_id' IS NOT NULL
      OR r->>'quickbooks_invoice_id' IS NOT NULL
      OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(agreements) a WHERE a->>'id'=r->>'billing_agreement_id')
  ) THEN
    RAISE EXCEPTION 'A recorded financial obligation cannot be switched';
  END IF;
  SELECT * INTO q FROM public.membership_payment_quote
    WHERE tenant_id=p_tenant_id AND quote#>>'{simResult,formRenewalElectionId}'=e.id::text FOR UPDATE;
  IF FOUND THEN
    IF q.id IS DISTINCT FROM e.payment_quote_id OR q.member_id IS DISTINCT FROM p_payer_member_id
      OR q.organization_id IS DISTINCT FROM e.organization_id OR q.stripe_payment_intent_id IS NULL THEN
      RAISE EXCEPTION 'Checkout provider identity is unresolved';
    END IF;
    SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY a.attempt_number),'[]'::jsonb) INTO attempts
      FROM public.membership_successor_payment_attempt a WHERE a.quote_id=q.id AND a.tenant_id=p_tenant_id;
    IF EXISTS(SELECT 1 FROM public.membership_successor_payment_attempt
      WHERE quote_id=q.id AND provider_intent_id IS NULL) THEN
      RAISE EXCEPTION 'A replacement provider operation is unresolved';
    END IF;
  ELSIF e.payment_quote_id IS NOT NULL THEN RAISE EXCEPTION 'Saved checkout is missing';
  END IF;
  UPDATE public.membership_successor_election SET switch_state='reconciling' WHERE id=e.id;
  RETURN jsonb_build_object('quote',CASE WHEN q.id IS NULL THEN NULL ELSE to_jsonb(q) END,
    'attempts',coalesce(attempts,'[]'::jsonb),'agreements',agreements);
END $$;

CREATE FUNCTION public.refuse_membership_successor_switch(
  p_tenant_id uuid,p_election_id uuid,p_payer_member_id uuid,p_organization_id uuid
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  PERFORM public.begin_membership_successor_switch(p_tenant_id,p_election_id,p_payer_member_id,p_organization_id);
  UPDATE public.membership_successor_election SET switch_state='idle'
    WHERE id=p_election_id AND status='reserved' AND switch_state='reconciling';
  RETURN FOUND;
END $$;

CREATE FUNCTION public.finish_membership_successor_switch(
  p_tenant_id uuid,p_election_id uuid,p_payer_member_id uuid,p_organization_id uuid,p_receipts jsonb
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE snapshot jsonb; qid uuid; expected text[]; received text[];
BEGIN
  snapshot:=public.begin_membership_successor_switch(p_tenant_id,p_election_id,p_payer_member_id,p_organization_id);
  IF snapshot->>'released'='true' THEN RETURN true; END IF;
  qid:=(snapshot#>>'{quote,id}')::uuid;
  IF jsonb_typeof(p_receipts) IS DISTINCT FROM 'array' OR EXISTS(
    SELECT 1 FROM jsonb_array_elements(p_receipts) r WHERE r->>'status' IS DISTINCT FROM 'canceled'
      OR (r->>'provider' IS NULL AND (r->>'livemode')::boolean
        IS DISTINCT FROM (snapshot#>>'{quote,quote,stripeEnvironment}'='live'))
  ) THEN RAISE EXCEPTION 'Confirmed provider cancellation receipts required'; END IF;
  SELECT array_agg(id ORDER BY id) INTO expected FROM (
    SELECT snapshot#>>'{quote,stripe_payment_intent_id}' id WHERE qid IS NOT NULL
    UNION ALL SELECT value->>'provider_intent_id' FROM jsonb_array_elements(snapshot->'attempts')
    UNION ALL SELECT CASE WHEN value->>'provider'='stripe' THEN value->>'stripe_checkout_session_id'
      ELSE value->>'gocardless_billing_request_id' END FROM jsonb_array_elements(snapshot->'agreements')
  ) ids;
  SELECT array_agg(r->>'id' ORDER BY r->>'id') INTO received FROM jsonb_array_elements(p_receipts) r;
  IF expected IS DISTINCT FROM received THEN RAISE EXCEPTION 'Cancellation evidence does not cover every attempt'; END IF;
  UPDATE public.membership_payment_quote SET cancelled_for_switch_at=now() WHERE id=qid;
  UPDATE public.member_membership_history SET status='expired_checkout',cancelled_for_switch_at=now()
    WHERE membership_successor_election_id=p_election_id;
  UPDATE public.organisation_membership_history SET status='expired_checkout',cancelled_for_switch_at=now()
    WHERE membership_successor_election_id=p_election_id;
  UPDATE public.membership_billing_agreements SET status='cancelled',cancelled_for_switch_at=now()
    WHERE membership_successor_election_id=p_election_id;
  UPDATE public.membership_successor_election SET status='released',switch_state='released',
    switch_receipts=p_receipts,switched_at=now() WHERE id=p_election_id;
  RETURN true;
END $$;

-- Fence both delayed inserts and callbacks updating existing financial rows.
CREATE FUNCTION public.guard_membership_successor_switch() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE eid uuid; e public.membership_successor_election%ROWTYPE;
BEGIN
  IF TG_OP='INSERT'
    AND to_jsonb(NEW)->>'cancelled_for_switch_at' IS NOT NULL THEN
    RAISE EXCEPTION 'New quotes cannot carry cancellation evidence';
  END IF;
  IF TG_OP='UPDATE' AND TG_TABLE_NAME IN
    ('membership_billing_agreements','member_membership_history','organisation_membership_history')
    AND to_jsonb(OLD)->>'membership_successor_election_id' IS NOT NULL
    AND to_jsonb(OLD)->>'membership_successor_election_id'
      IS DISTINCT FROM to_jsonb(NEW)->>'membership_successor_election_id' THEN
    RAISE EXCEPTION 'A successor child cannot be reassigned to another election';
  END IF;
  eid:=CASE WHEN TG_TABLE_NAME='membership_payment_quote'
    THEN (to_jsonb(NEW)#>>'{quote,simResult,formRenewalElectionId}')::uuid
    WHEN TG_TABLE_NAME='membership_successor_payment_attempt' THEN
      (SELECT (q.quote#>>'{simResult,formRenewalElectionId}')::uuid
       FROM public.membership_payment_quote q WHERE q.id=(to_jsonb(NEW)->>'quote_id')::uuid)
    ELSE (to_jsonb(NEW)->>'membership_successor_election_id')::uuid END;
  IF eid IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO e FROM public.membership_successor_election WHERE id=eid FOR UPDATE;
  IF TG_OP='UPDATE' AND to_jsonb(NEW)->'cancelled_for_switch_at'
    IS DISTINCT FROM to_jsonb(OLD)->'cancelled_for_switch_at'
    AND (e.switch_state IS DISTINCT FROM 'reconciling' OR e.status IS DISTINCT FROM 'reserved') THEN
    RAISE EXCEPTION 'Only provider reconciliation may retire a checkout';
  END IF;
  IF NOT FOUND OR e.status<>'reserved' OR e.switch_state<>'idle' THEN
    -- Only the switching RPC may retire the immutable quote; never alter prices,
    -- provider bindings, or owner identity as part of that transition.
    IF TG_TABLE_NAME='membership_payment_quote' AND TG_OP='UPDATE'
      AND e.status='reserved' AND e.switch_state='reconciling'
      AND (to_jsonb(NEW)-'cancelled_for_switch_at')=(to_jsonb(OLD)-'cancelled_for_switch_at')
      AND to_jsonb(OLD)->>'cancelled_for_switch_at' IS NULL
      AND to_jsonb(NEW)->>'cancelled_for_switch_at' IS NOT NULL THEN
      RETURN NEW;
    END IF;
    IF TG_TABLE_NAME IN ('membership_billing_agreements','member_membership_history','organisation_membership_history')
      AND TG_OP='UPDATE' AND e.status='reserved' AND e.switch_state='reconciling'
      AND (to_jsonb(NEW)-'cancelled_for_switch_at'-'status')=(to_jsonb(OLD)-'cancelled_for_switch_at'-'status')
      AND to_jsonb(OLD)->>'cancelled_for_switch_at' IS NULL
      AND to_jsonb(NEW)->>'cancelled_for_switch_at' IS NOT NULL
      AND to_jsonb(NEW)->>'status'=(CASE WHEN TG_TABLE_NAME='membership_billing_agreements'
        THEN 'cancelled' ELSE 'expired_checkout' END) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'Renewal payment method is changing or has been released';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER guard_successor_switch BEFORE INSERT OR UPDATE ON public.membership_payment_quote
  FOR EACH ROW EXECUTE FUNCTION public.guard_membership_successor_switch();
CREATE TRIGGER guard_successor_switch BEFORE INSERT OR UPDATE ON public.membership_successor_payment_attempt
  FOR EACH ROW EXECUTE FUNCTION public.guard_membership_successor_switch();
CREATE TRIGGER guard_successor_switch BEFORE INSERT OR UPDATE ON public.membership_billing_agreements
  FOR EACH ROW EXECUTE FUNCTION public.guard_membership_successor_switch();
CREATE TRIGGER guard_successor_switch BEFORE INSERT OR UPDATE ON public.member_membership_history
  FOR EACH ROW EXECUTE FUNCTION public.guard_membership_successor_switch();
CREATE TRIGGER guard_successor_switch BEFORE INSERT OR UPDATE ON public.organisation_membership_history
  FOR EACH ROW EXECUTE FUNCTION public.guard_membership_successor_switch();

-- Preserve existing legacy guards verbatim, changing only which immutable
-- quotes still reserve the successor. Abort if the reviewed contract drifts.
DO $$
DECLARE definition text; needle text; contract regprocedure;
BEGIN
  SELECT pg_get_functiondef('public.reserve_membership_successor(uuid,uuid,uuid,uuid,date,date,text,text,jsonb)'::regprocedure) INTO definition;
  needle:='WHERE q.tenant_id=p_tenant_id';
  IF length(definition)-length(replace(definition,needle,''))<>length(needle) THEN
    RAISE EXCEPTION 'Successor reservation contract changed';
  END IF;
  EXECUTE replace(definition,needle,needle || ' AND q.cancelled_for_switch_at IS NULL');
  FOREACH contract IN ARRAY ARRAY[
    'public.enforce_rolling_membership_commitment()'::regprocedure,
    'public.enforce_rolling_payment_quote()'::regprocedure
  ] LOOP
    SELECT pg_get_functiondef(contract) INTO definition;
    needle:='WHERE q.tenant_id = ';
    IF length(definition)-length(replace(definition,needle,''))<>length(needle) THEN
      RAISE EXCEPTION 'Rolling quote overlap contract changed';
    END IF;
    EXECUTE replace(definition,needle,'WHERE q.cancelled_for_switch_at IS NULL AND q.tenant_id = ');
  END LOOP;
  FOREACH contract IN ARRAY ARRAY[
    'public.enforce_rolling_membership_commitment()'::regprocedure,
    'public.enforce_rolling_payment_quote()'::regprocedure
  ] LOOP
    SELECT pg_get_functiondef(contract) INTO definition;
    needle:='SELECT id FROM %I WHERE tenant_id';
    IF position(needle IN definition)=0 THEN RAISE EXCEPTION 'History overlap lookup contract changed'; END IF;
    EXECUTE replace(definition,needle,'SELECT id FROM %I WHERE cancelled_for_switch_at IS NULL AND tenant_id');
  END LOOP;
  contract:='public.reserve_form_membership_payment_quote(uuid,uuid,uuid,jsonb)'::regprocedure;
  SELECT pg_get_functiondef(contract) INTO definition;
  needle:='WHERE tenant_id=p_tenant_id AND term_key';
  IF length(definition)-length(replace(definition,needle,''))<>2*length(needle) THEN
    RAISE EXCEPTION 'Legacy quote reservation contract changed';
  END IF;
  EXECUTE replace(definition,needle,'WHERE cancelled_for_switch_at IS NULL AND tenant_id=p_tenant_id AND term_key');
  SELECT pg_get_functiondef(contract) INTO definition;
  needle:='SELECT id FROM %I WHERE tenant_id';
  IF position(needle IN definition)=0 THEN RAISE EXCEPTION 'Legacy history overlap lookup contract changed'; END IF;
  EXECUTE replace(definition,needle,'SELECT id FROM %I WHERE cancelled_for_switch_at IS NULL AND tenant_id');
END $$;

REVOKE ALL ON FUNCTION public.begin_membership_successor_provider_work(uuid,uuid),
  public.finish_membership_successor_provider_work(uuid,uuid,uuid),
  public.begin_membership_successor_switch(uuid,uuid,uuid,uuid),
  public.refuse_membership_successor_switch(uuid,uuid,uuid,uuid),
  public.finish_membership_successor_switch(uuid,uuid,uuid,uuid,jsonb),
  public.guard_membership_successor_switch() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.begin_membership_successor_provider_work(uuid,uuid),
  public.finish_membership_successor_provider_work(uuid,uuid,uuid),
  public.begin_membership_successor_switch(uuid,uuid,uuid,uuid),
  public.refuse_membership_successor_switch(uuid,uuid,uuid,uuid),
  public.finish_membership_successor_switch(uuid,uuid,uuid,uuid,jsonb) TO service_role;
COMMIT;
