-- Operational amendments only; never rewrite the purchased consent snapshot.
CREATE TABLE IF NOT EXISTS public.gocardless_collection_day_amendments (
  request_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  plan_id uuid NOT NULL REFERENCES public.membership_payment_plans(id),
  day integer NOT NULL CHECK (day BETWEEN 1 AND 28),
  version integer NOT NULL,
  previous_anchor date NOT NULL,
  proposed_anchor date NOT NULL,
  effective_date date NOT NULL,
  reservation_count integer NOT NULL,
  next_confirmed_date date,
  actor_email text,
  created_at timestamptz NOT NULL DEFAULT now(),
  applied_at timestamptz
);
ALTER TABLE public.gocardless_collection_day_amendments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.gocardless_collection_day_amendments FROM PUBLIC,anon,authenticated;
REVOKE ALL ON public.gocardless_collection_day_amendments FROM service_role;
GRANT SELECT,INSERT,UPDATE ON public.gocardless_collection_day_amendments TO service_role;

-- An applied boundary is part of the financial schedule evidence forever.
CREATE OR REPLACE FUNCTION public.guard_gocardless_collection_day_amendment()
RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$
BEGIN
  IF TG_OP='DELETE' OR OLD.applied_at IS NOT NULL
    OR (to_jsonb(NEW)-'applied_at') IS DISTINCT FROM (to_jsonb(OLD)-'applied_at') THEN
    RAISE EXCEPTION 'Collection schedule amendment evidence is immutable';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS guard_collection_day_amendment ON public.gocardless_collection_day_amendments;
CREATE TRIGGER guard_collection_day_amendment BEFORE UPDATE OR DELETE ON public.gocardless_collection_day_amendments
  FOR EACH ROW EXECUTE FUNCTION public.guard_gocardless_collection_day_amendment();

CREATE OR REPLACE FUNCTION public.change_gocardless_collection_day(
  p_tenant_id uuid,p_plan_id uuid,p_request_id uuid,p_day integer,
  p_confirm boolean,p_notice_date date,p_actor_email text
) RETURNS public.gocardless_collection_day_amendments
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE
  p public.membership_payment_plans;
  a public.membership_billing_agreements;
  amendment public.gocardless_collection_day_amendments;
  owner_row jsonb;
  terms jsonb;
  n integer;
  v integer;
  anchor date;
  effective date;
BEGIN
  -- Same plan lock as reserve_gocardless_dynamic_collection. A durable reserved
  -- row fences the entire external call, including ambiguous/crashed outcomes.
  SELECT * INTO p FROM public.membership_payment_plans
    WHERE id=p_plan_id AND tenant_id=p_tenant_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Plan not found in tenant'; END IF;
  SELECT * INTO a FROM public.membership_billing_agreements
    WHERE id=p.billing_agreement_id AND tenant_id=p_tenant_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Agreement not found in tenant'; END IF;
  SELECT * INTO amendment FROM public.gocardless_collection_day_amendments
    WHERE request_id=p_request_id;
  IF FOUND THEN
    IF amendment.tenant_id IS DISTINCT FROM p_tenant_id OR amendment.plan_id IS DISTINCT FROM p_plan_id
      OR amendment.day IS DISTINCT FROM p_day THEN RAISE EXCEPTION 'Request identity conflict'; END IF;
    IF amendment.applied_at IS NOT NULL THEN RETURN amendment; END IF;
  ELSIF p_confirm THEN RAISE EXCEPTION 'Preview not found'; END IF;
  IF p_day IS NULL OR p_day NOT BETWEEN 1 AND 28
    OR p_notice_date IS NULL OR p_notice_date < current_date THEN RAISE EXCEPTION 'Invalid day or provider notice date'; END IF;
  terms := a.metadata->'dd';
  IF a.member_id IS NOT NULL AND a.organization_id IS NULL THEN
    SELECT to_jsonb(m) INTO owner_row FROM public.member m WHERE id=a.member_id AND tenant_id=p_tenant_id FOR UPDATE;
  ELSIF a.organization_id IS NOT NULL AND a.member_id IS NULL THEN
    SELECT to_jsonb(o) INTO owner_row FROM public.organization o WHERE id=a.organization_id AND tenant_id=p_tenant_id FOR UPDATE;
  END IF;
  IF owner_row IS NULL OR COALESCE((owner_row->>'membership_paused')::boolean,false)
    OR owner_row->>'status' IN ('cancelled','deleted','paused','inactive')
    OR (p.member_id IS NOT NULL AND p.member_id IS DISTINCT FROM a.member_id)
    OR (p.organization_id IS NOT NULL AND p.organization_id IS DISTINCT FROM a.organization_id)
    OR a.provider IS DISTINCT FROM 'gocardless'
    OR p.status NOT IN ('active','mandate_pending','first_payment_pending')
    OR a.status NOT IN ('active','mandate_pending','first_payment_pending')
    OR p.status IS NULL OR a.status IS NULL
    OR p.metadata->>'catch_up_intent' IS NOT NULL
    OR a.metadata->'bnms_pilot_approval' IS NOT NULL
    OR p.collection_stopped_at IS NOT NULL OR p.gocardless_subscription_id IS NOT NULL
    OR p.gocardless_mandate_id IS DISTINCT FROM a.gocardless_mandate_id
    OR a.gocardless_mandate_id IS NULL
    OR terms->'collection_policy'->>'version' IS DISTINCT FROM '1'
    OR terms->'collection_policy'->>'pricing_policy' IS DISTINCT FROM 'dynamic'
    OR terms->>'invoicing_mode' IS DISTINCT FROM 'per_instalment'
    OR p.metadata->>'collection_mode' IS DISTINCT FROM 'dynamic'
    OR p.dynamic_next_collection_date IS NULL
    OR terms->>'arrears_state' IS NOT NULL
    OR EXISTS(SELECT 1 FROM public.membership_monthly_arrears_period WHERE plan_id=p.id AND tenant_id=p_tenant_id AND settled_at IS NULL)
    OR EXISTS(SELECT 1 FROM public.gocardless_collection_reservations WHERE plan_id=p.id AND status <> 'submitted')
  THEN RAISE EXCEPTION 'Schedule change blocked by ownership, lifecycle, arrears or unresolved collection; review required'; END IF;
  SELECT count(*) INTO n FROM public.gocardless_collection_reservations WHERE plan_id=p.id;
  v := COALESCE((p.metadata->>'collection_schedule_version')::integer,0);
  anchor := (date_trunc('month',(p.metadata->>'dynamic_first_date')::date) + make_interval(days=>p_day-1))::date;
  effective := (anchor + make_interval(months=>n))::date;
  IF anchor IS NULL OR terms->'commitment'->>'term_end_date' IS NULL
    OR terms->'commitment'->>'term_start_date' IS NULL OR terms->>'instalment_count' IS NULL
    OR n >= (terms->>'instalment_count')::integer
    OR effective < greatest(current_date,p_notice_date,(terms->'commitment'->>'term_start_date')::date)
    OR (anchor + make_interval(months=>(terms->>'instalment_count')::integer-1))::date > (terms->'commitment'->>'term_end_date')::date
    OR EXISTS(SELECT 1 FROM public.gocardless_collection_reservations WHERE plan_id=p.id AND requested_charge_date >= effective)
  THEN RAISE EXCEPTION 'New day misses the notice window or cannot preserve the remaining term obligations'; END IF;
  IF p_confirm THEN
    IF amendment.created_at < now()-interval '10 minutes'
      OR amendment.version <> v OR amendment.reservation_count <> n
      OR amendment.previous_anchor IS DISTINCT FROM (p.metadata->>'dynamic_first_date')::date
      OR amendment.effective_date IS DISTINCT FROM effective
    THEN RAISE EXCEPTION 'Schedule changed or preview expired; preview again'; END IF;
    UPDATE public.membership_payment_plans SET
      metadata=metadata || jsonb_build_object('dynamic_first_date',anchor::text,'collection_schedule_version',v+1),
      dynamic_next_collection_date=effective,dynamic_next_check_at=NULL,updated_at=now()
      WHERE id=p.id;
    UPDATE public.gocardless_collection_day_amendments SET applied_at=now()
      WHERE request_id=p_request_id RETURNING * INTO amendment;
  ELSE
    INSERT INTO public.gocardless_collection_day_amendments(request_id,tenant_id,plan_id,day,version,
      previous_anchor,proposed_anchor,effective_date,reservation_count,next_confirmed_date,actor_email)
    VALUES(p_request_id,p_tenant_id,p.id,p_day,v,(p.metadata->>'dynamic_first_date')::date,anchor,effective,n,
      (SELECT min(charge_date) FROM public.gocardless_payments WHERE plan_id=p.id AND tenant_id=p_tenant_id
        AND status IN ('pending_customer_approval','pending_submission','submitted') AND charge_date>=current_date),p_actor_email)
    RETURNING * INTO amendment;
  END IF;
  RETURN amendment;
END $$;
REVOKE ALL ON FUNCTION public.change_gocardless_collection_day(uuid,uuid,uuid,integer,boolean,date,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.change_gocardless_collection_day(uuid,uuid,uuid,integer,boolean,date,text) TO service_role;

-- Attachment/replay must obtain the plan lock BEFORE reading its operational
-- anchor. Otherwise an old webhook could overwrite an amendment's next date.
DO $$ BEGIN
  IF to_regprocedure('public.attach_gocardless_dynamic_payment_before_schedule_amendments(uuid,uuid,jsonb)') IS NULL THEN
    ALTER FUNCTION public.attach_gocardless_dynamic_payment(uuid,uuid,jsonb) RENAME TO attach_gocardless_dynamic_payment_before_schedule_amendments;
  END IF;
END $$;
REVOKE ALL ON FUNCTION public.attach_gocardless_dynamic_payment_before_schedule_amendments(uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role;
CREATE OR REPLACE FUNCTION public.attach_gocardless_dynamic_payment(p_tenant_id uuid,p_reservation_id uuid,p_payment jsonb)
RETURNS public.gocardless_collection_reservations
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE target_plan uuid;
BEGIN
  SELECT plan_id INTO target_plan FROM public.gocardless_collection_reservations
    WHERE id=p_reservation_id AND tenant_id=p_tenant_id;
  PERFORM 1 FROM public.membership_payment_plans WHERE id=target_plan AND tenant_id=p_tenant_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Reservation plan not found'; END IF;
  RETURN public.attach_gocardless_dynamic_payment_before_schedule_amendments(p_tenant_id,p_reservation_id,p_payment);
END $$;
REVOKE ALL ON FUNCTION public.attach_gocardless_dynamic_payment(uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.attach_gocardless_dynamic_payment(uuid,uuid,jsonb) TO service_role;

-- Collection numbers <= an amendment's reservation_count retain the preceding
-- anchor. Later numbers use that amendment until another applied boundary.
-- This is not permission to accept arbitrary reservation dates: the complete
-- immutable version chain and latest operational anchor must agree first.
CREATE OR REPLACE FUNCTION public.gocardless_dynamic_collection_due_date(
  p_plan_id uuid,p_collection_number integer
) RETURNS date LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public AS $$
DECLARE
  p public.membership_payment_plans;
  amendment public.gocardless_collection_day_amendments;
  anchor date;
  expected_anchor date;
  v integer := 0;
  boundary integer := 0;
BEGIN
  SELECT * INTO p FROM public.membership_payment_plans WHERE id=p_plan_id;
  IF NOT FOUND OR p_collection_number IS NULL OR p_collection_number < 1 THEN
    RAISE EXCEPTION 'Invalid dynamic collection schedule lookup';
  END IF;
  FOR amendment IN SELECT * FROM public.gocardless_collection_day_amendments
    WHERE plan_id=p.id AND tenant_id=p.tenant_id AND applied_at IS NOT NULL ORDER BY version
  LOOP
    IF v=0 THEN anchor:=amendment.previous_anchor; expected_anchor:=anchor; END IF;
    IF amendment.version <> v OR amendment.previous_anchor IS DISTINCT FROM expected_anchor
      OR amendment.reservation_count < boundary
      OR date_trunc('month',amendment.proposed_anchor) IS DISTINCT FROM date_trunc('month',amendment.previous_anchor)
      OR extract(day FROM amendment.proposed_anchor) <> amendment.day
      OR amendment.effective_date IS DISTINCT FROM
        (amendment.proposed_anchor+make_interval(months=>amendment.reservation_count))::date THEN
      RAISE EXCEPTION 'Dynamic collection amendment chain is invalid';
    END IF;
    IF p_collection_number > amendment.reservation_count THEN anchor:=amendment.proposed_anchor; END IF;
    expected_anchor:=amendment.proposed_anchor;
    boundary:=amendment.reservation_count;
    v:=v+1;
  END LOOP;
  IF v=0 THEN anchor:=(p.metadata->>'dynamic_first_date')::date; expected_anchor:=anchor; END IF;
  IF COALESCE((p.metadata->>'collection_schedule_version')::integer,0) <> v
    OR (p.metadata->>'dynamic_first_date')::date IS DISTINCT FROM expected_anchor OR anchor IS NULL THEN
    RAISE EXCEPTION 'Dynamic collection schedule evidence is incomplete';
  END IF;
  RETURN (anchor+make_interval(months=>p_collection_number-1))::date;
END $$;
REVOKE ALL ON FUNCTION public.gocardless_dynamic_collection_due_date(uuid,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.gocardless_dynamic_collection_due_date(uuid,integer) TO service_role;

-- Patch only the three date expressions of the original completion predicate.
-- Every mandate, currency, amount, status, owner, count and term check remains
-- byte-for-byte intact. Fail on unexpected upstream drift rather than silently
-- weakening or replacing those financial-evidence checks.
DO $$
DECLARE definition text;
BEGIN
  SELECT pg_get_functiondef('public.complete_gocardless_dynamic_term(uuid,uuid)'::regprocedure) INTO definition;
  IF position('public.gocardless_dynamic_collection_due_date' IN definition)=0 THEN
    IF position('first_date := (p.metadata->>''dynamic_first_date'')::date;' IN definition)=0
      OR position('(first_date+make_interval(months=>n-1))::date' IN definition)=0
      OR position('(first_date+make_interval(months=>r.collection_number-1))::date' IN definition)=0 THEN
      RAISE EXCEPTION 'Unexpected dynamic completion function; review schedule-history integration';
    END IF;
    definition:=replace(definition,'first_date := (p.metadata->>''dynamic_first_date'')::date;',
      'first_date := public.gocardless_dynamic_collection_due_date(p.id,1);');
    definition:=replace(definition,'(first_date+make_interval(months=>n-1))::date',
      'public.gocardless_dynamic_collection_due_date(p.id,n)');
    definition:=replace(definition,'(first_date+make_interval(months=>r.collection_number-1))::date',
      'public.gocardless_dynamic_collection_due_date(p.id,r.collection_number)');
    EXECUTE definition;
  END IF;
  SELECT pg_get_functiondef('public.reserve_gocardless_dynamic_collection(uuid,uuid,integer,date,jsonb,jsonb,text)'::regprocedure) INTO definition;
  IF position('public.gocardless_dynamic_collection_due_date' IN definition)=0 THEN
    IF position('((p.metadata->>''dynamic_first_date'')::date + make_interval(months => p_collection_number - 1))::date' IN definition)=0 THEN
      RAISE EXCEPTION 'Unexpected dynamic reservation function; review schedule-history integration';
    END IF;
    EXECUTE replace(definition,
      '((p.metadata->>''dynamic_first_date'')::date + make_interval(months => p_collection_number - 1))::date',
      'public.gocardless_dynamic_collection_due_date(p.id,p_collection_number)');
  END IF;
  SELECT pg_get_functiondef('public.attach_gocardless_dynamic_payment_before_schedule_amendments(uuid,uuid,jsonb)'::regprocedure) INTO definition;
  IF position('public.gocardless_dynamic_collection_due_date' IN definition)=0 THEN
    IF position('((p.metadata->>''dynamic_first_date'')::date + make_interval(months => r.collection_number))::date' IN definition)=0 THEN
      RAISE EXCEPTION 'Unexpected dynamic attachment function; review schedule-history integration';
    END IF;
    EXECUTE replace(definition,
      '((p.metadata->>''dynamic_first_date'')::date + make_interval(months => r.collection_number))::date',
      'public.gocardless_dynamic_collection_due_date(p.id,r.collection_number+1)');
  END IF;
END $$;