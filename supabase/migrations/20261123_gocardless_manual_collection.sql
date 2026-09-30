-- Timing-only, one-period finance authorization. Apply transactionally using the
-- reviewed runner. No existing consent, holds, clocks or dates are rewritten.
-- This private helper supports the actual installed financial cadence contract.
-- It neither installs nor impersonates the separately released amendment RPC.
CREATE OR REPLACE FUNCTION public.gocardless_manual_collection_due_date(
 p_tenant_id uuid,p_plan_id uuid,p_collection_number integer
) RETURNS date LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE p public.membership_payment_plans; reserve_source text; attach_source text;
 amended boolean; evidence boolean; result date;
BEGIN
 SELECT * INTO p FROM public.membership_payment_plans WHERE id=p_plan_id AND tenant_id=p_tenant_id;
 IF NOT FOUND OR p_collection_number IS NULL OR p_collection_number<1 THEN
   RAISE EXCEPTION 'Invalid tenant-owned manual collection schedule lookup';
 END IF;
 SELECT prosrc INTO reserve_source FROM pg_proc
   WHERE oid=to_regprocedure('public.reserve_gocardless_dynamic_collection(uuid,uuid,integer,date,jsonb,jsonb,text)');
 SELECT prosrc INTO attach_source FROM pg_proc
   WHERE oid=to_regprocedure('public.attach_gocardless_dynamic_payment(uuid,uuid,jsonb)');
 amended:=to_regprocedure('public.gocardless_dynamic_collection_due_date(uuid,integer)') IS NOT NULL;
 IF reserve_source IS NULL OR attach_source IS NULL THEN RAISE EXCEPTION 'Financial cadence contract unavailable'; END IF;
 IF amended THEN
   -- The reviewed amendment migration uses this exact plan-locking wrapper;
   -- validate its real inner attachment body, never an unrelated stub/helper.
   IF btrim(attach_source)=btrim($attachment_wrapper$
DECLARE target_plan uuid;
BEGIN
  SELECT plan_id INTO target_plan FROM public.gocardless_collection_reservations
    WHERE id=p_reservation_id AND tenant_id=p_tenant_id;
  PERFORM 1 FROM public.membership_payment_plans WHERE id=target_plan AND tenant_id=p_tenant_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Reservation plan not found'; END IF;
  RETURN public.attach_gocardless_dynamic_payment_before_schedule_amendments(p_tenant_id,p_reservation_id,p_payment);
END $attachment_wrapper$) THEN
     SELECT prosrc INTO attach_source FROM pg_proc
       WHERE oid=to_regprocedure('public.attach_gocardless_dynamic_payment_before_schedule_amendments(uuid,uuid,jsonb)');
   END IF;
   IF position('public.gocardless_dynamic_collection_due_date(p.id,p_collection_number)' IN reserve_source)=0
     OR attach_source IS NULL OR position('public.gocardless_dynamic_collection_due_date(p.id,r.collection_number+1)' IN attach_source)=0
     OR to_regclass('public.gocardless_collection_day_amendments') IS NULL THEN
     RAISE EXCEPTION 'Installed amended financial cadence is inconsistent';
   END IF;
   EXECUTE 'SELECT public.gocardless_dynamic_collection_due_date($1,$2)' INTO result USING p.id,p_collection_number;
   RETURN result;
 END IF;
 IF position('((p.metadata->>''dynamic_first_date'')::date + make_interval(months => p_collection_number - 1))::date' IN reserve_source)=0
   OR position('((p.metadata->>''dynamic_first_date'')::date + make_interval(months => r.collection_number))::date' IN attach_source)=0
   OR p.metadata ? 'collection_schedule_version' THEN
   RAISE EXCEPTION 'Original financial cadence cannot ignore amendment or version evidence';
 END IF;
 IF to_regclass('public.gocardless_collection_day_amendments') IS NOT NULL THEN
   EXECUTE 'SELECT EXISTS(SELECT FROM public.gocardless_collection_day_amendments WHERE tenant_id=$1 AND plan_id=$2)'
     INTO evidence USING p_tenant_id,p_plan_id;
   IF evidence THEN RAISE EXCEPTION 'Original financial cadence cannot ignore amendment evidence'; END IF;
 END IF;
 IF p.metadata->>'dynamic_first_date' IS NULL THEN RAISE EXCEPTION 'Original financial cadence anchor missing'; END IF;
 -- EXACT 20261108 reservation expression, not JS month arithmetic or charge date.
 RETURN ((p.metadata->>'dynamic_first_date')::date + make_interval(months => p_collection_number - 1))::date;
END $$;
REVOKE ALL ON FUNCTION public.gocardless_manual_collection_due_date(uuid,uuid,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.gocardless_manual_collection_due_date(uuid,uuid,integer) TO service_role;

CREATE TABLE IF NOT EXISTS public.gocardless_manual_collection_authorizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL, plan_id uuid NOT NULL REFERENCES public.membership_payment_plans(id),
  agreement_id uuid NOT NULL, mandate_id text NOT NULL, environment text NOT NULL,
  identity jsonb NOT NULL,
  due_date date NOT NULL, collection_number integer NOT NULL CHECK(collection_number>0),
  amount_minor integer NOT NULL CHECK(amount_minor>0), currency text NOT NULL,
  charge_date date NOT NULL, idempotency_key text NOT NULL,
  actor text NOT NULL CHECK(length(trim(actor))>0),
  reason text NOT NULL CHECK(length(trim(reason)) BETWEEN 10 AND 500),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  authorization_month date NOT NULL DEFAULT date_trunc('month',clock_timestamp() AT TIME ZONE 'Europe/London')::date,
  expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '5 minutes',
  UNIQUE(tenant_id,plan_id,due_date), UNIQUE(tenant_id,plan_id,collection_number),
  UNIQUE(tenant_id,plan_id,authorization_month),
  CHECK(expires_at>created_at AND expires_at<=created_at+interval '6 minutes')
);
CREATE TABLE IF NOT EXISTS public.gocardless_manual_collection_revocations (
  authorization_id uuid PRIMARY KEY REFERENCES public.gocardless_manual_collection_authorizations(id),
  actor text NOT NULL, reason text NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE public.gocardless_manual_collection_authorizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.gocardless_manual_collection_revocations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.gocardless_manual_collection_authorizations,public.gocardless_manual_collection_revocations FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.gocardless_manual_collection_authorizations,public.gocardless_manual_collection_revocations TO service_role;

CREATE OR REPLACE FUNCTION public.guard_gocardless_manual_collection_audit()
RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN RAISE EXCEPTION 'Manual collection audit is immutable'; END $$;
DROP TRIGGER IF EXISTS manual_collection_audit_immutable ON public.gocardless_manual_collection_authorizations;
CREATE TRIGGER manual_collection_audit_immutable BEFORE UPDATE OR DELETE ON public.gocardless_manual_collection_authorizations
FOR EACH ROW EXECUTE FUNCTION public.guard_gocardless_manual_collection_audit();
DROP TRIGGER IF EXISTS manual_collection_revocation_immutable ON public.gocardless_manual_collection_revocations;
CREATE TRIGGER manual_collection_revocation_immutable BEFORE UPDATE OR DELETE ON public.gocardless_manual_collection_revocations
FOR EACH ROW EXECUTE FUNCTION public.guard_gocardless_manual_collection_audit();

CREATE OR REPLACE FUNCTION public.authorize_gocardless_manual_collection(
 p_tenant_id uuid,p_plan_id uuid,p_due_date date,p_collection_number integer,
 p_amount_minor integer,p_currency text,p_charge_date date,p_idempotency_key text,p_actor text,p_reason text,p_identity jsonb
) RETURNS public.gocardless_manual_collection_authorizations
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE p public.membership_payment_plans; a public.membership_billing_agreements;
 result public.gocardless_manual_collection_authorizations;
 today date := (clock_timestamp() AT TIME ZONE 'Europe/London')::date; n integer;
BEGIN
 SELECT * INTO p FROM public.membership_payment_plans WHERE tenant_id=p_tenant_id AND id=p_plan_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Manual collection plan not found'; END IF;
 SELECT * INTO a FROM public.membership_billing_agreements WHERE tenant_id=p_tenant_id AND id=p.billing_agreement_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Manual collection agreement not found'; END IF;
 SELECT COALESCE(max(collection_number),0)+1 INTO n FROM public.gocardless_collection_reservations WHERE tenant_id=p_tenant_id AND plan_id=p_plan_id;
 IF p.collection_stopped_at IS NOT NULL OR COALESCE(p.metadata->>'bnms_release_required','false')<>'false'
   OR p.status NOT IN ('active','mandate_pending','first_payment_pending') OR p.provider<>'gocardless'
   OR p.metadata->>'collection_mode' IS DISTINCT FROM 'dynamic'
   OR p.environment IS DISTINCT FROM a.environment OR p.environment NOT IN ('live','sandbox')
   OR p.gocardless_mandate_id IS DISTINCT FROM a.gocardless_mandate_id
   OR p_identity IS DISTINCT FROM jsonb_build_object('agreement',a.id,'member',a.member_id,'organization',a.organization_id,
      'mandate',a.gocardless_mandate_id,'environment',p.environment)
   OR p_due_date IS DISTINCT FROM p.dynamic_next_collection_date
   OR p_due_date IS DISTINCT FROM public.gocardless_manual_collection_due_date(p_tenant_id,p.id,p_collection_number)
   OR p_due_date<date_trunc('month',today)::date OR p_due_date>today+1
   OR p_collection_number IS DISTINCT FROM n
   OR p_charge_date<p_due_date OR p_charge_date>p_due_date+7 OR p_charge_date<today
   OR p_charge_date>(a.metadata#>>'{dd,commitment,term_end_date}')::date
   OR p_currency IS DISTINCT FROM a.metadata#>>'{dd,currency}'
   OR p_amount_minor IS NULL OR p_amount_minor<=0 OR length(p_idempotency_key)<>64
   OR p_actor IS NULL OR length(trim(p_actor))=0 OR p_reason IS NULL OR length(trim(p_reason)) NOT BETWEEN 10 AND 500
 THEN RAISE EXCEPTION 'Manual collection scope, period, hold or confirmation invalid'; END IF;
 INSERT INTO public.gocardless_manual_collection_authorizations(tenant_id,plan_id,agreement_id,mandate_id,environment,identity,
   due_date,collection_number,amount_minor,currency,charge_date,idempotency_key,actor,reason)
 VALUES(p_tenant_id,p.id,a.id,a.gocardless_mandate_id,p.environment,p_identity,p_due_date,p_collection_number,
   p_amount_minor,p_currency,p_charge_date,p_idempotency_key,p_actor,trim(p_reason)) RETURNING * INTO result;
 RETURN result;
END $$;

CREATE OR REPLACE FUNCTION public.revoke_gocardless_manual_collection(p_id uuid,p_actor text,p_reason text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE p_id_locked uuid;
BEGIN
 SELECT plan_id INTO p_id_locked FROM public.gocardless_manual_collection_authorizations WHERE id=p_id;
 PERFORM 1 FROM public.membership_payment_plans WHERE id=p_id_locked FOR UPDATE;
 IF p_id_locked IS NULL OR length(trim(COALESCE(p_actor,'')))=0 OR length(trim(COALESCE(p_reason,'')))<10 THEN
   RAISE EXCEPTION 'Authorization and revocation actor/reason required';
 END IF;
 INSERT INTO public.gocardless_manual_collection_revocations(authorization_id,actor,reason) VALUES(p_id,p_actor,p_reason);
END $$;

-- Acceptance linearizes at the existing plan-locked reservation INSERT. After
-- acceptance, expiry/revocation cannot strand provider evidence attachment.
CREATE OR REPLACE FUNCTION public.gocardless_manual_reservation_authorized(
 r public.gocardless_collection_reservations, persisted boolean
) RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT EXISTS(
  SELECT 1 FROM public.gocardless_manual_collection_authorizations m
  JOIN public.membership_payment_plans p ON p.id=m.plan_id AND p.tenant_id=m.tenant_id
  JOIN public.membership_billing_agreements a ON a.id=m.agreement_id AND a.tenant_id=m.tenant_id
  WHERE m.id::text=r.provider_evidence->>'manual_authorization_id'
    AND m.tenant_id=r.tenant_id AND m.plan_id=r.plan_id AND m.agreement_id=r.billing_agreement_id
    AND m.mandate_id=p.gocardless_mandate_id AND m.environment=p.environment
    AND m.identity=jsonb_build_object('agreement',a.id,'member',a.member_id,'organization',a.organization_id,
      'mandate',a.gocardless_mandate_id,'environment',a.environment)
    AND m.due_date=r.due_date AND m.collection_number=r.collection_number
    AND m.amount_minor=r.amount_minor AND m.currency=r.currency
    AND m.charge_date=r.requested_charge_date AND m.idempotency_key=r.idempotency_key
    AND (r.provider_evidence->>'checked_at')::timestamptz BETWEEN m.created_at-interval '15 minutes' AND m.expires_at
    AND (r.provider_evidence->>'checked_at')::timestamptz<=clock_timestamp()
    AND (
      (NOT persisted AND clock_timestamp()<=m.expires_at
       AND p.collection_stopped_at IS NULL AND COALESCE(p.metadata->>'bnms_release_required','false')='false'
       AND NOT EXISTS(SELECT FROM public.gocardless_manual_collection_revocations v WHERE v.authorization_id=m.id))
      OR (persisted AND EXISTS(SELECT FROM public.gocardless_collection_reservations old
       WHERE old.id=r.id AND old.tenant_id=r.tenant_id AND old.plan_id=r.plan_id
        AND old.provider_evidence->>'manual_authorization_id'=m.id::text
        AND old.provider_evidence->>'checked_at'=r.provider_evidence->>'checked_at'
        AND old.due_date=r.due_date AND old.amount_minor=r.amount_minor AND old.currency=r.currency
        AND old.idempotency_key=r.idempotency_key AND old.requested_charge_date=r.requested_charge_date))
    )
 );
$$;
CREATE OR REPLACE FUNCTION public.gocardless_manual_payment_authorized(
 p_tenant uuid,p_plan uuid,p_payment text,p_amount integer,p_currency text,p_date date
) RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT EXISTS(SELECT FROM public.gocardless_collection_reservations r
  WHERE r.tenant_id=p_tenant AND r.plan_id=p_plan AND r.gocardless_payment_id=p_payment
    AND r.amount_minor=p_amount AND r.currency=p_currency AND r.requested_charge_date=p_date
    AND public.gocardless_manual_reservation_authorized(r,true));
$$;
CREATE OR REPLACE FUNCTION public.guard_gocardless_manual_reservation()
RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF TG_OP='UPDATE' AND NEW.provider_evidence->>'manual_authorization_id'
   IS DISTINCT FROM OLD.provider_evidence->>'manual_authorization_id' THEN
   RAISE EXCEPTION 'Manual authorization binding is immutable';
 END IF;
 IF NEW.provider_evidence ? 'manual_authorization_id'
   AND NOT public.gocardless_manual_reservation_authorized(NEW,TG_OP='UPDATE') THEN
   RAISE EXCEPTION 'Manual collection authorization expired, revoked or mismatched';
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS guard_gocardless_manual_reservation ON public.gocardless_collection_reservations;
CREATE TRIGGER guard_gocardless_manual_reservation BEFORE INSERT OR UPDATE ON public.gocardless_collection_reservations
FOR EACH ROW EXECUTE FUNCTION public.guard_gocardless_manual_reservation();

-- As with the existing cadence migration, replace ONLY known timing clauses.
-- Unexpected source drift is a transactional failure; never install a broad
-- trigger bypass. The runner pins the complete reviewed migration hash.
CREATE OR REPLACE FUNCTION pg_temp.patch_manual_collection_gate(fn regprocedure, old_text text, new_text text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE source text;
BEGIN
 SELECT pg_get_functiondef(fn) INTO source;
 IF position(new_text IN source)>0 THEN RETURN; END IF;
 IF (length(source)-length(replace(source,old_text,'')))/length(old_text)<>1 THEN
   RAISE EXCEPTION 'Unexpected manual collection guard source: %',fn;
 END IF;
 EXECUTE replace(source,old_text,new_text);
END $$;
DO $migration$
DECLARE fn text; gate text; evidence text; predicate text;
BEGIN
 FOREACH fn IN ARRAY ARRAY['bnms_dd_beta_hold_guard','bnms_dd_alpha_hold_guard','bnms_dd_guard_initial_reservation','bnms_manual_reservation_gate'] LOOP
   IF fn IN ('bnms_dd_beta_hold_guard','bnms_dd_alpha_hold_guard') THEN
     gate:='clock_timestamp()<released.processing_not_before';
     evidence:='(NEW.provider_evidence->>''checked_at'')::timestamptz<released.processing_not_before';
   ELSIF fn='bnms_dd_guard_initial_reservation' THEN
     gate:='clock_timestamp() < TIMESTAMPTZ ''2026-10-01 00:00:00 Europe/London''';
     evidence:='(NEW.provider_evidence->>''checked_at'')::timestamptz < TIMESTAMPTZ ''2026-10-01 00:00:00 Europe/London''';
   ELSE
     gate:='clock_timestamp()<r.processing_not_before';
     evidence:='checked_at<r.processing_not_before';
   END IF;
   predicate:=' AND NOT public.gocardless_manual_reservation_authorized(NEW,TG_OP=''UPDATE'')';
   PERFORM pg_temp.patch_manual_collection_gate(('public.'||fn||'()')::regprocedure,gate,'('||gate||predicate||')');
   PERFORM pg_temp.patch_manual_collection_gate(('public.'||fn||'()')::regprocedure,evidence,'('||evidence||predicate||')');
 END LOOP;
 PERFORM pg_temp.patch_manual_collection_gate('public.bnms_dd_alpha_protect_payment()'::regprocedure,
   'clock_timestamp()<TIMESTAMPTZ ''2026-10-01 00:00:00 Europe/London''',
   '(clock_timestamp()<TIMESTAMPTZ ''2026-10-01 00:00:00 Europe/London'' AND NOT public.gocardless_manual_payment_authorized(NEW.tenant_id,a.plan_id,NEW.gocardless_payment_id,NEW.amount_minor,NEW.currency,NEW.charge_date))');
 PERFORM pg_temp.patch_manual_collection_gate('public.bnms_manual_payment_guard()'::regprocedure,
   'clock_timestamp()<''2026-10-01 00:00:00 Europe/London''::timestamptz',
   '(clock_timestamp()<''2026-10-01 00:00:00 Europe/London''::timestamptz AND NOT public.gocardless_manual_payment_authorized(NEW.tenant_id,NEW.plan_id,NEW.gocardless_payment_id,NEW.amount_minor,NEW.currency,NEW.charge_date))');
 -- The canonical reservation function checks lifecycle and consent before this
 -- return. Bind a manual caller even on a racing existing-row return.
 PERFORM pg_temp.patch_manual_collection_gate(
   'public.reserve_gocardless_dynamic_collection(uuid,uuid,integer,date,jsonb,jsonb,text)'::regprocedure,
   'IF FOUND THEN RETURN r; END IF;',
   'IF FOUND THEN
     IF p_provider_evidence ? ''manual_authorization_id'' AND (
       p_provider_evidence->>''manual_authorization_id'' IS DISTINCT FROM r.provider_evidence->>''manual_authorization_id''
       OR p_due_date IS DISTINCT FROM r.due_date OR p_idempotency_key IS DISTINCT FROM r.idempotency_key
       OR (p_price_snapshot->>''monthly_amount_minor'')::integer IS DISTINCT FROM r.amount_minor
       OR p_price_snapshot->>''currency'' IS DISTINCT FROM r.currency
       OR NOT public.gocardless_manual_reservation_authorized(r,true)) THEN
       RAISE EXCEPTION ''Manual collection existing reservation conflict'';
     END IF;
     RETURN r;
   END IF;');
END $migration$;

REVOKE ALL ON FUNCTION public.authorize_gocardless_manual_collection(uuid,uuid,date,integer,integer,text,date,text,text,text,jsonb),
 public.revoke_gocardless_manual_collection(uuid,text,text),
 public.gocardless_manual_reservation_authorized(public.gocardless_collection_reservations,boolean),
 public.gocardless_manual_payment_authorized(uuid,uuid,text,integer,text,date),
 public.guard_gocardless_manual_reservation(),public.guard_gocardless_manual_collection_audit()
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.authorize_gocardless_manual_collection(uuid,uuid,date,integer,integer,text,date,text,text,text,jsonb),
 public.revoke_gocardless_manual_collection(uuid,text,text),
 public.gocardless_manual_reservation_authorized(public.gocardless_collection_reservations,boolean),
 public.gocardless_manual_payment_authorized(uuid,uuid,text,integer,text,date)
 TO service_role;