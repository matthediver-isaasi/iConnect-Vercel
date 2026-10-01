-- Durable server-only authority. Never infer historical invoice contents from today's catalogue.
BEGIN;
ALTER TABLE public.booking
  ADD COLUMN IF NOT EXISTS invoice_recovery_status text,
  ADD COLUMN IF NOT EXISTS invoice_recovery_next_attempt_at timestamptz;
ALTER TABLE public.complex_event_booking
  ADD COLUMN IF NOT EXISTS invoice_recovery_status text,
  ADD COLUMN IF NOT EXISTS invoice_recovery_next_attempt_at timestamptz;
ALTER TABLE public.booking DROP CONSTRAINT IF EXISTS booking_invoice_recovery_status_check;
ALTER TABLE public.booking ADD CONSTRAINT booking_invoice_recovery_status_check CHECK
  (invoice_recovery_status IN ('pending','processing','retry','complete','needs_review','not_applicable'));
ALTER TABLE public.complex_event_booking DROP CONSTRAINT IF EXISTS complex_booking_invoice_recovery_status_check;
ALTER TABLE public.complex_event_booking ADD CONSTRAINT complex_booking_invoice_recovery_status_check CHECK
  (invoice_recovery_status IN ('pending','processing','retry','complete','needs_review','not_applicable'));

CREATE TABLE IF NOT EXISTS public.event_invoice_recovery (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  source text NOT NULL CHECK (source IN ('booking','complex_event_booking')),
  booking_group_reference text NOT NULL CHECK (length(booking_group_reference) BETWEEN 1 AND 200),
  snapshot jsonb,
  connection_id text,
  xero_tenant_id text,
  status text NOT NULL CHECK (status IN ('pending','processing','retry','complete','needs_review','not_applicable')),
  next_attempt_at timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  lease_token uuid,
  lease_expires_at timestamptz,
  invoice_id text,
  invoice_number text,
  payment_id text,
  settlement_payment_intent_id text,
  invoice_write_started_at timestamptz,
  payment_write_started_at timestamptz,
  reason_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, source, booking_group_reference)
);
CREATE INDEX IF NOT EXISTS event_invoice_recovery_due ON public.event_invoice_recovery(status,next_attempt_at);
-- A captured Stripe intent can fund only ONE event operation, across both
-- sources/groups/connections. A reconnect must not issue it a second owner.
CREATE UNIQUE INDEX IF NOT EXISTS event_invoice_recovery_settlement_owner
  ON public.event_invoice_recovery(tenant_id,settlement_payment_intent_id)
  WHERE settlement_payment_intent_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS public.event_invoice_recovery_connection (
  connection_id text PRIMARY KEY,
  tenant_id uuid NOT NULL,
  xero_tenant_id text NOT NULL,
  cooldown_until timestamptz,
  last_claimed_at timestamptz,
  lease_token uuid,
  lease_expires_at timestamptz
);
CREATE TABLE IF NOT EXISTS public.event_invoice_recovery_monitor (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  last_started_at timestamptz,
  last_success_at timestamptz,
  booking_cursor uuid,
  complex_cursor uuid
);
CREATE INDEX IF NOT EXISTS event_invoice_recovery_connection_tenant
  ON public.event_invoice_recovery_connection(tenant_id,last_claimed_at);
INSERT INTO public.event_invoice_recovery_monitor(singleton) VALUES(true) ON CONFLICT (singleton) DO NOTHING;
ALTER TABLE public.event_invoice_recovery ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.event_invoice_recovery_connection ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.event_invoice_recovery_monitor ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.event_invoice_recovery, public.event_invoice_recovery_connection,
  public.event_invoice_recovery_monitor FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.event_invoice_recovery, public.event_invoice_recovery_connection,
  public.event_invoice_recovery_monitor TO service_role;

CREATE OR REPLACE FUNCTION public.event_invoice_recovery_eligible(b jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = public AS $$
 SELECT coalesce(b->>'payment_method','') IN ('invoice','card','stripe','mixed','account')
   AND coalesce(b->>'status','') NOT IN ('cancelled','canceled','refunded','failed','pending_payment')
   AND nullif(b->>'booking_group_reference','') IS NOT NULL
   AND nullif(b->>'xero_invoice_id','') IS NULL
   AND nullif(b->>'accounting_invoice_id','') IS NULL
   AND greatest(coalesce((b->>'ticket_price')::numeric,0),
                coalesce((b->>'total_amount')::numeric,0),
                coalesce((b->>'total_paid')::numeric,0)) > 0
   AND (b->>'payment_method' IN ('invoice','account')
        OR b->>'payment_status' = 'paid'
        OR (b->>'status' = 'confirmed' AND nullif(b->>'stripe_payment_intent_id','') IS NOT NULL))
$$;

CREATE OR REPLACE FUNCTION public.event_invoice_recovery_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
 IF ROW(NEW.tenant_id,NEW.source,NEW.booking_group_reference,NEW.snapshot,NEW.connection_id,NEW.xero_tenant_id,NEW.settlement_payment_intent_id)
    IS DISTINCT FROM ROW(OLD.tenant_id,OLD.source,OLD.booking_group_reference,OLD.snapshot,OLD.connection_id,OLD.xero_tenant_id,OLD.settlement_payment_intent_id)
 THEN RAISE EXCEPTION 'Recovery identity and snapshot are immutable'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS event_invoice_recovery_immutable ON public.event_invoice_recovery;
CREATE TRIGGER event_invoice_recovery_immutable BEFORE UPDATE ON public.event_invoice_recovery
FOR EACH ROW EXECUTE FUNCTION public.event_invoice_recovery_immutable();

CREATE OR REPLACE FUNCTION public.event_invoice_recovery_mirror() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
 EXECUTE format('UPDATE public.%I SET invoice_recovery_status=$1,
   invoice_recovery_next_attempt_at=$2 WHERE tenant_id=$3 AND booking_group_reference=$4',NEW.source)
 USING NEW.status, NEW.next_attempt_at, NEW.tenant_id, NEW.booking_group_reference;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS event_invoice_recovery_mirror ON public.event_invoice_recovery;
CREATE TRIGGER event_invoice_recovery_mirror AFTER INSERT OR UPDATE ON public.event_invoice_recovery
FOR EACH ROW EXECUTE FUNCTION public.event_invoice_recovery_mirror();

CREATE OR REPLACE FUNCTION public.event_invoice_recovery_enqueue(
 p_tenant_id uuid,p_source text,p_group text,p_snapshot jsonb,p_valid boolean DEFAULT false
) RETURNS public.event_invoice_recovery
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r public.event_invoice_recovery; eligible boolean; forbidden boolean; has_rows boolean;
BEGIN
 IF p_tenant_id IS NULL OR p_source NOT IN ('booking','complex_event_booking')
   OR p_group IS NULL OR length(p_group) NOT BETWEEN 1 AND 200
   OR octet_length(coalesce(p_snapshot::text,'')) > 262144
 THEN RAISE EXCEPTION 'Invalid recovery scope'; END IF;
 -- Check both scope and financial exclusion boundary before creating authority.
 EXECUTE format('SELECT EXISTS(SELECT 1 FROM public.%I WHERE tenant_id=$1 AND booking_group_reference=$2)',p_source)
 INTO has_rows USING p_tenant_id,p_group;
 IF NOT has_rows THEN RAISE EXCEPTION 'Booking group does not exist'; END IF;
 EXECUTE format('SELECT bool_or(public.event_invoice_recovery_eligible(to_jsonb(b))),
   bool_or(coalesce(b.payment_method,'''') IN (''public_invoice_po'',''free'')
       OR coalesce(b.status,'''') IN (''cancelled'',''canceled'',''refunded''))
   FROM public.%I b WHERE tenant_id=$1 AND booking_group_reference=$2',p_source)
 INTO eligible,forbidden USING p_tenant_id,p_group;
 SELECT * INTO r FROM public.event_invoice_recovery
 WHERE tenant_id=p_tenant_id AND source=p_source AND booking_group_reference=p_group;
 IF FOUND THEN RETURN r; END IF;
 IF p_valid AND (p_snapshot IS NULL OR p_snapshot->>'version' <> '1'
   OR coalesce(p_snapshot#>>'{provider,connectionId}','')=''
   OR coalesce(p_snapshot#>>'{provider,xeroTenantId}','')=''
   OR p_snapshot#>>'{invoice,Type}' <> 'ACCREC'
   OR p_snapshot->>'paymentMethod' NOT IN ('stripe','invoice'))
 THEN RAISE EXCEPTION 'Invalid recovery snapshot'; END IF;
 INSERT INTO public.event_invoice_recovery
 (tenant_id,source,booking_group_reference,snapshot,connection_id,xero_tenant_id,status,next_attempt_at,reason_code,settlement_payment_intent_id)
 VALUES(p_tenant_id,p_source,p_group,p_snapshot,p_snapshot#>>'{provider,connectionId}',p_snapshot#>>'{provider,xeroTenantId}',
   CASE WHEN forbidden OR NOT coalesce(eligible,false) THEN 'not_applicable'
        WHEN NOT p_valid THEN 'needs_review' ELSE 'pending' END,
   CASE WHEN NOT forbidden AND eligible AND p_valid THEN now() ELSE NULL END,
   CASE WHEN NOT p_valid THEN 'snapshot_unavailable' END,
   CASE WHEN p_valid AND eligible AND NOT forbidden AND p_snapshot->>'paymentMethod'='stripe'
     THEN p_snapshot#>>'{settlement,paymentIntentId}' END)
 ON CONFLICT DO NOTHING RETURNING * INTO r;
 IF r.id IS NULL THEN SELECT * INTO r FROM public.event_invoice_recovery
 WHERE tenant_id=p_tenant_id AND source=p_source AND booking_group_reference=p_group; END IF;
 IF r.id IS NULL THEN
   INSERT INTO public.event_invoice_recovery
     (tenant_id,source,booking_group_reference,snapshot,connection_id,xero_tenant_id,status,reason_code)
   VALUES(p_tenant_id,p_source,p_group,p_snapshot,p_snapshot#>>'{provider,connectionId}',
     p_snapshot#>>'{provider,xeroTenantId}','needs_review','settlement_already_owned')
   ON CONFLICT (tenant_id,source,booking_group_reference) DO NOTHING RETURNING * INTO r;
   IF r.id IS NULL THEN SELECT * INTO r FROM public.event_invoice_recovery
     WHERE tenant_id=p_tenant_id AND source=p_source AND booking_group_reference=p_group; END IF;
 END IF;
 IF r.status='pending' THEN
   INSERT INTO public.event_invoice_recovery_connection(connection_id,tenant_id,xero_tenant_id)
   VALUES(r.connection_id,r.tenant_id,r.xero_tenant_id) ON CONFLICT DO NOTHING;
   UPDATE public.event_invoice_recovery q SET next_attempt_at=greatest(q.next_attempt_at,c.cooldown_until)
   FROM public.event_invoice_recovery_connection c
   WHERE q.id=r.id AND c.connection_id=r.connection_id AND c.cooldown_until>now()
   RETURNING q.* INTO r;
   IF r.id IS NULL THEN SELECT * INTO r FROM public.event_invoice_recovery
     WHERE tenant_id=p_tenant_id AND source=p_source AND booking_group_reference=p_group; END IF;
 END IF;
 RETURN r;
END $$;

CREATE OR REPLACE FUNCTION public.event_invoice_recovery_claim(
 p_tenant_id uuid DEFAULT NULL,p_source text DEFAULT NULL,p_group text DEFAULT NULL
) RETURNS public.event_invoice_recovery
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE c public.event_invoice_recovery_connection; r public.event_invoice_recovery; token uuid;
BEGIN
 IF p_source IS NOT NULL AND p_source NOT IN ('booking','complex_event_booking') THEN RAISE EXCEPTION 'Invalid source'; END IF;
 IF p_group IS NOT NULL AND (p_tenant_id IS NULL OR p_source IS NULL OR length(p_group) NOT BETWEEN 1 AND 200)
 THEN RAISE EXCEPTION 'Invalid targeted recovery scope'; END IF;
 -- One connection at a time; oldest served tenant/connection first, even across overlapping crons.
 SELECT c0.* INTO c FROM public.event_invoice_recovery_connection c0
 WHERE (p_tenant_id IS NULL OR c0.tenant_id=p_tenant_id)
 AND coalesce(c0.cooldown_until,'-infinity') <= now()
 AND coalesce(c0.lease_expires_at,'-infinity') <= now()
 AND EXISTS(SELECT 1 FROM public.event_invoice_recovery q WHERE q.connection_id=c0.connection_id
   AND q.tenant_id=c0.tenant_id
   AND (q.status IN ('pending','retry') AND q.next_attempt_at<=now()
        OR q.status='processing' AND q.lease_expires_at<=now())
   AND (p_source IS NULL OR q.source=p_source) AND (p_group IS NULL OR q.booking_group_reference=p_group))
 ORDER BY (SELECT max(tc.last_claimed_at) FROM public.event_invoice_recovery_connection tc
   WHERE tc.tenant_id=c0.tenant_id) NULLS FIRST,
   c0.last_claimed_at NULLS FIRST,c0.connection_id FOR UPDATE SKIP LOCKED LIMIT 1;
 IF NOT FOUND THEN RETURN NULL; END IF;
 SELECT * INTO r FROM public.event_invoice_recovery q
 WHERE q.connection_id=c.connection_id AND q.tenant_id=c.tenant_id
 AND (q.status IN ('pending','retry') AND q.next_attempt_at<=now()
      OR q.status='processing' AND q.lease_expires_at<=now())
 AND (p_source IS NULL OR q.source=p_source) AND (p_group IS NULL OR q.booking_group_reference=p_group)
 ORDER BY q.next_attempt_at NULLS FIRST,q.created_at FOR UPDATE SKIP LOCKED LIMIT 1;
 IF NOT FOUND THEN RETURN NULL; END IF;
 token:=gen_random_uuid();
 UPDATE public.event_invoice_recovery_connection SET lease_token=token,lease_expires_at=now()+interval '120 seconds',
 last_claimed_at=now() WHERE connection_id=c.connection_id;
 UPDATE public.event_invoice_recovery SET status='processing',lease_token=token,
 lease_expires_at=now()+interval '120 seconds',attempts=attempts+1,updated_at=now()
 WHERE id=r.id RETURNING * INTO r;
 RETURN r;
END $$;

CREATE OR REPLACE FUNCTION public.event_invoice_recovery_guard(p_id uuid,p_token uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r public.event_invoice_recovery; safe boolean;
BEGIN
 SELECT * INTO r FROM public.event_invoice_recovery WHERE id=p_id AND lease_token=p_token
 AND status='processing' AND lease_expires_at>now();
 IF NOT FOUND THEN RETURN false; END IF;
 IF r.snapshot->>'paymentMethod'='stripe' AND
   r.settlement_payment_intent_id IS DISTINCT FROM r.snapshot#>>'{settlement,paymentIntentId}'
 THEN RETURN false; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.event_invoice_recovery_connection WHERE connection_id=r.connection_id
   AND lease_token=p_token AND lease_expires_at>now() AND coalesce(cooldown_until,'-infinity')<=now())
 THEN RETURN false; END IF;
 -- Each attendee contributes TRUE or FALSE, never NULL: bool_and ignores NULL,
 -- which must not hide one linked sibling beside an unlinked sibling.
 EXECUTE format('SELECT count(*)>0 AND bool_and(coalesce(coalesce(payment_method,'''') NOT IN (''public_invoice_po'',''free'')
   AND coalesce(status,'''') NOT IN (''cancelled'',''canceled'',''refunded'')
   AND coalesce(to_jsonb(b)->>''payment_status'','''') NOT IN (''refunded'',''failed'',''cancelled'')
   AND (nullif(xero_invoice_id,'''') IS NULL OR ($3 IS NOT NULL AND xero_invoice_id=$3))
   AND nullif(to_jsonb(b)->>''accounting_invoice_id'','''') IS NULL
   AND (($5=''stripe'' AND payment_method IN (''card'',''stripe'',''mixed''))
     OR ($5=''invoice'' AND payment_method IN (''invoice'',''account'')))
   AND ($4 IS NULL OR nullif(to_jsonb(b)->>''stripe_payment_intent_id'','''') IS NULL
     OR to_jsonb(b)->>''stripe_payment_intent_id''=$4),false))
   AND ($4 IS NULL OR bool_or(to_jsonb(b)->>''stripe_payment_intent_id''=$4))
   FROM public.%I b WHERE tenant_id=$1 AND booking_group_reference=$2',r.source)
 INTO safe USING r.tenant_id,r.booking_group_reference,r.invoice_id,
   CASE WHEN r.snapshot->>'paymentMethod'='stripe' THEN r.snapshot#>>'{settlement,paymentIntentId}' END,
   r.snapshot->>'paymentMethod';
 RETURN coalesce(safe,false);
END $$;

CREATE OR REPLACE FUNCTION public.event_invoice_recovery_finish(
 p_id uuid,p_token uuid,p_status text,p_next timestamptz DEFAULT NULL,
 p_invoice_id text DEFAULT NULL,p_invoice_number text DEFAULT NULL,p_payment_id text DEFAULT NULL,
 p_reason text DEFAULT NULL,p_cooldown timestamptz DEFAULT NULL,p_rejected_write text DEFAULT NULL
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r public.event_invoice_recovery;
BEGIN
 IF p_status NOT IN ('retry','complete','needs_review','not_applicable')
 OR (p_status='retry' AND (p_next IS NULL OR p_next<now()))
 OR (p_status='complete' AND nullif(p_invoice_id,'') IS NULL)
 OR length(coalesce(p_reason,''))>80 THEN RAISE EXCEPTION 'Invalid recovery transition'; END IF;
 -- Same lock ordering as claim.
 SELECT * INTO r FROM public.event_invoice_recovery WHERE id=p_id;
 PERFORM 1 FROM public.event_invoice_recovery_connection WHERE connection_id=r.connection_id FOR UPDATE;
 SELECT * INTO r FROM public.event_invoice_recovery WHERE id=p_id AND lease_token=p_token
   AND status='processing' AND lease_expires_at>now() FOR UPDATE;
 IF NOT FOUND THEN RETURN false; END IF;
 IF p_invoice_id IS NOT NULL AND r.invoice_id IS NOT NULL AND p_invoice_id<>r.invoice_id
 THEN RAISE EXCEPTION 'Recovery invoice identity cannot be replaced'; END IF;
 IF p_status='complete' AND r.snapshot->>'paymentMethod'='stripe' AND nullif(p_payment_id,'') IS NULL
 THEN RAISE EXCEPTION 'Stripe settlement evidence required'; END IF;
 IF p_status='complete' AND NOT public.event_invoice_recovery_guard(p_id,p_token) THEN RETURN false; END IF;
 IF p_status='complete' THEN
   EXECUTE format('UPDATE public.%I SET xero_invoice_id=$1,xero_invoice_number=$2
     WHERE tenant_id=$3 AND booking_group_reference=$4
     AND (nullif(xero_invoice_id,'''') IS NULL OR xero_invoice_id=$1)',r.source)
   USING p_invoice_id,p_invoice_number,r.tenant_id,r.booking_group_reference;
 END IF;
 UPDATE public.event_invoice_recovery SET status=p_status,next_attempt_at=CASE WHEN p_status='retry' THEN p_next END,
 invoice_id=coalesce(p_invoice_id,invoice_id),invoice_number=coalesce(p_invoice_number,invoice_number),
 payment_id=coalesce(p_payment_id,payment_id),reason_code=p_reason,
 invoice_write_started_at=CASE WHEN p_reason='provider_rate_limited' AND p_rejected_write='invoice'
   THEN NULL ELSE invoice_write_started_at END,
 payment_write_started_at=CASE WHEN p_reason='provider_rate_limited' AND p_rejected_write='payment'
   THEN NULL ELSE payment_write_started_at END,
 lease_token=NULL,lease_expires_at=NULL,updated_at=now() WHERE id=p_id;
 UPDATE public.event_invoice_recovery_connection SET lease_token=NULL,lease_expires_at=NULL,
 cooldown_until=CASE WHEN p_cooldown IS NULL THEN cooldown_until ELSE greatest(cooldown_until,p_cooldown) END
 WHERE connection_id=r.connection_id AND lease_token=p_token;
 IF p_cooldown IS NOT NULL THEN
   UPDATE public.event_invoice_recovery SET next_attempt_at=greatest(next_attempt_at,p_cooldown),updated_at=now()
   WHERE connection_id=r.connection_id AND tenant_id=r.tenant_id AND status IN ('pending','retry');
 END IF;
 RETURN true;
END $$;

-- Record intent BEFORE the transport. Unknown success is reconciled read-only:
-- no idempotency-retention assumption ever licenses a second create.
CREATE OR REPLACE FUNCTION public.event_invoice_recovery_start_write(p_id uuid,p_token uuid,p_kind text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
 IF p_kind IS NULL OR p_kind NOT IN ('invoice','payment') THEN RAISE EXCEPTION 'Invalid write kind'; END IF;
 IF NOT public.event_invoice_recovery_guard(p_id,p_token) THEN RETURN false; END IF;
 IF p_kind='invoice' THEN
   UPDATE public.event_invoice_recovery SET invoice_write_started_at=now(),updated_at=now()
     WHERE id=p_id AND lease_token=p_token AND invoice_write_started_at IS NULL AND invoice_id IS NULL;
 ELSE
   UPDATE public.event_invoice_recovery SET payment_write_started_at=now(),updated_at=now()
     WHERE id=p_id AND lease_token=p_token AND payment_write_started_at IS NULL AND invoice_id IS NOT NULL;
 END IF;
 RETURN FOUND;
END $$;

CREATE OR REPLACE FUNCTION public.event_invoice_recovery_record_invoice(p_id uuid,p_token uuid,p_invoice_id text,p_invoice_number text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
 IF nullif(p_invoice_id,'') IS NULL OR length(p_invoice_id)>200 THEN RAISE EXCEPTION 'Invalid invoice evidence'; END IF;
 IF NOT public.event_invoice_recovery_guard(p_id,p_token) THEN RETURN false; END IF;
 UPDATE public.event_invoice_recovery SET invoice_id=p_invoice_id,invoice_number=p_invoice_number,updated_at=now()
 WHERE id=p_id AND lease_token=p_token AND (invoice_id IS NULL OR invoice_id=p_invoice_id);
 RETURN FOUND;
END $$;

-- Cursor advances over a bounded number of source rows, including ineligible rows,
-- so an immutable terminal historical group never starves later registrations.
CREATE OR REPLACE FUNCTION public.event_invoice_recovery_sweep(p_limit integer DEFAULT 100) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE m public.event_invoice_recovery_monitor; src text; cursor_id uuid; b record; n integer:=0; seen integer; last_id uuid;
BEGIN
 IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION 'Invalid sweep bound'; END IF;
 SELECT * INTO m FROM public.event_invoice_recovery_monitor WHERE singleton FOR UPDATE;
 FOREACH src IN ARRAY ARRAY['booking','complex_event_booking'] LOOP
   cursor_id:=CASE WHEN src='booking' THEN m.booking_cursor ELSE m.complex_cursor END;
   seen:=0; last_id:=NULL;
   FOR b IN EXECUTE format('SELECT id,tenant_id,booking_group_reference,to_jsonb(b) AS data FROM public.%I b
     WHERE ($1 IS NULL OR id>$1) ORDER BY id LIMIT $2',src) USING cursor_id,p_limit LOOP
     seen:=seen+1; last_id:=b.id;
     IF public.event_invoice_recovery_eligible(b.data)
       AND coalesce((b.data->>'created_at')::timestamptz,now())<now()-interval '10 minutes'
       AND NOT EXISTS(SELECT 1 FROM public.event_invoice_recovery WHERE tenant_id=b.tenant_id
         AND source=src AND booking_group_reference=b.booking_group_reference) THEN
       PERFORM public.event_invoice_recovery_enqueue(b.tenant_id,src,b.booking_group_reference,NULL,false);
       n:=n+1;
     END IF;
   END LOOP;
   IF seen<p_limit THEN last_id:=NULL; END IF;
   IF src='booking' THEN UPDATE public.event_invoice_recovery_monitor SET booking_cursor=last_id WHERE singleton;
   ELSE UPDATE public.event_invoice_recovery_monitor SET complex_cursor=last_id WHERE singleton; END IF;
 END LOOP;
 RETURN n;
END $$;

CREATE OR REPLACE FUNCTION public.event_invoice_recovery_heartbeat(p_success boolean DEFAULT false) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
 UPDATE public.event_invoice_recovery_monitor SET
 last_started_at=CASE WHEN p_success THEN last_started_at ELSE now() END,
 last_success_at=CASE WHEN p_success THEN now() ELSE last_success_at END WHERE singleton
$$;

CREATE OR REPLACE FUNCTION public.event_invoice_recovery_health() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE last_success timestamptz; overdue boolean; stuck boolean; missing boolean; source_missing boolean; waiting boolean; src text;
BEGIN
 SELECT last_success_at INTO last_success FROM public.event_invoice_recovery_monitor WHERE singleton;
 SELECT EXISTS(SELECT 1 FROM public.event_invoice_recovery q
   LEFT JOIN public.event_invoice_recovery_connection c ON c.connection_id=q.connection_id
   WHERE q.status IN ('pending','retry') AND q.next_attempt_at<now()-interval '15 minutes'
   AND coalesce(c.cooldown_until,'-infinity')<=now()) INTO overdue;
 SELECT EXISTS(SELECT 1 FROM public.event_invoice_recovery WHERE status='processing'
   AND lease_expires_at<now()-interval '5 minutes') INTO stuck;
 SELECT EXISTS(SELECT 1 FROM public.event_invoice_recovery q JOIN public.event_invoice_recovery_connection c
   ON c.connection_id=q.connection_id WHERE q.status IN ('pending','retry') AND c.cooldown_until>now()) INTO waiting;
 missing:=false;
 FOREACH src IN ARRAY ARRAY['booking','complex_event_booking'] LOOP
   EXECUTE format('SELECT EXISTS(SELECT 1 FROM public.%I b WHERE public.event_invoice_recovery_eligible(to_jsonb(b))
     AND b.created_at<now()-interval ''30 minutes''
     AND NOT EXISTS(SELECT 1 FROM public.event_invoice_recovery q WHERE q.tenant_id=b.tenant_id
       AND q.source=$1 AND q.booking_group_reference=b.booking_group_reference))',src) INTO source_missing USING src;
   missing:=missing OR source_missing;
 END LOOP;
 RETURN jsonb_build_object('healthy',last_success IS NOT NULL AND last_success>now()-interval '15 minutes'
   AND NOT overdue AND NOT stuck AND NOT missing,
   'status',CASE WHEN last_success IS NULL THEN 'never_succeeded'
     WHEN last_success<now()-interval '15 minutes' THEN 'stale'
     WHEN stuck THEN 'stuck' WHEN overdue OR missing THEN 'overdue'
     WHEN waiting THEN 'waiting_provider' ELSE 'healthy' END);
END $$;

-- No PUBLIC execute grant, including helpers and trigger functions.
DO $$
DECLARE f record;
BEGIN
 FOR f IN SELECT oid::regprocedure AS signature FROM pg_proc
   WHERE pronamespace='public'::regnamespace AND proname LIKE 'event_invoice_recovery_%' LOOP
   EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated',f.signature);
   EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',f.signature);
 END LOOP;
END $$;
COMMIT;