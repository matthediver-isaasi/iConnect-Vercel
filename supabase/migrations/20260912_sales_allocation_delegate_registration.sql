-- Task #3882: least-privilege allocation managers and delegate invitations.
-- Raw invitation tokens never enter the database; callers supply a SHA-256 hash.

CREATE TABLE IF NOT EXISTS public.sales_commercial_allocation_manager (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  allocation_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  member_id uuid NOT NULL,
  granted_by_kind varchar(20) NOT NULL,
  granted_by_id uuid NOT NULL,
  idempotency_key text NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,allocation_id,member_id),
  UNIQUE (tenant_id,idempotency_key),
  FOREIGN KEY (tenant_id,allocation_id)
    REFERENCES public.sales_commercial_allocation(tenant_id,id) ON DELETE RESTRICT,
  CHECK (granted_by_kind IN ('tenant_user','member')),
  CHECK (length(btrim(idempotency_key)) BETWEEN 1 AND 200)
);

CREATE TABLE IF NOT EXISTS public.sales_commercial_allocation_invitation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  allocation_id uuid NOT NULL,
  -- NULL denotes a tenant-admin created invite. It is deliberately not
  -- represented by a synthetic manager grant.
  manager_id uuid,
  organization_id uuid NOT NULL,
  token_hash bytea NOT NULL,
  delegate_email text NOT NULL,
  delegate_first_name text,
  delegate_last_name text,
  expires_at timestamptz NOT NULL,
  claimed_at timestamptz,
  released_at timestamptz,
  booking_kind varchar(20),
  booking_id uuid,
  idempotency_key text NOT NULL,
  actor_kind text NOT NULL,
  actor_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,token_hash),
  UNIQUE (tenant_id,allocation_id,booking_kind,booking_id),
  UNIQUE (tenant_id,allocation_id,actor_kind,actor_id,idempotency_key),
  FOREIGN KEY (tenant_id,allocation_id)
    REFERENCES public.sales_commercial_allocation(tenant_id,id) ON DELETE RESTRICT,
  CHECK (octet_length(token_hash)=32),
  CHECK (delegate_email=lower(btrim(delegate_email)) AND position('@' in delegate_email)>1),
  CHECK (expires_at>created_at),
  CHECK (booking_kind IS NULL OR booking_kind IN ('simple','complex')),
  CHECK (NOT (claimed_at IS NOT NULL AND released_at IS NOT NULL)),
  CHECK (actor_kind IN ('tenant_user','member')),
  CHECK ((claimed_at IS NULL AND booking_id IS NULL AND booking_kind IS NULL)
      OR (claimed_at IS NOT NULL AND booking_id IS NOT NULL AND booking_kind IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS sales_allocation_invitation_expiry
  ON public.sales_commercial_allocation_invitation(tenant_id,allocation_id,expires_at)
  WHERE claimed_at IS NULL AND released_at IS NULL;
ALTER TABLE public.sales_commercial_allocation_invitation
  ALTER COLUMN manager_id DROP NOT NULL;
ALTER TABLE public.sales_commercial_allocation_invitation
  ADD COLUMN IF NOT EXISTS idempotency_key text,
  ADD COLUMN IF NOT EXISTS actor_kind text,
  ADD COLUMN IF NOT EXISTS actor_id uuid;
CREATE UNIQUE INDEX IF NOT EXISTS sales_allocation_invitation_idempotency
  ON public.sales_commercial_allocation_invitation
    (tenant_id,allocation_id,actor_kind,actor_id,idempotency_key)
  WHERE idempotency_key IS NOT NULL AND actor_kind IS NOT NULL AND actor_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.grant_sales_allocation_manager(
 p_tenant_id uuid,p_allocation_id uuid,p_organization_id uuid,p_member_id uuid,
 p_idempotency_key text,p_actor_kind text,p_actor_id uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_id uuid; v_member_org uuid; v_sale_org uuid;
BEGIN
 IF auth.role()<>'service_role' THEN RAISE EXCEPTION 'service role required' USING ERRCODE='42501'; END IF;
 IF p_actor_kind<>'tenant_user' OR p_actor_id IS NULL OR p_member_id IS NULL
   OR length(btrim(COALESCE(p_idempotency_key,''))) NOT BETWEEN 1 AND 200
 THEN RAISE EXCEPTION 'invalid manager grant' USING ERRCODE='22023'; END IF;
 SELECT organization_id INTO v_member_org FROM public.member
  WHERE tenant_id=p_tenant_id AND id=p_member_id;
 IF v_member_org IS DISTINCT FROM p_organization_id THEN
   RAISE EXCEPTION 'manager is not in allocation organisation' USING ERRCODE='23514';
 END IF;
 SELECT o.organization_id INTO v_sale_org
 FROM public.sales_commercial_allocation a
 JOIN public.sales_commercial_sale s ON s.tenant_id=a.tenant_id AND s.id=a.sale_id
 LEFT JOIN public.opportunity o ON o.tenant_id=s.tenant_id AND o.id=s.opportunity_id
 WHERE a.tenant_id=p_tenant_id AND a.id=p_allocation_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'allocation not found' USING ERRCODE='P0002'; END IF;
 IF v_sale_org IS NOT NULL AND v_sale_org<>p_organization_id THEN
   RAISE EXCEPTION 'organisation does not own allocation' USING ERRCODE='23514';
 END IF;
 INSERT INTO public.sales_commercial_allocation_manager(
  tenant_id,allocation_id,organization_id,member_id,granted_by_kind,granted_by_id,idempotency_key)
 VALUES(p_tenant_id,p_allocation_id,p_organization_id,p_member_id,p_actor_kind,p_actor_id,p_idempotency_key)
 ON CONFLICT (tenant_id,allocation_id,member_id) DO UPDATE SET
  revoked_at=NULL
 RETURNING id INTO v_id;
 RETURN jsonb_build_object('managerId',v_id);
END $$;

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
   -- Admin invitations need no pre-existing manager grant. Ownership always
   -- comes from the allocation's sale/opportunity, never caller input or an
   -- arbitrary manager row.
   SELECT o.organization_id INTO v_org
   FROM public.sales_commercial_allocation a2
   JOIN public.sales_commercial_sale s ON s.tenant_id=a2.tenant_id AND s.id=a2.sale_id
   JOIN public.opportunity o ON o.tenant_id=s.tenant_id AND o.id=s.opportunity_id
   WHERE a2.tenant_id=p_tenant_id AND a2.id=p_allocation_id;
   IF v_org IS NULL THEN RAISE EXCEPTION 'allocation has no sale organisation' USING ERRCODE='23514'; END IF;
   v_manager:=NULL;
 END IF;
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
   AND released_at IS NULL AND expires_at<=now() FOR UPDATE
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

CREATE OR REPLACE FUNCTION public.resolve_sales_allocation_invitation(p_token_hash text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE i public.sales_commercial_allocation_invitation%ROWTYPE;
DECLARE a public.sales_commercial_allocation%ROWTYPE;
BEGIN
 IF auth.role()<>'service_role' THEN RAISE EXCEPTION 'service role required' USING ERRCODE='42501'; END IF;
 SELECT * INTO i FROM public.sales_commercial_allocation_invitation
  WHERE token_hash=decode(p_token_hash,'hex') AND claimed_at IS NULL AND released_at IS NULL AND expires_at>now();
 IF NOT FOUND THEN RAISE EXCEPTION 'invalid or expired allocation invitation' USING ERRCODE='P0002'; END IF;
 SELECT * INTO a FROM public.sales_commercial_allocation WHERE tenant_id=i.tenant_id AND id=i.allocation_id;
 RETURN jsonb_build_object('invitationId',i.id,'tenantId',i.tenant_id,'allocationId',a.id,
  'eventKind',a.event_reference_kind,'eventId',a.event_id,'ticketTypeId',a.ticket_type_id,
  'organizationId',i.organization_id,'delegateEmail',i.delegate_email,
  'delegateFirstName',i.delegate_first_name,'delegateLastName',i.delegate_last_name,
  'expiresAt',i.expires_at);
EXCEPTION WHEN invalid_parameter_value OR data_exception THEN
 RAISE EXCEPTION 'invalid or expired allocation invitation' USING ERRCODE='P0002';
END $$;

CREATE OR REPLACE FUNCTION public.claim_sales_allocation_invitation(
 p_token_hash text,p_booking_kind text,p_booking_id uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE i public.sales_commercial_allocation_invitation%ROWTYPE; a public.sales_commercial_allocation%ROWTYPE;
DECLARE snap jsonb; v_movement uuid;
BEGIN
 IF auth.role()<>'service_role' THEN RAISE EXCEPTION 'service role required' USING ERRCODE='42501'; END IF;
 SELECT * INTO i FROM public.sales_commercial_allocation_invitation
  WHERE token_hash=decode(p_token_hash,'hex') FOR UPDATE;
 IF NOT FOUND OR i.claimed_at IS NOT NULL OR i.released_at IS NOT NULL OR i.expires_at<=now() THEN
  RAISE EXCEPTION 'invalid, expired, or used allocation invitation' USING ERRCODE='23514'; END IF;
 SELECT * INTO a FROM public.sales_commercial_allocation WHERE tenant_id=i.tenant_id AND id=i.allocation_id FOR SHARE;
 IF p_booking_kind<>a.event_reference_kind THEN RAISE EXCEPTION 'booking kind mismatch' USING ERRCODE='23514'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(
  CASE WHEN a.event_reference_kind='complex' THEN 'cx:' ELSE '' END||a.event_id::text||':'||a.ticket_type_id,0));
 IF p_booking_kind='simple' THEN
  SELECT to_jsonb(b) INTO snap FROM public.booking b WHERE b.tenant_id=i.tenant_id AND b.id=p_booking_id
   AND b.status='confirmed' FOR UPDATE;
 ELSE
  SELECT to_jsonb(b) INTO snap FROM public.complex_event_booking b WHERE b.tenant_id=i.tenant_id AND b.id=p_booking_id
   AND b.status='confirmed' FOR UPDATE;
 END IF;
 IF snap IS NULL OR snap->>'event_id'<>a.event_id::text OR snap->>'ticket_class_id'<>a.ticket_type_id
   OR lower(COALESCE(snap->>'attendee_email',''))<>i.delegate_email
   OR NULLIF(snap->>'organization_id','') IS DISTINCT FROM i.organization_id::text
 THEN RAISE EXCEPTION 'booking does not match invitation context' USING ERRCODE='23514'; END IF;
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

CREATE OR REPLACE FUNCTION public.release_sales_allocation_invitation(
 p_tenant_id uuid,p_invitation_id uuid,p_actor_kind text,p_actor_id uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE i public.sales_commercial_allocation_invitation%ROWTYPE; a public.sales_commercial_allocation%ROWTYPE;
BEGIN
 IF auth.role()<>'service_role' THEN RAISE EXCEPTION 'service role required' USING ERRCODE='42501'; END IF;
 SELECT * INTO i FROM public.sales_commercial_allocation_invitation
  WHERE tenant_id=p_tenant_id AND id=p_invitation_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'invitation not found' USING ERRCODE='P0002'; END IF;
 IF p_actor_kind='member' AND NOT EXISTS(
  SELECT 1 FROM public.sales_commercial_allocation_manager
   WHERE id=i.manager_id AND member_id=p_actor_id AND revoked_at IS NULL
 ) THEN RAISE EXCEPTION 'allocation manager access denied' USING ERRCODE='42501'; END IF;
 IF i.claimed_at IS NOT NULL THEN RAISE EXCEPTION 'claimed invitation cannot be released' USING ERRCODE='23514'; END IF;
 IF i.released_at IS NOT NULL THEN RETURN jsonb_build_object('released',true,'idempotent',true); END IF;
 SELECT * INTO a FROM public.sales_commercial_allocation WHERE id=i.allocation_id;
 PERFORM pg_advisory_xact_lock(hashtextextended(
  CASE WHEN a.event_reference_kind='complex' THEN 'cx:' ELSE '' END||a.event_id::text||':'||a.ticket_type_id,0));
 UPDATE public.sales_commercial_allocation_invitation SET released_at=now() WHERE id=i.id;
 INSERT INTO public.sales_commercial_allocation_movement(
  tenant_id,allocation_id,movement_kind,places,idempotency_key,actor_kind,actor_id,metadata)
 VALUES(i.tenant_id,i.allocation_id,'unreserved',1,'invite-release:'||i.id,p_actor_kind,p_actor_id,
  jsonb_build_object('invitationId',i.id));
 RETURN jsonb_build_object('released',true,'idempotent',false);
END $$;

ALTER TABLE public.sales_commercial_allocation_manager ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sales_commercial_allocation_invitation ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.sales_commercial_allocation_manager,
 public.sales_commercial_allocation_invitation FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE ON public.sales_commercial_allocation_manager,
 public.sales_commercial_allocation_invitation TO service_role;
REVOKE ALL ON FUNCTION public.grant_sales_allocation_manager(uuid,uuid,uuid,uuid,text,text,uuid),
 public.reserve_sales_allocation_invitation(uuid,uuid,text,text,text,text,timestamptz,text,text,uuid),
 public.resolve_sales_allocation_invitation(text),
 public.claim_sales_allocation_invitation(text,text,uuid),
 public.release_sales_allocation_invitation(uuid,uuid,text,uuid)
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.grant_sales_allocation_manager(uuid,uuid,uuid,uuid,text,text,uuid),
 public.reserve_sales_allocation_invitation(uuid,uuid,text,text,text,text,timestamptz,text,text,uuid),
 public.resolve_sales_allocation_invitation(text),
 public.claim_sales_allocation_invitation(text,text,uuid),
 public.release_sales_allocation_invitation(uuid,uuid,text,uuid)
 TO service_role;