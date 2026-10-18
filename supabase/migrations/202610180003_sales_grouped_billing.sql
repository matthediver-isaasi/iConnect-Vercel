-- Task 5152 core. No retroactive schedule creation or external effects.
BEGIN;
SET LOCAL lock_timeout='5s';
ALTER TABLE public.sales_quote_version ADD COLUMN IF NOT EXISTS billing_schedule jsonb;

-- Preserve all installed draft/acceptance hardening; fail on an unknown RPC.
DO $migration$
DECLARE definition text; anchor text := 'UPDATE public.sales_quote_version SET net_minor=calc_net,tax_minor=calc_tax,gross_minor=calc_gross WHERE id=v.id;';
BEGIN
 SELECT pg_get_functiondef('public.save_sales_quote_draft(uuid,uuid,integer,jsonb,text,text)'::regprocedure) INTO definition;
 IF position('billing_schedule=NULLIF(p_payload' IN definition)=0 THEN
   IF position(anchor IN definition)=0 THEN RAISE EXCEPTION 'Unknown save_sales_quote_draft implementation'; END IF;
   EXECUTE replace(definition,anchor,
     'UPDATE public.sales_quote_version SET net_minor=calc_net,tax_minor=calc_tax,gross_minor=calc_gross,billing_schedule=NULLIF(p_payload->''billingSchedule'',''null''::jsonb) WHERE id=v.id;');
 END IF;
END $migration$;

CREATE TABLE IF NOT EXISTS public.sales_invoice_schedule (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 sale_id uuid NOT NULL, quote_version_id uuid NOT NULL, group_id uuid NOT NULL,
 snapshot jsonb NOT NULL, planned_issue_date date NOT NULL, timezone text NOT NULL,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','blocked','queued','invoiced','no_invoice_required','attention')),
 issue_date date, due_date date, accounting_request_id uuid, provider text, provider_company_id text,
 last_error jsonb, next_attempt_at timestamptz NOT NULL DEFAULT now(),
 delivery_status text NOT NULL DEFAULT 'pending' CHECK(delivery_status IN ('pending','sending','sent','rejected','attention')),
 delivery_claim_token uuid, delivery_claimed_at timestamptz, delivery_message_id text, delivered_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id), UNIQUE(tenant_id,quote_version_id,group_id),
 FOREIGN KEY(tenant_id,sale_id) REFERENCES public.sales_commercial_sale(tenant_id,id),
 FOREIGN KEY(tenant_id,quote_version_id) REFERENCES public.sales_quote_version(tenant_id,id),
 CHECK(jsonb_typeof(snapshot)='object'),
 CHECK((issue_date IS NULL AND due_date IS NULL) OR (issue_date IS NOT NULL AND due_date>=issue_date))
);
CREATE INDEX IF NOT EXISTS sales_invoice_schedule_due ON public.sales_invoice_schedule(next_attempt_at,planned_issue_date,tenant_id,id)
 WHERE status IN ('pending','blocked');
ALTER TABLE public.sales_invoice_schedule ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.sales_invoice_schedule FROM PUBLIC,anon,authenticated;
REVOKE DELETE,TRUNCATE ON public.sales_invoice_schedule FROM service_role;
GRANT SELECT,INSERT,UPDATE ON public.sales_invoice_schedule TO service_role;
DROP POLICY IF EXISTS sales_invoice_schedule_service ON public.sales_invoice_schedule;
CREATE POLICY sales_invoice_schedule_service ON public.sales_invoice_schedule TO service_role USING(true) WITH CHECK(true);

CREATE OR REPLACE FUNCTION public.validate_sales_billing_schedule() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE g jsonb; n numeric:=0; t numeric:=0; seen uuid[]:='{}'; gid uuid;
BEGIN
 IF TG_OP='INSERT' AND NEW.version_number>1 AND NEW.billing_schedule IS NULL THEN
   SELECT billing_schedule INTO NEW.billing_schedule FROM public.sales_quote_version
     WHERE tenant_id=NEW.tenant_id AND quote_id=NEW.quote_id AND version_number=NEW.version_number-1;
 END IF;
 IF NEW.billing_schedule IS NULL THEN RETURN NEW; END IF;
 IF jsonb_typeof(NEW.billing_schedule->'groups') IS DISTINCT FROM 'array'
   OR jsonb_array_length(NEW.billing_schedule->'groups')=0
   OR NOT EXISTS(SELECT 1 FROM pg_timezone_names WHERE name=NEW.billing_schedule->>'timezone')
 THEN RAISE EXCEPTION 'Invalid billing schedule' USING ERRCODE='23514'; END IF;
 FOR g IN SELECT value FROM jsonb_array_elements(NEW.billing_schedule->'groups') LOOP
   gid:=(g->>'id')::uuid;
   IF gid IS NULL OR gid=ANY(seen) OR g->>'currency' IS DISTINCT FROM NEW.currency
      OR (g->>'netMinor')::numeric IS NULL OR (g->>'taxMinor')::numeric IS NULL
      OR (g->>'netMinor')::numeric<0 OR (g->>'taxMinor')::numeric<0
      OR (g->>'grossMinor')::numeric IS DISTINCT FROM (g->>'netMinor')::numeric+(g->>'taxMinor')::numeric
      OR (g->'paymentTerms'->>'days') IS NULL OR (g->'paymentTerms'->>'days') !~ '^[0-9]+$'
      OR g->'timing'->>'kind' IS NULL
      OR g->'timing'->>'kind' NOT IN ('acceptance','fixed')
      OR (g->'timing'->>'kind'='acceptance' AND COALESCE(g->'timing'->>'days','') !~ '^[0-9]+$')
      OR (g->'timing'->>'kind'='fixed' AND (g->'timing'->>'date' IS NULL OR
        to_char((g->'timing'->>'date')::date,'YYYY-MM-DD')<>g->'timing'->>'date'))
   THEN RAISE EXCEPTION 'Invalid billing group' USING ERRCODE='23514'; END IF;
   seen:=array_append(seen,gid); n:=n+(g->>'netMinor')::numeric; t:=t+(g->>'taxMinor')::numeric;
 END LOOP;
 IF n<>NEW.net_minor OR t<>NEW.tax_minor THEN RAISE EXCEPTION 'Schedule does not reconcile to quote' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS sales_billing_schedule_validate ON public.sales_quote_version;
CREATE TRIGGER sales_billing_schedule_validate BEFORE INSERT OR UPDATE OF billing_schedule,status
 ON public.sales_quote_version FOR EACH ROW EXECUTE FUNCTION public.validate_sales_billing_schedule();

-- The sale is inserted by the authoritative conversion RPC; defer until the
-- transaction has transitioned the version, then use its acceptance history.
CREATE OR REPLACE FUNCTION public.activate_sales_invoice_schedule() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v public.sales_quote_version%ROWTYPE; g jsonb; accepted timestamptz; zone text; planned date;
BEGIN
 SELECT * INTO v FROM public.sales_quote_version WHERE tenant_id=NEW.tenant_id AND id=NEW.quote_version_id;
 IF v.billing_schedule IS NULL THEN RETURN NEW; END IF;
 SELECT min(created_at) INTO accepted FROM public.sales_quote_status_history
   WHERE tenant_id=NEW.tenant_id AND quote_version_id=v.id AND to_status='accepted';
 IF v.status NOT IN ('accepted','converted') OR accepted IS NULL THEN
   RAISE EXCEPTION 'Scheduled invoices require durable acceptance' USING ERRCODE='23514';
 END IF;
 zone:=v.billing_schedule->>'timezone';
 FOR g IN SELECT value FROM jsonb_array_elements(v.billing_schedule->'groups') LOOP
   planned:=CASE WHEN g->'timing'->>'kind'='fixed' THEN (g->'timing'->>'date')::date
     ELSE (accepted AT TIME ZONE zone)::date+(g->'timing'->>'days')::integer END;
   INSERT INTO public.sales_invoice_schedule(tenant_id,sale_id,quote_version_id,group_id,snapshot,planned_issue_date,timezone,status)
   VALUES(NEW.tenant_id,NEW.id,v.id,(g->>'id')::uuid,
     g||jsonb_build_object('recipient',v.billing_schedule->'recipient','acceptedAt',accepted,
       'timezone',zone,'timezoneFallback',v.billing_schedule->'timezoneFallback'),
     planned,zone,CASE WHEN (g->>'grossMinor')::bigint=0 THEN 'no_invoice_required' ELSE 'pending' END)
   ON CONFLICT(tenant_id,quote_version_id,group_id) DO NOTHING;
 END LOOP;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS sales_invoice_schedule_acceptance ON public.sales_commercial_sale;
CREATE CONSTRAINT TRIGGER sales_invoice_schedule_acceptance AFTER INSERT ON public.sales_commercial_sale
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.activate_sales_invoice_schedule();

-- Public decisions already convert in their acceptance transaction. Give staff
-- scheduled acceptance the same durable boundary rather than a browser follow-up.
-- Legacy unscheduled staff acceptance retains its existing separate confirmation.
DO $migration$
DECLARE definition text; anchor text :=
 'RETURN jsonb_build_object(''id'',q.id,''row_version'',q.row_version,''status'',p_status);';
BEGIN
 SELECT pg_get_functiondef('public.transition_sales_quote(uuid,uuid,integer,text,text,text,text)'::regprocedure) INTO definition;
 IF position('staff-scheduled-acceptance:' IN definition)=0 THEN
   IF position(anchor IN definition)=0 THEN RAISE EXCEPTION 'Unknown transition_sales_quote implementation'; END IF;
   EXECUTE replace(definition,anchor,$replacement$
 IF p_status='accepted' AND v.billing_schedule IS NOT NULL THEN
   PERFORM public.confirm_sales_quote_sale(p_tenant_id,q.id,q.row_version,
     'staff-scheduled-acceptance:'||v.id::text,p_actor_type,p_actor_id::uuid);
   SELECT * INTO q FROM public.sales_quote WHERE tenant_id=p_tenant_id AND id=q.id;
   RETURN jsonb_build_object('id',q.id,'row_version',q.row_version,'status','converted');
 END IF;
 RETURN jsonb_build_object('id',q.id,'row_version',q.row_version,'status',p_status);
 $replacement$);
 END IF;
END $migration$;

CREATE OR REPLACE FUNCTION public.guard_sales_invoice_schedule() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE v public.sales_quote_version%ROWTYPE; s public.sales_commercial_sale%ROWTYPE; g jsonb;
 accepted timestamptz; planned date; zone text;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Schedules cannot be deleted' USING ERRCODE='23514'; END IF;
 IF TG_OP='UPDATE' AND (NEW.tenant_id,NEW.sale_id,NEW.quote_version_id,NEW.group_id,NEW.snapshot,NEW.planned_issue_date,NEW.timezone)
   IS DISTINCT FROM (OLD.tenant_id,OLD.sale_id,OLD.quote_version_id,OLD.group_id,OLD.snapshot,OLD.planned_issue_date,OLD.timezone)
 THEN RAISE EXCEPTION 'Billing source snapshots are immutable' USING ERRCODE='23514'; END IF;
 IF TG_OP='UPDATE' AND OLD.issue_date IS NOT NULL AND (NEW.issue_date,NEW.due_date) IS DISTINCT FROM (OLD.issue_date,OLD.due_date)
 THEN RAISE EXCEPTION 'Invoice dates are frozen' USING ERRCODE='23514'; END IF;
 SELECT * INTO s FROM public.sales_commercial_sale WHERE tenant_id=NEW.tenant_id AND id=NEW.sale_id;
 SELECT * INTO v FROM public.sales_quote_version WHERE tenant_id=NEW.tenant_id AND id=NEW.quote_version_id;
 IF s.quote_version_id IS DISTINCT FROM NEW.quote_version_id OR v.status NOT IN ('accepted','converted')
   OR v.billing_schedule IS NULL
   OR NOT EXISTS(SELECT 1 FROM public.sales_quote_status_history WHERE tenant_id=NEW.tenant_id AND quote_version_id=v.id AND to_status='accepted')
 THEN RAISE EXCEPTION 'Schedule source is not accepted' USING ERRCODE='23514'; END IF;
 SELECT value INTO g FROM jsonb_array_elements(v.billing_schedule->'groups') WHERE value->>'id'=NEW.group_id::text;
 SELECT min(created_at) INTO accepted FROM public.sales_quote_status_history
   WHERE tenant_id=NEW.tenant_id AND quote_version_id=v.id AND to_status='accepted';
 zone:=v.billing_schedule->>'timezone';
 planned:=CASE WHEN g->'timing'->>'kind'='fixed' THEN (g->'timing'->>'date')::date
   ELSE (accepted AT TIME ZONE zone)::date+(g->'timing'->>'days')::integer END;
 IF NEW.timezone IS DISTINCT FROM zone OR NEW.planned_issue_date IS DISTINCT FROM planned
   OR (NEW.snapshot->>'acceptedAt')::timestamptz IS DISTINCT FROM accepted
   OR NEW.snapshot->>'timezone' IS DISTINCT FROM zone
   OR NEW.snapshot->'timezoneFallback' IS DISTINCT FROM v.billing_schedule->'timezoneFallback'
 THEN RAISE EXCEPTION 'Schedule dates must match durable acceptance' USING ERRCODE='23514'; END IF;
 IF g IS NULL OR (NEW.snapshot - ARRAY['recipient','acceptedAt','timezone','timezoneFallback']) IS DISTINCT FROM g
   OR NEW.snapshot->'recipient' IS DISTINCT FROM v.billing_schedule->'recipient'
 THEN RAISE EXCEPTION 'Schedule snapshot must match accepted group' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS sales_invoice_schedule_guard ON public.sales_invoice_schedule;
CREATE TRIGGER sales_invoice_schedule_guard BEFORE INSERT OR UPDATE OR DELETE ON public.sales_invoice_schedule
 FOR EACH ROW EXECUTE FUNCTION public.guard_sales_invoice_schedule();

CREATE OR REPLACE FUNCTION public.sales_invoice_schedule_is_due(p_schedule public.sales_invoice_schedule,p_now timestamptz DEFAULT now())
RETURNS boolean LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$
 SELECT p_schedule.status IN ('pending','blocked') AND p_schedule.next_attempt_at<=p_now
 AND p_schedule.planned_issue_date<=(p_now AT TIME ZONE p_schedule.timezone)::date
 AND EXISTS(SELECT 1 FROM public.sales_commercial_sale s JOIN public.sales_quote_version v
 ON v.tenant_id=s.tenant_id AND v.id=s.quote_version_id
 WHERE s.tenant_id=p_schedule.tenant_id AND s.id=p_schedule.sale_id AND v.id=p_schedule.quote_version_id
 AND v.status IN ('accepted','converted') AND v.billing_schedule IS NOT NULL)
$$;

CREATE OR REPLACE FUNCTION public.guard_scheduled_whole_sale_attempt() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM public.sales_commercial_sale s JOIN public.sales_quote_version v
 ON v.tenant_id=s.tenant_id AND v.id=s.quote_version_id
 WHERE s.tenant_id=NEW.tenant_id AND s.id=NEW.sale_id AND v.billing_schedule IS NOT NULL)
 THEN RAISE EXCEPTION 'Scheduled sales cannot use whole-sale invoicing' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS sales_scheduled_whole_sale_guard ON public.sales_accounting_invoice_attempt;
CREATE TRIGGER sales_scheduled_whole_sale_guard BEFORE INSERT OR UPDATE ON public.sales_accounting_invoice_attempt
 FOR EACH ROW EXECUTE FUNCTION public.guard_scheduled_whole_sale_attempt();
REVOKE ALL ON FUNCTION public.activate_sales_invoice_schedule(),public.sales_invoice_schedule_is_due(public.sales_invoice_schedule,timestamptz) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.sales_invoice_schedule_is_due(public.sales_invoice_schedule,timestamptz) TO service_role;

-- Fail closed for missing parents, checking BOTH old and new parents on moves.
DO $migration$
DECLARE signature text; definition text;
BEGIN
 FOREACH signature IN ARRAY ARRAY['public.guard_quote_child_immutable()','public.guard_quote_component_immutable()'] LOOP
   SELECT pg_get_functiondef(signature::regprocedure) INTO definition;
   definition:=replace(definition,'v_status <> ''draft''','v_status IS DISTINCT FROM ''draft''');
   definition:=replace(definition,'s <> ''draft''','s IS DISTINCT FROM ''draft''');
   EXECUTE definition;
 END LOOP;
END $migration$;

COMMIT;
