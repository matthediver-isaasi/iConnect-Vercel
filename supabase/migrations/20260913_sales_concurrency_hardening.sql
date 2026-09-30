-- An invitation claim converts one reserved place to named using an
-- invitation-scoped "unreserved" movement. That conversion is not a prior
-- booking unreconciliation. Cancellation must therefore still emit "unnamed".
DROP INDEX IF EXISTS public.sales_allocation_booking_unreconciled_once;
CREATE UNIQUE INDEX sales_allocation_booking_unreconciled_once
 ON public.sales_commercial_allocation_movement(
  tenant_id,allocation_id,(metadata->>'bookingKind'),(metadata->>'bookingId')
 )
 WHERE movement_kind='unnamed'
    OR (movement_kind='unreserved' AND NOT (metadata ? 'invitationId'));

CREATE OR REPLACE FUNCTION public.unreconcile_sales_commercial_booking(
 p_tenant_id uuid,p_booking_kind text,p_booking_id uuid,p_idempotency_key text,
 p_actor_kind text,p_actor_id uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE link public.sales_commercial_allocation_booking%ROWTYPE; a public.sales_commercial_allocation%ROWTYPE;
DECLARE movement_id uuid; movement_kind text;
BEGIN
 IF auth.role()<>'service_role' THEN RAISE EXCEPTION 'service role required' USING ERRCODE='42501'; END IF;
 IF p_booking_kind NOT IN ('simple','complex') OR p_booking_id IS NULL
   OR p_actor_kind NOT IN ('tenant_user','member','system')
   OR length(btrim(COALESCE(p_idempotency_key,''))) NOT BETWEEN 1 AND 200
 THEN RAISE EXCEPTION 'invalid booking unreconciliation' USING ERRCODE='22023'; END IF;
 SELECT * INTO link FROM public.sales_commercial_allocation_booking
  WHERE tenant_id=p_tenant_id AND booking_kind=p_booking_kind AND booking_id=p_booking_id;
 IF NOT FOUND THEN RETURN jsonb_build_object('unreconciled',false,'reason','not_linked'); END IF;
 SELECT * INTO a FROM public.sales_commercial_allocation
  WHERE tenant_id=p_tenant_id AND id=link.allocation_id FOR SHARE;
 PERFORM pg_advisory_xact_lock(hashtextextended(
  CASE WHEN a.event_reference_kind='complex' THEN 'cx:' ELSE '' END||a.event_id::text||':'||a.ticket_type_id,0));
 SELECT id INTO movement_id FROM public.sales_commercial_allocation_movement
  WHERE tenant_id=p_tenant_id AND allocation_id=a.id AND idempotency_key=p_idempotency_key;
 IF FOUND THEN RETURN jsonb_build_object('movementId',movement_id,'idempotent',true,'unreconciled',true); END IF;
 SELECT m.id INTO movement_id
  FROM public.sales_commercial_allocation_movement m
  WHERE m.tenant_id=p_tenant_id AND m.allocation_id=a.id
    AND m.movement_kind IN ('unnamed','unreserved')
    AND m.metadata->>'bookingKind'=p_booking_kind
    AND m.metadata->>'bookingId'=p_booking_id::text
    AND NOT (m.movement_kind='unreserved' AND m.metadata ? 'invitationId')
  LIMIT 1;
 IF FOUND THEN RETURN jsonb_build_object('movementId',movement_id,'idempotent',true,'unreconciled',true); END IF;
 movement_kind:=CASE WHEN link.designation='named' THEN 'unnamed' ELSE 'unreserved' END;
 INSERT INTO public.sales_commercial_allocation_movement(tenant_id,allocation_id,movement_kind,places,
  idempotency_key,actor_kind,actor_id,metadata)
 VALUES(p_tenant_id,a.id,movement_kind,link.places,p_idempotency_key,p_actor_kind,p_actor_id,
  jsonb_build_object('bookingKind',p_booking_kind,'bookingId',p_booking_id))
 RETURNING id INTO movement_id;
 RETURN jsonb_build_object('movementId',movement_id,'idempotent',false,'unreconciled',true);
END $$;

REVOKE ALL ON FUNCTION public.unreconcile_sales_commercial_booking(uuid,text,uuid,text,text,uuid)
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.unreconcile_sales_commercial_booking(uuid,text,uuid,text,text,uuid)
 TO service_role;

-- Task #3885: use one global invitation/ticket lock order. Reservation first
-- locks expired invitations in deterministic ID order and only then obtains
-- the shared ticket lock. Claim/release likewise lock their invitation before
-- the ticket lock, preventing an expiry-boundary invitation <-> ticket cycle.
CREATE OR REPLACE FUNCTION public.reserve_sales_allocation_invitation(
 p_tenant_id uuid,p_allocation_id uuid,p_token_hash text,p_delegate_email text,
 p_delegate_first_name text,p_delegate_last_name text,p_expires_at timestamptz,
 p_idempotency_key text,p_actor_kind text,p_actor_id uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE a public.sales_commercial_allocation%ROWTYPE; t record; v_manager uuid; v_org uuid;
DECLARE v_id uuid; expired record; v_hash bytea; v_existing_expires timestamptz;
DECLARE v_existing_claimed timestamptz; v_existing_released timestamptz;
BEGIN
 IF auth.role()<>'service_role' THEN RAISE EXCEPTION 'service role required' USING ERRCODE='42501'; END IF;
 BEGIN v_hash:=decode(p_token_hash,'hex'); EXCEPTION WHEN others THEN
  RAISE EXCEPTION 'invalid invite token hash' USING ERRCODE='22023'; END;
 IF octet_length(v_hash)<>32 OR p_expires_at<=now() OR p_expires_at>now()+interval '30 days'
   OR p_actor_kind NOT IN ('tenant_user','member') OR p_actor_id IS NULL
   OR position('@' in lower(btrim(COALESCE(p_delegate_email,''))))<=1
   OR length(btrim(COALESCE(p_idempotency_key,''))) NOT BETWEEN 1 AND 200
 THEN RAISE EXCEPTION 'invalid invitation' USING ERRCODE='22023'; END IF;
 SELECT * INTO a FROM public.sales_commercial_allocation
  WHERE tenant_id=p_tenant_id AND id=p_allocation_id FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'allocation not found' USING ERRCODE='P0002'; END IF;
 IF p_actor_kind='member' THEN
  SELECT id,organization_id INTO v_manager,v_org FROM public.sales_commercial_allocation_manager
   WHERE tenant_id=p_tenant_id AND allocation_id=p_allocation_id
    AND member_id=p_actor_id AND revoked_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'allocation manager access denied' USING ERRCODE='42501'; END IF;
 ELSE
  SELECT o.organization_id INTO v_org
  FROM public.sales_commercial_allocation a2
  JOIN public.sales_commercial_sale s ON s.tenant_id=a2.tenant_id AND s.id=a2.sale_id
  JOIN public.opportunity o ON o.tenant_id=s.tenant_id AND o.id=s.opportunity_id
  WHERE a2.tenant_id=p_tenant_id AND a2.id=p_allocation_id;
  IF v_org IS NULL THEN RAISE EXCEPTION 'allocation has no sale organisation' USING ERRCODE='23514'; END IF;
  v_manager:=NULL;
 END IF;

 -- now() is transaction-stable: every row this transaction can consider
 -- expired is locked before the ticket lock. ORDER BY keeps concurrent cleanup
 -- transactions from locking several invitation rows in opposite orders.
 PERFORM id FROM public.sales_commercial_allocation_invitation
  WHERE tenant_id=p_tenant_id AND allocation_id=p_allocation_id
   AND claimed_at IS NULL AND released_at IS NULL AND expires_at<=now()
  ORDER BY id FOR UPDATE;
 PERFORM pg_advisory_xact_lock(hashtextextended(
  CASE WHEN a.event_reference_kind='complex' THEN 'cx:' ELSE '' END||a.event_id::text||':'||a.ticket_type_id,0));

 SELECT id,expires_at,claimed_at,released_at
   INTO v_id,v_existing_expires,v_existing_claimed,v_existing_released
 FROM public.sales_commercial_allocation_invitation
 WHERE tenant_id=p_tenant_id AND allocation_id=p_allocation_id
   AND actor_kind=p_actor_kind AND actor_id=p_actor_id
   AND idempotency_key=p_idempotency_key;
 IF FOUND THEN
  IF v_existing_claimed IS NOT NULL OR v_existing_released IS NOT NULL
     OR v_existing_expires<=now() THEN
   RAISE EXCEPTION 'invitation request key is no longer reusable; use a new idempotency key'
     USING ERRCODE='23514';
  END IF;
  RETURN jsonb_build_object('invitationId',v_id,'expiresAt',v_existing_expires,'replayed',true);
 END IF;
 FOR expired IN SELECT id FROM public.sales_commercial_allocation_invitation
  WHERE tenant_id=p_tenant_id AND allocation_id=p_allocation_id AND claimed_at IS NULL
   AND released_at IS NULL AND expires_at<=now() ORDER BY id
 LOOP
  UPDATE public.sales_commercial_allocation_invitation SET released_at=now() WHERE id=expired.id;
  INSERT INTO public.sales_commercial_allocation_movement(
   tenant_id,allocation_id,movement_kind,places,idempotency_key,actor_kind,actor_id,metadata)
  VALUES(p_tenant_id,p_allocation_id,'unreserved',1,'invite-expired:'||expired.id,
   'system',expired.id,jsonb_build_object('invitationId',expired.id));
 END LOOP;
 SELECT * INTO t FROM public.sales_commercial_allocation_totals WHERE allocation_id=p_allocation_id;
 IF t.named+t.reserved>=t.remaining THEN
  RAISE EXCEPTION 'allocation has no remaining places' USING ERRCODE='23514'; END IF;
 INSERT INTO public.sales_commercial_allocation_invitation(
  tenant_id,allocation_id,manager_id,organization_id,token_hash,delegate_email,
   delegate_first_name,delegate_last_name,expires_at,idempotency_key,actor_kind,actor_id)
 VALUES(p_tenant_id,p_allocation_id,v_manager,v_org,v_hash,lower(btrim(p_delegate_email)),
   nullif(btrim(p_delegate_first_name),''),nullif(btrim(p_delegate_last_name),''),p_expires_at,
   p_idempotency_key,p_actor_kind,p_actor_id)
 RETURNING id INTO v_id;
 INSERT INTO public.sales_commercial_allocation_movement(
  tenant_id,allocation_id,movement_kind,places,idempotency_key,actor_kind,actor_id,metadata)
 VALUES(p_tenant_id,p_allocation_id,'reserved',1,p_idempotency_key,p_actor_kind,p_actor_id,
  jsonb_build_object('invitationId',v_id));
 RETURN jsonb_build_object('invitationId',v_id,'expiresAt',p_expires_at);
END $$;

REVOKE ALL ON FUNCTION public.reserve_sales_allocation_invitation(uuid,uuid,text,text,text,text,timestamptz,text,text,uuid)
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_sales_allocation_invitation(uuid,uuid,text,text,text,text,timestamptz,text,text,uuid)
 TO service_role;

-- Claim additionally locks the source booking before the ticket advisory lock,
-- matching booking cancellation and reconciliation.
CREATE OR REPLACE FUNCTION public.claim_sales_allocation_invitation(
 p_token_hash text,p_booking_kind text,p_booking_id uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE i public.sales_commercial_allocation_invitation%ROWTYPE;
DECLARE a public.sales_commercial_allocation%ROWTYPE; snap jsonb; v_movement uuid;
BEGIN
 IF auth.role()<>'service_role' THEN RAISE EXCEPTION 'service role required' USING ERRCODE='42501'; END IF;
 IF p_booking_kind NOT IN ('simple','complex') OR p_booking_id IS NULL THEN
  RAISE EXCEPTION 'invalid invitation claim' USING ERRCODE='22023';
 END IF;
 BEGIN
  SELECT * INTO i FROM public.sales_commercial_allocation_invitation
   WHERE token_hash=decode(p_token_hash,'hex') FOR UPDATE;
 EXCEPTION WHEN invalid_parameter_value OR data_exception THEN
  RAISE EXCEPTION 'invalid, expired, or used allocation invitation' USING ERRCODE='23514';
 END;
 IF NOT FOUND OR i.claimed_at IS NOT NULL OR i.released_at IS NOT NULL OR i.expires_at<=now() THEN
  RAISE EXCEPTION 'invalid, expired, or used allocation invitation' USING ERRCODE='23514';
 END IF;
 SELECT * INTO a FROM public.sales_commercial_allocation
  WHERE tenant_id=i.tenant_id AND id=i.allocation_id FOR SHARE;
 IF NOT FOUND OR p_booking_kind<>a.event_reference_kind THEN
  RAISE EXCEPTION 'booking kind mismatch' USING ERRCODE='23514';
 END IF;

 -- Lock the source booking before its ticket. This is intentionally before
 -- pg_advisory_xact_lock; reconcile/cancel already use this lock ordering.
 IF p_booking_kind='simple' THEN
  SELECT to_jsonb(b) INTO snap FROM public.booking b WHERE b.tenant_id=i.tenant_id AND b.id=p_booking_id
   AND b.status='confirmed' FOR UPDATE;
 ELSE
  SELECT to_jsonb(b) INTO snap FROM public.complex_event_booking b WHERE b.tenant_id=i.tenant_id AND b.id=p_booking_id
   AND b.status='confirmed' FOR UPDATE;
 END IF;
 IF snap IS NULL OR snap->>'event_id'<>a.event_id::text OR snap->>'ticket_class_id'<>a.ticket_type_id
   OR lower(COALESCE(snap->>'attendee_email',''))<>i.delegate_email
   OR NULLIF(snap->>'organization_id','') IS DISTINCT FROM i.organization_id::text THEN
  RAISE EXCEPTION 'booking does not match invitation context' USING ERRCODE='23514';
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(
  CASE WHEN a.event_reference_kind='complex' THEN 'cx:' ELSE '' END||a.event_id::text||':'||a.ticket_type_id,0));
 IF EXISTS (SELECT 1 FROM public.sales_commercial_allocation_booking
   WHERE tenant_id=i.tenant_id AND booking_kind=p_booking_kind AND booking_id=p_booking_id) THEN
  RAISE EXCEPTION 'booking is already reconciled to an allocation' USING ERRCODE='23505';
 END IF;
 INSERT INTO public.sales_commercial_allocation_booking(
  tenant_id,allocation_id,booking_kind,booking_id,places,designation,booking_snapshot)
 VALUES(i.tenant_id,a.id,p_booking_kind,p_booking_id,1,'named',snap);
 INSERT INTO public.sales_commercial_allocation_movement(
  tenant_id,allocation_id,movement_kind,places,idempotency_key,actor_kind,actor_id,metadata)
 VALUES(i.tenant_id,a.id,'unreserved',1,'invite-claim-unreserve:'||i.id,'system',i.id,
  jsonb_build_object('invitationId',i.id,'bookingKind',p_booking_kind,'bookingId',p_booking_id));
 INSERT INTO public.sales_commercial_allocation_movement(
  tenant_id,allocation_id,movement_kind,places,idempotency_key,actor_kind,actor_id,metadata)
 VALUES(i.tenant_id,a.id,'named',1,'invite-claim:'||i.id,'system',i.id,
  jsonb_build_object('invitationId',i.id,'bookingKind',p_booking_kind,'bookingId',p_booking_id))
 RETURNING id INTO v_movement;
 UPDATE public.sales_commercial_allocation_invitation SET claimed_at=now(),
  booking_kind=p_booking_kind,booking_id=p_booking_id WHERE id=i.id;
 RETURN jsonb_build_object('invitationId',i.id,'movementId',v_movement,'claimed',true);
END $$;

REVOKE ALL ON FUNCTION public.claim_sales_allocation_invitation(text,text,uuid)
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.claim_sales_allocation_invitation(text,text,uuid) TO service_role;

-- Public quote views and decisions run on serverless workers, so process-local
-- counters are only a first line of defence. This shared counter atomically
-- enforces the same one-minute limits across every worker without storing the
-- raw public token or client address.
CREATE TABLE IF NOT EXISTS public.sales_quote_public_rate_limit (
  token_hash bytea NOT NULL,
  client_key_hash bytea NOT NULL,
  window_started timestamptz NOT NULL DEFAULT now(),
  request_count integer NOT NULL DEFAULT 1,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (token_hash, client_key_hash),
  CHECK (octet_length(token_hash) = 32),
  CHECK (octet_length(client_key_hash) = 32),
  CHECK (request_count > 0)
);
CREATE INDEX IF NOT EXISTS sales_quote_public_rate_limit_expiry
  ON public.sales_quote_public_rate_limit(last_seen_at);

ALTER TABLE public.sales_quote_public_rate_limit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.sales_quote_public_rate_limit FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.sales_quote_public_rate_limit TO service_role;
DROP POLICY IF EXISTS sales_quote_public_rate_limit_service
  ON public.sales_quote_public_rate_limit;
CREATE POLICY sales_quote_public_rate_limit_service
  ON public.sales_quote_public_rate_limit TO service_role
  USING (true) WITH CHECK (true);

CREATE OR REPLACE FUNCTION public.consume_sales_quote_public_rate_limit(
  p_token_hash_hex text,
  p_client_key text,
  p_limit integer,
  p_window_seconds integer
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
  v_count integer;
  v_window interval;
BEGIN
  IF auth.role() <> 'service_role'
     OR p_token_hash_hex !~ '^[0-9a-f]{64}$'
     OR length(COALESCE(p_client_key, '')) NOT BETWEEN 1 AND 200
     OR p_limit NOT BETWEEN 1 AND 1000
     OR p_window_seconds NOT BETWEEN 1 AND 3600
  THEN
    RAISE EXCEPTION 'invalid public quote rate-limit request' USING ERRCODE='22023';
  END IF;

  v_window := make_interval(secs => p_window_seconds);
  INSERT INTO public.sales_quote_public_rate_limit(
    token_hash, client_key_hash, window_started, request_count, last_seen_at
  ) VALUES (
    decode(p_token_hash_hex, 'hex'), digest(p_client_key, 'sha256'), now(), 1, now()
  )
  ON CONFLICT (token_hash, client_key_hash) DO UPDATE SET
    request_count = CASE
      WHEN public.sales_quote_public_rate_limit.window_started <= now() - v_window THEN 1
      ELSE public.sales_quote_public_rate_limit.request_count + 1
    END,
    window_started = CASE
      WHEN public.sales_quote_public_rate_limit.window_started <= now() - v_window THEN now()
      ELSE public.sales_quote_public_rate_limit.window_started
    END,
    last_seen_at = now()
  RETURNING request_count INTO v_count;

  -- Opportunistic bounded cleanup keeps random invalid-token probes from
  -- growing this operational table forever.
  DELETE FROM public.sales_quote_public_rate_limit
  WHERE ctid IN (
    SELECT ctid FROM public.sales_quote_public_rate_limit
    WHERE last_seen_at < now() - interval '1 day'
    ORDER BY last_seen_at
    LIMIT 100
  );

  RETURN v_count > p_limit;
END $$;

REVOKE ALL ON FUNCTION public.consume_sales_quote_public_rate_limit(text,text,integer,integer)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.consume_sales_quote_public_rate_limit(text,text,integer,integer)
  TO service_role;