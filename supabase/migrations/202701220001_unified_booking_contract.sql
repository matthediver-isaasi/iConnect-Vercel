-- Additive, disabled by default. Apply only to an explicitly approved target.
-- Legacy attempts/RPCs/approval provenance are not rewritten.
BEGIN;
CREATE TABLE public.unified_booking_rollout (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 enabled boolean NOT NULL DEFAULT false,
 reader_version integer NOT NULL DEFAULT 0,
 worker_version integer NOT NULL DEFAULT 0
);
INSERT INTO public.unified_booking_rollout DEFAULT VALUES;
CREATE TABLE public.unified_booking_contract (
 id uuid NOT NULL, tenant_id uuid NOT NULL,
 source text NOT NULL CHECK(source IN ('booking','complex_event_booking')),
 event_id uuid NOT NULL, member_id uuid,
 snapshot jsonb NOT NULL CHECK(snapshot->>'version'='2'),
 payment_parameters jsonb, payment_requested_at timestamptz, payment_intent_id text,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id),
 UNIQUE(tenant_id,payment_intent_id)
);
CREATE TABLE public.unified_booking_invoice (
 tenant_id uuid NOT NULL, purchase_key text NOT NULL, contract_id uuid NOT NULL,
 source text NOT NULL CHECK(source IN ('booking','complex_event_booking')),
 prepared jsonb NOT NULL,
 state text NOT NULL CHECK(state IN ('pending','processing','queued','needs_review','not_applicable')),
 lease_token uuid, lease_until timestamptz,
 attempts integer NOT NULL DEFAULT 0, next_at timestamptz NOT NULL DEFAULT now(),
 last_error text, created_at timestamptz NOT NULL DEFAULT now(),
 provision_state text NOT NULL DEFAULT 'pending' CHECK(provision_state IN ('pending','completed','needs_review','not_applicable')),
 provisioned jsonb NOT NULL DEFAULT '[]',
 booker_member_id uuid,
 provision_error_code text,
 PRIMARY KEY(tenant_id,purchase_key),
 FOREIGN KEY(tenant_id,contract_id) REFERENCES public.unified_booking_contract(tenant_id,id)
);
ALTER TABLE public.booking_credit_attempt ALTER COLUMN member_id DROP NOT NULL;
ALTER TABLE public.booking_credit_attempt ADD COLUMN unified_contract_id uuid;
ALTER TABLE public.booking_credit_attempt ADD CONSTRAINT booking_credit_contract_fk
 FOREIGN KEY(tenant_id,unified_contract_id) REFERENCES public.unified_booking_contract(tenant_id,id);
ALTER TABLE public.booking_credit_attempt ADD CONSTRAINT booking_credit_member_or_contract
 CHECK(member_id IS NOT NULL OR unified_contract_id IS NOT NULL);
ALTER TABLE public.public_invoice_po_billing ADD COLUMN unified_contract_id uuid;
ALTER TABLE public.public_invoice_po_billing ALTER COLUMN member_id DROP NOT NULL;
ALTER TABLE public.public_invoice_po_billing ALTER COLUMN actor_id DROP NOT NULL;
ALTER TABLE public.public_invoice_po_billing ALTER COLUMN provider DROP NOT NULL;
ALTER TABLE public.public_invoice_po_billing ADD CONSTRAINT public_po_authority_version
 CHECK((unified_contract_id IS NULL AND member_id IS NOT NULL AND actor_id IS NOT NULL AND provider IS NOT NULL)
  OR (unified_contract_id IS NOT NULL AND actor_id IS NULL));
ALTER TABLE public.public_invoice_po_billing ADD CONSTRAINT public_po_unified_contract
 FOREIGN KEY(tenant_id,unified_contract_id) REFERENCES public.unified_booking_contract(tenant_id,id);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['unified_booking_rollout','unified_booking_contract','unified_booking_invoice'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC,anon,authenticated,service_role',t);
  EXECUTE format('GRANT SELECT ON public.%I TO service_role',t);
 END LOOP;
END $$;
GRANT UPDATE(enabled,reader_version,worker_version) ON public.unified_booking_rollout TO service_role;
-- Keep the complete historical public-PO guard. Only an authenticated service
-- transaction bound to a prepared v2 attempt may insert the new context.
DO $$
DECLARE d text; position integer; branch text;
BEGIN
 IF to_regprocedure('public.guard_public_invoice_po_booking()') IS NOT NULL THEN
  d:=pg_get_functiondef('public.guard_public_invoice_po_booking()'::regprocedure);
  position:=strpos(d,E'BEGIN\n');
  IF position=0 THEN RAISE EXCEPTION 'Public purchaser guard shape changed'; END IF;
  branch:=$branch$
  IF NEW.purchaser_context->>'booking_contract_version'='2' THEN
   IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'Service booking authority required' USING ERRCODE='42501'; END IF;
   IF TG_OP='UPDATE' AND (OLD.purchaser_context IS DISTINCT FROM NEW.purchaser_context
     OR OLD.purchaser_context->>'booking_contract_version' IS DISTINCT FROM '2'
     OR ROW(OLD.tenant_id,OLD.event_id,OLD.booking_group_reference,OLD.payment_method,OLD.stripe_payment_intent_id)
       IS DISTINCT FROM ROW(NEW.tenant_id,NEW.event_id,NEW.booking_group_reference,NEW.payment_method,NEW.stripe_payment_intent_id))
   THEN RAISE EXCEPTION 'Unified purchaser instructions are immutable'; END IF;
   IF NEW.payment_method='public_invoice_po' OR NOT EXISTS(
     SELECT 1 FROM public.booking_credit_attempt a JOIN public.unified_booking_contract c
       ON c.tenant_id=a.tenant_id AND c.id=a.unified_contract_id
     WHERE a.tenant_id=NEW.tenant_id AND a.source=TG_TABLE_NAME AND a.purchase_key=NEW.booking_group_reference
       AND a.state IN ('preparing','committed') AND c.event_id=NEW.event_id
       AND NEW.purchaser_context#>>'{invoice_customer,name}'=c.snapshot#>>'{contact,name}'
       AND NEW.purchaser_context#>>'{invoice_customer,kind}'=c.snapshot#>>'{contact,provenance,kind}'
       AND (c.member_id IS NOT NULL OR (
         NEW.purchaser_context->>'classification'='public_non_member'
         AND NEW.purchaser_context->'details'=c.snapshot->'booker')))
   THEN RAISE EXCEPTION 'Original unified booking authority required'; END IF;
   RETURN NEW;
  END IF;
  $branch$;
  d:=substr(d,1,position+length(E'BEGIN\n')-1)||branch||substr(d,position+length(E'BEGIN\n'));
  EXECUTE d;
 END IF;
END $$;

CREATE FUNCTION public.unified_booking_readiness() RETURNS jsonb LANGUAGE sql SECURITY DEFINER
 SET search_path=public,pg_temp AS $$
 SELECT jsonb_build_object('version',2,'enabled',enabled AND reader_version=2 AND worker_version=2 AND EXISTS(
   SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
   WHERE c.relname='member_public_ticket_email_normalized_unique' AND i.indrelid='public.member'::regclass
    AND i.indisunique AND i.indisvalid AND i.indisready AND i.indpred IS NULL
    AND pg_get_indexdef(i.indexrelid,1,true)='tenant_id'
    AND pg_get_indexdef(i.indexrelid,2,true)='normalize_public_ticket_email(email)'))
 FROM unified_booking_rollout WHERE singleton
$$;
CREATE FUNCTION public.unified_booking_prepare(p_id uuid,p_tenant uuid,p_source text,p_event uuid,p_member uuid,p_snapshot jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE c unified_booking_contract; e jsonb;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant::text||':unified:'||p_id::text,0));
 SELECT * INTO c FROM unified_booking_contract WHERE tenant_id=p_tenant AND id=p_id FOR UPDATE;
 IF FOUND THEN
  IF c.source IS DISTINCT FROM p_source OR c.event_id IS DISTINCT FROM p_event OR c.member_id IS DISTINCT FROM p_member
   OR c.snapshot->'request' IS DISTINCT FROM p_snapshot->'request' THEN RAISE EXCEPTION 'Checkout instructions changed'; END IF;
  RETURN to_jsonb(c);
 END IF;
 IF NOT coalesce((unified_booking_readiness()->>'enabled')::boolean,false) THEN RAISE EXCEPTION 'Unified booking is not enabled'; END IF;
 IF p_source NOT IN ('booking','complex_event_booking') OR p_snapshot->>'version' IS DISTINCT FROM '2'
  OR nullif(p_snapshot#>>'{contact,name}','') IS NULL THEN RAISE EXCEPTION 'Invalid booking contract'; END IF;
 EXECUTE format('SELECT to_jsonb(e) FROM public.%I e WHERE tenant_id=$1 AND id=$2',CASE WHEN p_source='booking' THEN 'event' ELSE 'complex_event' END)
 INTO e USING p_tenant,p_event;
 IF e IS NULL THEN RAISE EXCEPTION 'Event outside tenant'; END IF;
 IF p_member IS NOT NULL AND NOT EXISTS(SELECT 1 FROM member WHERE tenant_id=p_tenant AND id=p_member) THEN RAISE EXCEPTION 'Member outside tenant'; END IF;
 IF p_member IS NULL AND EXISTS(SELECT 1 FROM member WHERE tenant_id=p_tenant
   AND normalize_public_ticket_email(email)=normalize_public_ticket_email(p_snapshot#>>'{booker,email}')) THEN
  RAISE EXCEPTION 'Existing member must sign in';
 END IF;
 INSERT INTO unified_booking_contract(id,tenant_id,source,event_id,member_id,snapshot)
 VALUES(p_id,p_tenant,p_source,p_event,p_member,p_snapshot) RETURNING * INTO c;
 RETURN to_jsonb(c);
END $$;
CREATE FUNCTION public.unified_booking_payment_request(p_id uuid,p_tenant uuid,p_parameters jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE c unified_booking_contract;
BEGIN
 SELECT * INTO STRICT c FROM unified_booking_contract WHERE tenant_id=p_tenant AND id=p_id FOR UPDATE;
 IF p_parameters#>>'{metadata,unified_booking_contract_id}' IS DISTINCT FROM p_id::text
  OR p_parameters#>>'{metadata,event_id}' IS DISTINCT FROM c.event_id::text
  OR p_parameters#>>'{metadata,tenant_id}' IS DISTINCT FROM p_tenant::text
  OR (p_parameters->>'amount')::bigint<=0 THEN RAISE EXCEPTION 'Invalid payment authority'; END IF;
 IF c.payment_parameters IS NOT NULL AND c.payment_parameters<>p_parameters THEN RAISE EXCEPTION 'Original payment instructions changed'; END IF;
 UPDATE unified_booking_contract SET payment_parameters=coalesce(payment_parameters,p_parameters),
  payment_requested_at=coalesce(payment_requested_at,now()) WHERE tenant_id=p_tenant AND id=p_id RETURNING * INTO c;
 RETURN to_jsonb(c);
END $$;
CREATE FUNCTION public.unified_booking_payment_bind(p_id uuid,p_tenant uuid,p_payment text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE c unified_booking_contract;
BEGIN
 SELECT * INTO STRICT c FROM unified_booking_contract WHERE tenant_id=p_tenant AND id=p_id FOR UPDATE;
 IF c.payment_parameters IS NULL OR p_payment !~ '^pi_[A-Za-z0-9]+$'
  OR (c.payment_intent_id IS NOT NULL AND c.payment_intent_id<>p_payment) THEN RAISE EXCEPTION 'Payment binding changed'; END IF;
 UPDATE unified_booking_contract SET payment_intent_id=p_payment WHERE tenant_id=p_tenant AND id=p_id;
END $$;
CREATE FUNCTION public.unified_booking_begin(p_id uuid,p_tenant uuid,p_key text,p_fence uuid,p_fingerprint text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE c unified_booking_contract; a booking_credit_attempt;
BEGIN
 SELECT * INTO STRICT c FROM unified_booking_contract WHERE tenant_id=p_tenant AND id=p_id;
 IF length(p_key)>100 OR length(p_fingerprint)<>64 OR p_fence IS NULL THEN RAISE EXCEPTION 'Invalid attempt'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant::text||':'||p_key,0));
 SELECT * INTO a FROM booking_credit_attempt WHERE tenant_id=p_tenant AND purchase_key=p_key FOR UPDATE;
 IF FOUND THEN
  IF a.unified_contract_id IS DISTINCT FROM p_id OR a.fingerprint<>p_fingerprint THEN RAISE EXCEPTION 'Purchase request changed'; END IF;
  IF a.state IN ('committed','reversed') THEN RETURN jsonb_build_object('response',a.response); END IF;
  IF a.state='preparing' AND a.lease_until>now() THEN RAISE EXCEPTION 'Purchase already processing'; END IF;
  UPDATE booking_credit_attempt SET state='preparing',fence=p_fence,lease_until=now()+interval '5 minutes'
   WHERE tenant_id=p_tenant AND purchase_key=p_key;
 ELSE
  INSERT INTO booking_credit_attempt(tenant_id,purchase_key,member_id,source,fingerprint,fence,lease_until,state,unified_contract_id)
   VALUES(p_tenant,p_key,c.member_id,c.source,p_fingerprint,p_fence,now()+interval '5 minutes','preparing',p_id);
 END IF;
 RETURN jsonb_build_object('purchaseKey',p_key);
END $$;

-- Reuse the already-reviewed capacity/funding/allocation transaction without
-- changing the old function. Fail closed if its required anchors have drifted.
DO $$ DECLARE body text; anchor text; BEGIN
 body:=pg_get_functiondef('public.booking_credit_finalize(uuid,text,uuid,uuid,jsonb,jsonb)'::regprocedure);
 body:=replace(body,'FUNCTION public.booking_credit_finalize(','FUNCTION public.unified_booking_finalize_core(');
 anchor:='SELECT * INTO STRICT m FROM public.member WHERE id=a.member_id AND tenant_id=p_tenant_id;';
 IF strpos(body,anchor)=0 THEN RAISE EXCEPTION 'Booking member contract drift'; END IF;
 body:=replace(body,anchor,'IF a.member_id IS NOT NULL THEN '||anchor||' END IF;');
 anchor:='IF EXISTS(SELECT 1 FROM public.system_settings WHERE tenant_id=p_tenant_id AND setting_key=''event_allow_voucher_payment'' AND lower(trim(setting_value))=''false'')';
 IF strpos(body,anchor)=0 THEN RAISE EXCEPTION 'Booking funding contract drift'; END IF;
 body:=replace(body,anchor,'IF (expected>0 AND EXISTS(SELECT 1 FROM public.system_settings WHERE tenant_id=p_tenant_id AND setting_key=''event_allow_voucher_payment'' AND lower(trim(setting_value))=''false''))');
 anchor:='allocation:=public.voucher_credit_reserve';
 IF strpos(body,anchor)=0 THEN RAISE EXCEPTION 'Booking voucher contract drift'; END IF;
 body:=replace(body,anchor,'IF expected>0 THEN allocation:=public.voucher_credit_reserve');
 anchor:='IF (allocation->>''voucherMinor'')::bigint<>expected THEN RAISE EXCEPTION ''Voucher balance changed''; END IF;';
 body:=replace(body,anchor,anchor||' ELSE allocation:=''{"voucherMinor":0,"allocations":[]}''::jsonb; END IF;');
 anchor:='allocation:=public.voucher_credit_transition(p_tenant_id,p_purchase_key,''commit'',NULL);';
 IF strpos(body,anchor)=0 THEN RAISE EXCEPTION 'Booking voucher commit contract drift'; END IF;
 body:=replace(body,anchor,'IF expected>0 THEN '||anchor||' END IF;');
 body:=replace(body,'''booking_group_reference'',p_purchase_key,''member_id'',m.id','''booking_group_reference'',p_purchase_key');
 body:=replace(body,'d.member_id<>m.id','d.member_id IS DISTINCT FROM m.id');
 EXECUTE body;
END $$;

CREATE FUNCTION public.unified_booking_finalize(p_tenant_id uuid,p_purchase_key text,p_fence uuid,p_event_id uuid,p_rows jsonb,p_funding jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE a booking_credit_attempt; c unified_booking_contract; result jsonb; prepared jsonb; s text; r jsonb; billing uuid;
BEGIN
 SELECT * INTO STRICT a FROM booking_credit_attempt WHERE tenant_id=p_tenant_id AND purchase_key=p_purchase_key FOR UPDATE;
 SELECT * INTO STRICT c FROM unified_booking_contract WHERE tenant_id=p_tenant_id AND id=a.unified_contract_id;
 IF c.event_id<>p_event_id OR c.source<>a.source THEN RAISE EXCEPTION 'Booking contract event changed'; END IF;
 IF a.state='committed' THEN RETURN a.response; END IF;
 IF c.member_id IS NULL THEN
  PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant_id::text||':'||lower(trim(c.snapshot#>>'{booker,email}')),0));
  IF EXISTS(SELECT 1 FROM member WHERE tenant_id=p_tenant_id
    AND normalize_public_ticket_email(email)=normalize_public_ticket_email(c.snapshot#>>'{booker,email}')) THEN
   RAISE EXCEPTION 'Existing member must sign in';
  END IF;
 END IF;
 prepared:=p_funding->'preparedInvoice';
 IF prepared->>'version' IS DISTINCT FROM '2' OR prepared->>'status' NOT IN ('pending','needs_review','not_applicable') THEN RAISE EXCEPTION 'Durable invoice intent required'; END IF;
 IF p_funding->'invoiceInput'->'contact' IS DISTINCT FROM c.snapshot->'contact' THEN RAISE EXCEPTION 'Invoice customer changed'; END IF;
 IF (p_funding#>>'{invoiceInput,amount}')::numeric>0 AND (
   p_funding#>>'{invoiceInput,paymentMethod}' NOT IN ('card','stripe','mixed','account','invoice','public_invoice_po')
   OR (p_funding#>>'{invoiceInput,paymentMethod}' IN ('card','stripe','mixed') AND c.payment_intent_id IS NULL))
 THEN RAISE EXCEPTION 'Original successful payment is required'; END IF;
 IF c.member_id IS NULL AND (coalesce((p_funding->>'voucherMinor')::bigint,0)>0 OR coalesce((p_funding->>'trainingFundMinor')::bigint,0)>0) THEN RAISE EXCEPTION 'Guest funding forbidden'; END IF;
 FOR r IN SELECT value FROM jsonb_array_elements(p_rows) LOOP
  IF r->>'payment_method'='card' AND (nullif(r->>'stripe_payment_intent_id','') IS NOT NULL AND
    r->>'stripe_payment_intent_id' IS DISTINCT FROM c.payment_intent_id) THEN RAISE EXCEPTION 'Original card binding required'; END IF;
 END LOOP;
 IF p_funding->>'paymentIntentId' IS DISTINCT FROM c.payment_intent_id THEN RAISE EXCEPTION 'Original payment identity changed'; END IF;
 result:=unified_booking_finalize_core(p_tenant_id,p_purchase_key,p_fence,p_event_id,p_rows,p_funding);
 s:=prepared->>'status';
 INSERT INTO unified_booking_invoice(tenant_id,purchase_key,contract_id,source,prepared,state)
 VALUES(p_tenant_id,p_purchase_key,c.id,a.source,prepared,s);
 EXECUTE format('UPDATE public.%I SET invoice_recovery_status=$1 WHERE tenant_id=$2 AND booking_group_reference=$3',a.source)
 USING s,p_tenant_id,p_purchase_key;
 IF s<>'not_applicable' THEN
  INSERT INTO public_invoice_po_billing(tenant_id,source,booking_group_reference,event_id,member_id,actor_id,unified_contract_id,
   original_records,amount,currency,provider,provider_snapshot,invoice_status,email_status,billing_contact)
  VALUES(p_tenant_id,a.source,p_purchase_key,p_event_id,c.member_id,NULL,c.id,result->'bookings',
   (p_funding#>>'{invoiceInput,amount}')::numeric,upper(p_funding#>>'{invoiceInput,currency}'),
   CASE WHEN jsonb_typeof(prepared#>'{snapshot,provider}')='object' OR jsonb_typeof(prepared#>'{snapshot,approvalProvider}')='object'
     THEN prepared->>'provider' ELSE NULL END,
   coalesce(prepared->'snapshot','{}'),s,'pending',c.snapshot->'booker')
  RETURNING id INTO billing;
  EXECUTE format('UPDATE public.%I SET public_invoice_po_billing_id=$1 WHERE tenant_id=$2 AND booking_group_reference=$3',a.source)
   USING billing,p_tenant_id,p_purchase_key;
 END IF;
 result:=result||jsonb_build_object('invoice_recovery',jsonb_build_object('status',s,'queued',s='pending'));
 UPDATE booking_credit_attempt SET response=result WHERE tenant_id=p_tenant_id AND purchase_key=p_purchase_key;
 RETURN result;
END $$;
CREATE FUNCTION public.unified_booking_provision(p_tenant uuid,p_key text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r unified_booking_invoice; a booking_credit_attempt; c unified_booking_contract;
 policy jsonb; b jsonb; person jsonb; people jsonb:='{}'; identity text; role_row jsonb; member_new uuid; output jsonb:='[]';
BEGIN
 SELECT * INTO STRICT r FROM unified_booking_invoice WHERE tenant_id=p_tenant AND purchase_key=p_key FOR UPDATE;
 IF r.provision_state<>'pending' THEN RETURN jsonb_build_object('state',r.provision_state); END IF;
 SELECT * INTO STRICT a FROM booking_credit_attempt WHERE tenant_id=p_tenant AND purchase_key=p_key AND state='committed';
 SELECT * INTO STRICT c FROM unified_booking_contract WHERE tenant_id=p_tenant AND id=r.contract_id;
 IF c.member_id IS NOT NULL OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(c.snapshot->'policies') p WHERE p->>'createMember'='true') THEN
  UPDATE unified_booking_invoice SET provision_state='not_applicable' WHERE tenant_id=p_tenant AND purchase_key=p_key;
  RETURN jsonb_build_object('state','not_applicable');
 END IF;
 BEGIN
  FOR b IN SELECT value FROM jsonb_array_elements(a.response->'bookings') LOOP
   SELECT value INTO policy FROM jsonb_array_elements(c.snapshot->'policies') WHERE value->>'ticketId'=b->>'ticket_class_id' AND value->>'createMember'='true';
   IF policy IS NULL THEN CONTINUE; END IF;
   FOR person IN SELECT value FROM jsonb_array_elements(jsonb_build_array(c.snapshot->'booker',
     jsonb_build_object('email',b->>'attendee_email','first_name',b->>'attendee_first_name','last_name',b->>'attendee_last_name',
      'organization',coalesce(b->>'attendee_organization',b->>'guest_organisation_name','')))) LOOP
    identity:=normalize_public_ticket_email(person->>'email');
    IF identity IS NULL OR identity !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
      OR nullif(trim(person->>'first_name'),'') IS NULL OR nullif(trim(person->>'last_name'),'') IS NULL THEN
      RAISE EXCEPTION 'Provisioning identity requires review';
    END IF;
    IF people ? identity AND people->identity->>'roleId' IS DISTINCT FROM policy->>'roleId' THEN RAISE EXCEPTION 'Conflicting frozen roles'; END IF;
    people:=jsonb_set(people,ARRAY[identity],person||jsonb_build_object('roleId',policy->>'roleId',
      'enableLogin',coalesce((policy->>'enableLogin')::boolean,false) OR coalesce((people->identity->>'enableLogin')::boolean,false)));
   END LOOP;
  END LOOP;
  -- Lock email identities in stable order, matching the tenant/email lifecycle
  -- fence; never adopt an existing record based on an unverified guest email.
  FOR identity,person IN SELECT key,value FROM jsonb_each(people) ORDER BY key LOOP
   PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant::text||':'||identity,0));
   IF EXISTS(SELECT 1 FROM member WHERE tenant_id=p_tenant AND normalize_public_ticket_email(email)=identity) THEN RAISE EXCEPTION 'Existing email requires review'; END IF;
   SELECT to_jsonb(ro) INTO role_row FROM role ro WHERE ro.tenant_id=p_tenant AND ro.id=(person->>'roleId')::uuid FOR SHARE;
   IF role_row IS NULL OR coalesce((role_row->>'is_admin')::boolean,false) OR coalesce((role_row->>'is_tenant_admin')::boolean,false)
     OR coalesce((role_row->>'requires_organization')::boolean,false) OR coalesce((role_row->>'requires_effective_from_date')::boolean,false)
     OR role_row->>'max_members' IS NOT NULL THEN RAISE EXCEPTION 'Frozen role requires review'; END IF;
   INSERT INTO member(tenant_id,first_name,last_name,email,supplied_organization_name,organization_id,organization_group_id,role_id,login_enabled,
    show_in_directory,communications_opted_out_all,status,is_guest)
   VALUES(p_tenant,person->>'first_name',person->>'last_name',identity,nullif(person->>'organization',''),NULL,NULL,
    (person->>'roleId')::uuid,(person->>'enableLogin')::boolean,false,true,'active',false) RETURNING id INTO member_new;
   output:=output||jsonb_build_array(jsonb_build_object('email',identity,'memberId',member_new));
   IF identity=normalize_public_ticket_email(c.snapshot#>>'{booker,email}') THEN
    UPDATE public_invoice_po_billing SET member_id=member_new WHERE tenant_id=p_tenant AND unified_contract_id=c.id;
    UPDATE unified_booking_invoice SET booker_member_id=member_new WHERE tenant_id=p_tenant AND purchase_key=p_key;
   END IF;
  END LOOP;
  UPDATE unified_booking_invoice SET provision_state='completed',provisioned=output WHERE tenant_id=p_tenant AND purchase_key=p_key;
  RETURN jsonb_build_object('state','completed');
 EXCEPTION WHEN OTHERS THEN
  -- Subtransaction rolls back every optional account insert, never registration.
  UPDATE unified_booking_invoice SET provision_state='needs_review',provision_error_code=CASE SQLERRM
    WHEN 'Provisioning identity requires review' THEN 'identity_missing'
    WHEN 'Existing email requires review' THEN 'existing_email'
    WHEN 'Frozen role requires review' THEN 'frozen_role'
    WHEN 'Conflicting frozen roles' THEN 'conflicting_roles'
    ELSE SQLSTATE END WHERE tenant_id=p_tenant AND purchase_key=p_key;
  RETURN jsonb_build_object('state','needs_review');
 END;
END $$;
CREATE FUNCTION public.unified_booking_provision_due() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r record; result jsonb:='[]'; BEGIN
 FOR r IN SELECT tenant_id,purchase_key FROM unified_booking_invoice WHERE provision_state='pending' ORDER BY created_at LIMIT 5 LOOP
  result:=result||jsonb_build_array(unified_booking_provision(r.tenant_id,r.purchase_key));
 END LOOP;
 RETURN result;
END $$;
CREATE FUNCTION public.unified_booking_link_booker(p_tenant uuid,p_booking uuid,p_complex boolean,p_member uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE b jsonb; c unified_booking_contract; tbl text;
BEGIN
 tbl:=CASE WHEN p_complex THEN 'complex_event_booking' ELSE 'booking' END;
 EXECUTE format('SELECT to_jsonb(b) FROM public.%I b WHERE tenant_id=$1 AND id=$2 FOR UPDATE',tbl)
  INTO b USING p_tenant,p_booking;
 IF b#>>'{purchaser_context,booking_contract_version}' IS DISTINCT FROM '2' THEN RETURN false; END IF;
 SELECT cc.* INTO STRICT c FROM unified_booking_contract cc JOIN unified_booking_invoice i
  ON i.tenant_id=cc.tenant_id AND i.contract_id=cc.id
  WHERE i.tenant_id=p_tenant AND i.source=tbl AND i.purchase_key=b->>'booking_group_reference';
 IF c.member_id IS NOT NULL OR p_member IS NULL THEN RETURN false; END IF;
 IF EXISTS(SELECT 1 FROM unified_booking_invoice WHERE tenant_id=p_tenant AND contract_id=c.id
   AND booker_member_id IS NOT NULL AND booker_member_id<>p_member) THEN RAISE EXCEPTION 'Original booker activity is already linked'; END IF;
 IF NOT EXISTS(SELECT 1 FROM member WHERE id=p_member AND tenant_id=p_tenant
   AND normalize_public_ticket_email(email)=normalize_public_ticket_email(c.snapshot#>>'{booker,email}')) THEN RAISE EXCEPTION 'Original booker activity link mismatch'; END IF;
 IF EXISTS(SELECT 1 FROM public_invoice_po_billing WHERE tenant_id=p_tenant AND unified_contract_id=c.id
    AND member_id IS NOT NULL AND member_id<>p_member) THEN RAISE EXCEPTION 'Booker activity is already linked'; END IF;
 -- Only member activity is associated. Never rewrite original customer,
 -- provider, delivery, settlement or invoice instructions after conversion.
 UPDATE public_invoice_po_billing SET member_id=p_member WHERE tenant_id=p_tenant AND unified_contract_id=c.id;
 UPDATE unified_booking_invoice SET booker_member_id=p_member WHERE tenant_id=p_tenant AND contract_id=c.id;
 RETURN true;
END $$;
DO $$
DECLARE d text; original text; args text;
BEGIN
 IF to_regprocedure('public.create_public_invoice_booker(uuid,uuid,boolean,text,text,text,text,uuid,uuid,date,uuid)') IS NOT NULL THEN
  d:=pg_get_functiondef('public.create_public_invoice_booker(uuid,uuid,boolean,text,text,text,text,uuid,uuid,date,uuid)'::regprocedure);
  original:=$old$b->>'payment_method' IS DISTINCT FROM 'public_invoice_po'$old$;
  IF strpos(d,original)=0 THEN RAISE EXCEPTION 'Manual booker conversion authority changed'; END IF;
  d:=replace(d,original,'('||original||$new$ AND NOT (b#>>'{purchaser_context,booking_contract_version}'='2'
    AND EXISTS(SELECT 1 FROM booking_credit_attempt a WHERE a.tenant_id=p_tenant_id AND a.source=tbl
      AND a.purchase_key=b->>'booking_group_reference' AND a.unified_contract_id IS NOT NULL AND a.state='committed')))$new$);
  EXECUTE d;
  ALTER FUNCTION public.create_public_invoice_booker(uuid,uuid,boolean,text,text,text,text,uuid,uuid,date,uuid)
   RENAME TO unified_booking_legacy_booker_create_core;
  SELECT pg_get_function_arguments('public.unified_booking_legacy_booker_create_core(uuid,uuid,boolean,text,text,text,text,uuid,uuid,date,uuid)'::regprocedure) INTO args;
  EXECUTE 'CREATE FUNCTION public.create_public_invoice_booker('||args||') RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $body$
    DECLARE result jsonb; BEGIN
      result:=unified_booking_legacy_booker_create_core(p_tenant_id,p_booking_id,p_complex,p_first_name,p_last_name,p_email,
        p_supplied_organization_name,p_organization_id,p_role_id,p_role_effective_from,p_organization_group_id);
      PERFORM unified_booking_link_booker(p_tenant_id,p_booking_id,p_complex,(result#>>''{member,id}'')::uuid);
      RETURN result;
    END $body$';
  REVOKE ALL ON FUNCTION public.create_public_invoice_booker(uuid,uuid,boolean,text,text,text,text,uuid,uuid,date,uuid) FROM PUBLIC,anon,authenticated,service_role;
  GRANT EXECUTE ON FUNCTION public.create_public_invoice_booker(uuid,uuid,boolean,text,text,text,text,uuid,uuid,date,uuid) TO service_role;
 END IF;
END $$;
CREATE FUNCTION public.unified_booking_invoice_claim() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r unified_booking_invoice;
BEGIN
 SELECT * INTO r FROM unified_booking_invoice WHERE (state='pending' OR (state='processing' AND lease_until<now()))
 AND next_at<=now() ORDER BY next_at,created_at LIMIT 1 FOR UPDATE SKIP LOCKED;
 IF NOT FOUND THEN RETURN NULL; END IF;
 UPDATE unified_booking_invoice SET state='processing',lease_token=gen_random_uuid(),lease_until=now()+interval '2 minutes',attempts=attempts+1
 WHERE tenant_id=r.tenant_id AND purchase_key=r.purchase_key RETURNING * INTO r;
 RETURN to_jsonb(r);
END $$;
CREATE FUNCTION public.unified_booking_invoice_finish(p_tenant uuid,p_key text,p_token uuid,p_success boolean,p_error text DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 UPDATE unified_booking_invoice SET state=CASE WHEN p_success THEN 'queued' ELSE 'pending' END,
 next_at=now()+interval '5 minutes',last_error=left(p_error,300),lease_until=NULL
 WHERE tenant_id=p_tenant AND purchase_key=p_key AND lease_token=p_token AND state='processing';
 RETURN FOUND;
END $$;
-- A committed v2 outbox, not today's clock or a fabricated approval, is the
-- authority for delayed QuickBooks capture. Legacy 15-minute/one-hour gates
-- remain byte-for-byte effective for every operation without this evidence.
DO $$
DECLARE d text; original text; authority text;
BEGIN
 IF to_regprocedure('public.accounting_event_capture(uuid,text,text,text,text,jsonb)') IS NOT NULL THEN
  d:=pg_get_functiondef('public.accounting_event_capture(uuid,text,text,text,text,jsonb)'::regprocedure);
  authority:=$guard$NOT EXISTS(SELECT 1 FROM public.unified_booking_invoice u
    JOIN public.booking_credit_attempt a ON a.tenant_id=u.tenant_id AND a.purchase_key=u.purchase_key
    WHERE u.tenant_id=p_tenant AND u.source=p_source AND u.purchase_key=p_group
      AND a.state='committed' AND u.prepared->>'provider'='quickbooks'
      AND u.prepared->'snapshot'=p_snapshot
      AND u.prepared#>>'{snapshot,approvalProvider,connectionId}'=p_connection
      AND u.prepared#>>'{snapshot,approvalProvider,realmId}'=p_company)$guard$;
  original:=$old$coalesce((p_snapshot#>>'{invoice,capturedAt}')::timestamptz,'-infinity') NOT BETWEEN now()-interval '15 minutes' AND now()+interval '1 minute'$old$;
  IF strpos(d,original)=0 THEN RAISE EXCEPTION 'QuickBooks snapshot-age guard changed'; END IF;
  d:=replace(d,original,'('||original||' AND '||authority||')');
  -- This is inside a dynamic query; reference USING arguments, not PL/pgSQL
  -- parameter names, and escape SQL literals for that containing string.
  original:=$old$coalesce((j->>''created_at'')::timestamptz,''-infinity'')<now()-interval ''1 hour''$old$;
  IF strpos(d,original)=0 THEN RAISE EXCEPTION 'QuickBooks booking-age guard changed'; END IF;
  d:=replace(d,original,'('||original||$new$ AND NOT EXISTS(SELECT 1 FROM public.unified_booking_invoice u
    JOIN public.booking_credit_attempt a ON a.tenant_id=u.tenant_id AND a.purchase_key=u.purchase_key
    WHERE u.tenant_id=$1 AND u.purchase_key=$2 AND u.source=$5 AND u.prepared->''snapshot''=$4
      AND a.state=''committed'' AND u.prepared->>''provider''=''quickbooks''))$new$);
  original:=$old$INTO invalid USING p_tenant,p_group,p_snapshot#>>'{invoice,eventId}';$old$;
  IF strpos(d,original)=0 THEN RAISE EXCEPTION 'QuickBooks capture parameter guard changed'; END IF;
  d:=replace(d,original,$new$INTO invalid USING p_tenant,p_group,p_snapshot#>>'{invoice,eventId}',p_snapshot,p_source;$new$);
  EXECUTE d;
 END IF;
END $$;
-- Immutable authority even to direct service-role writes; narrowly scoped RPCs
-- are the only writers and can only fill previously absent payment fields.
CREATE FUNCTION public.unified_booking_contract_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF ROW(NEW.id,NEW.tenant_id,NEW.source,NEW.event_id,NEW.member_id,NEW.snapshot,NEW.created_at)
  IS DISTINCT FROM ROW(OLD.id,OLD.tenant_id,OLD.source,OLD.event_id,OLD.member_id,OLD.snapshot,OLD.created_at)
  OR (OLD.payment_parameters IS NOT NULL AND NEW.payment_parameters IS DISTINCT FROM OLD.payment_parameters)
  OR (OLD.payment_requested_at IS NOT NULL AND NEW.payment_requested_at IS DISTINCT FROM OLD.payment_requested_at)
  OR (OLD.payment_intent_id IS NOT NULL AND NEW.payment_intent_id IS DISTINCT FROM OLD.payment_intent_id) THEN RAISE EXCEPTION 'Booking instructions are immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER unified_booking_contract_immutable BEFORE UPDATE ON public.unified_booking_contract FOR EACH ROW EXECUTE FUNCTION public.unified_booking_contract_immutable();
DO $$ DECLARE f record; BEGIN
 FOR f IN SELECT oid::regprocedure signature FROM pg_proc WHERE pronamespace='public'::regnamespace
  AND proname LIKE 'unified_booking_%' LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',f.signature);
  IF f.signature::text NOT LIKE '%_core(%' AND f.signature::text NOT LIKE '%_immutable(%' THEN
   EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',f.signature);
  END IF;
 END LOOP;
END $$;
COMMIT;
