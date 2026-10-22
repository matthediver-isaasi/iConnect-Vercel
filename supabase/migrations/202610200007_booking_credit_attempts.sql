-- Voucher-funded booking rows and all internal funding commit together.
-- No remote/provider call is performed inside these service-role-only RPCs.
BEGIN;
CREATE TABLE public.booking_credit_attempt (
  tenant_id uuid NOT NULL, purchase_key text NOT NULL, member_id uuid NOT NULL,
  source text NOT NULL CHECK(source IN ('booking','complex_event_booking')),
  fingerprint text NOT NULL, fence uuid NOT NULL, lease_until timestamptz NOT NULL,
  state text NOT NULL CHECK(state IN ('preparing','failed','committed','reversed')),
  response jsonb, funding jsonb, event_id uuid,
  invoice_state text NOT NULL DEFAULT 'pending' CHECK(invoice_state IN ('pending','complete')),
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,purchase_key)
);
ALTER TABLE public.booking_credit_attempt ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.booking_credit_attempt FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.booking_credit_attempt TO service_role;
CREATE POLICY booking_credit_attempt_service ON public.booking_credit_attempt TO service_role USING(true) WITH CHECK(true);

CREATE FUNCTION public.booking_credit_begin(p_tenant_id uuid,p_purchase_key text,p_fence uuid,
 p_member_id uuid,p_source text,p_fingerprint text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE a public.booking_credit_attempt%ROWTYPE;
BEGIN
 IF p_source NOT IN ('booking','complex_event_booking') OR p_tenant_id IS NULL OR p_member_id IS NULL
   OR p_fence IS NULL OR length(p_purchase_key)>100 OR length(p_fingerprint)<>64 THEN RAISE EXCEPTION 'Invalid booking attempt'; END IF;
 PERFORM 1 FROM public.member WHERE id=p_member_id AND tenant_id=p_tenant_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'Purchaser is outside tenant'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant_id::text||':'||p_purchase_key,0));
 SELECT * INTO a FROM public.booking_credit_attempt WHERE tenant_id=p_tenant_id AND purchase_key=p_purchase_key FOR UPDATE;
 IF FOUND THEN
   IF a.member_id<>p_member_id OR a.source<>p_source OR a.fingerprint<>p_fingerprint THEN RAISE EXCEPTION 'Purchase request changed; use a new request identifier'; END IF;
   IF a.state IN ('committed','reversed') THEN RETURN jsonb_build_object('response',a.response); END IF;
   IF a.state='preparing' AND a.lease_until>now() THEN RAISE EXCEPTION 'Purchase is already processing; retry without paying again'; END IF;
   UPDATE public.booking_credit_attempt SET state='preparing',fence=p_fence,lease_until=now()+interval '5 minutes'
     WHERE tenant_id=p_tenant_id AND purchase_key=p_purchase_key;
 ELSE
   INSERT INTO public.booking_credit_attempt(tenant_id,purchase_key,member_id,source,fingerprint,fence,lease_until,state)
   VALUES(p_tenant_id,p_purchase_key,p_member_id,p_source,p_fingerprint,p_fence,now()+interval '5 minutes','preparing');
 END IF;
 RETURN jsonb_build_object('purchaseKey',p_purchase_key);
END $$;

CREATE FUNCTION public.booking_credit_finish(p_tenant_id uuid,p_purchase_key text,p_fence uuid,p_response jsonb,p_success boolean)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE a public.booking_credit_attempt%ROWTYPE;
BEGIN
 SELECT * INTO STRICT a FROM public.booking_credit_attempt WHERE tenant_id=p_tenant_id AND purchase_key=p_purchase_key FOR UPDATE;
 IF a.state IN ('committed','reversed') THEN
   IF a.state='committed' AND p_success AND a.fence=p_fence THEN
     UPDATE public.booking_credit_attempt SET response=a.response||p_response,finished_at=now(),
       invoice_state=CASE WHEN p_response->'invoice_recovery'->>'queued'='true'
         OR p_response->'invoice_recovery'->>'status'='not_applicable' THEN 'complete' ELSE invoice_state END
       WHERE tenant_id=p_tenant_id AND purchase_key=p_purchase_key;
     RETURN a.response||p_response;
   END IF;
   RETURN a.response;
 END IF;
 IF a.fence<>p_fence THEN RAISE EXCEPTION 'Booking attempt fence expired'; END IF;
 IF p_success THEN RAISE EXCEPTION 'Booking credit was not finalized'; END IF;
 UPDATE public.booking_credit_attempt SET state='failed',response=p_response WHERE tenant_id=p_tenant_id AND purchase_key=p_purchase_key;
 RETURN p_response;
END $$;

CREATE FUNCTION public.booking_credit_finalize(p_tenant_id uuid,p_purchase_key text,p_fence uuid,
 p_event_id uuid,p_rows jsonb,p_funding jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE a public.booking_credit_attempt%ROWTYPE; m public.member%ROWTYPE; o public.organization%ROWTYPE;
 d public.discount_code%ROWTYPE; du public.discount_code_usage%ROWTYPE;
 r jsonb; inserted jsonb; rows_out jsonb:='[]'; allocation jsonb; ids uuid[]; cols text; vals text;
 tf numeric:=coalesce((p_funding->>'trainingFundMinor')::numeric,0)/100;
 account numeric:=coalesce((p_funding->>'accountMinor')::numeric,0)/100;
 payable bigint:=(p_funding->>'payableMinor')::bigint; expected bigint:=(p_funding->>'voucherMinor')::bigint;
 target_member boolean; dc text; capacity jsonb; result jsonb; event_table text; class_id text; event_start timestamptz;
BEGIN
 SELECT * INTO STRICT a FROM public.booking_credit_attempt WHERE tenant_id=p_tenant_id AND purchase_key=p_purchase_key FOR UPDATE;
 IF a.state='committed' THEN RETURN a.response; END IF;
 IF a.state<>'preparing' OR a.fence<>p_fence OR a.lease_until<=now() THEN RAISE EXCEPTION 'Booking attempt fence expired'; END IF;
 IF jsonb_typeof(p_rows)<>'array' OR jsonb_array_length(p_rows)<1 OR payable<0 OR expected<0 OR tf<0 OR account<0 THEN RAISE EXCEPTION 'Invalid booking funding'; END IF;
 SELECT * INTO STRICT m FROM public.member WHERE id=a.member_id AND tenant_id=p_tenant_id;
 IF m.organization_id IS DISTINCT FROM nullif(p_funding->>'expectedOrganizationId','')::uuid THEN
   RAISE EXCEPTION 'Purchasing organization changed; refresh checkout';
 END IF;
 event_table:=CASE WHEN a.source='booking' THEN 'event' ELSE 'complex_event' END;
 EXECUTE format('SELECT to_jsonb(e) FROM public.%I e WHERE id=$1 AND tenant_id=$2 FOR UPDATE',event_table) INTO inserted USING p_event_id,p_tenant_id;
 IF inserted IS NULL THEN RAISE EXCEPTION 'Event outside tenant'; END IF;
 event_start:=nullif(inserted->>'start_date','')::timestamptz;
 IF EXISTS(SELECT 1 FROM public.system_settings WHERE tenant_id=p_tenant_id AND setting_key='event_allow_voucher_payment' AND lower(trim(setting_value))='false')
   OR (tf>0 AND EXISTS(SELECT 1 FROM public.system_settings WHERE tenant_id=p_tenant_id AND setting_key='event_allow_training_fund_payment' AND lower(trim(setting_value))='false'))
   THEN RAISE EXCEPTION 'Event funding policy changed'; END IF;
 IF EXISTS(SELECT 1 FROM public.system_settings WHERE tenant_id=p_tenant_id AND setting_key='allow_voucher_use_after_expiry' AND lower(trim(setting_value))='false') THEN
   IF event_start IS NULL AND a.source='complex_event_booking' THEN
     SELECT min(start_time) INTO event_start FROM public.complex_event_session WHERE complex_event_id=p_event_id;
   END IF;
   IF EXISTS(SELECT 1 FROM public.voucher WHERE tenant_id=p_tenant_id
      AND id IN (SELECT value::uuid FROM jsonb_array_elements_text(p_funding->'voucherIds')) AND expires_at<=event_start)
      THEN RAISE EXCEPTION 'Voucher expires before event'; END IF;
 END IF;
 IF inserted->>'available_seats' IS NOT NULL AND
   (a.source='complex_event_booking' OR coalesce((inserted->>'is_unlimited_registration')::boolean,false)=false) THEN
   IF (inserted->>'available_seats')::integer<jsonb_array_length(p_rows) THEN RAISE EXCEPTION 'Event capacity unavailable'; END IF;
   EXECUTE format('UPDATE public.%I SET available_seats=available_seats-$1 WHERE id=$2 AND tenant_id=$3',event_table)
     USING jsonb_array_length(p_rows),p_event_id,p_tenant_id;
 END IF;
 -- DEST has no organization.account_balance or authoritative account-credit
 -- ledger. Do not invent balances; callers must use invoice liability instead.
 IF account>0 THEN RAISE EXCEPTION 'Stored account credit is unavailable; use the invoiced payment path'; END IF;
 IF tf>0 THEN
   SELECT * INTO STRICT o FROM public.organization WHERE id=m.organization_id AND tenant_id=p_tenant_id FOR UPDATE;
   IF tf>coalesce(o.training_fund_balance,0) THEN RAISE EXCEPTION 'Internal balance changed'; END IF;
   IF tf>0 AND jsonb_array_length(coalesce(to_jsonb(o.training_fund_allowed_role_ids),'[]'))>0
     AND NOT coalesce(to_jsonb(o.training_fund_allowed_role_ids),'[]') ? m.role_id::text THEN RAISE EXCEPTION 'Training fund role not permitted'; END IF;
   UPDATE public.organization SET training_fund_balance=coalesce(training_fund_balance,0)-tf WHERE id=o.id;
   IF tf>0 THEN
     INSERT INTO public.training_fund_transaction(tenant_id,organization_id,type,amount,balance_before,balance_after,reason)
     VALUES(p_tenant_id,o.id,'booking_usage',tf,o.training_fund_balance,o.training_fund_balance-tf,'Event booking '||p_purchase_key);
   END IF;
 END IF;
 FOR dc IN SELECT DISTINCT value FROM jsonb_array_elements_text(coalesce(p_funding->'discountIds','[]')) LOOP
   SELECT * INTO STRICT d FROM public.discount_code WHERE id=dc::uuid AND tenant_id=p_tenant_id FOR UPDATE;
   IF (d.organization_id IS NOT NULL AND d.organization_id IS DISTINCT FROM m.organization_id)
     OR (d.member_id IS NOT NULL AND d.member_id<>m.id)
     OR (d.role_id IS NOT NULL AND d.role_id IS DISTINCT FROM m.role_id)
     THEN RAISE EXCEPTION 'Discount purchaser eligibility changed'; END IF;
   IF d.member_group_id IS NOT NULL THEN
     PERFORM 1 FROM public.member_group_assignment WHERE member_id=m.id AND group_id=d.member_group_id;
     IF NOT FOUND THEN RAISE EXCEPTION 'Discount group eligibility changed'; END IF;
   END IF;
   target_member:=d.member_id IS NOT NULL OR d.role_id IS NOT NULL OR d.member_group_id IS NOT NULL;
   du:=NULL;
   IF target_member THEN SELECT * INTO du FROM public.discount_code_usage WHERE discount_code_id=d.id AND member_id=m.id FOR UPDATE; END IF;
   IF NOT d.is_active OR d.expires_at<=now() OR (d.max_usage_count IS NOT NULL AND
     CASE WHEN target_member THEN coalesce(du.usage_count,0) ELSE coalesce(d.current_usage_count,0) END>=d.max_usage_count)
     THEN RAISE EXCEPTION 'Discount no longer available'; END IF;
   IF NOT target_member THEN UPDATE public.discount_code SET current_usage_count=coalesce(current_usage_count,0)+1 WHERE id=d.id; END IF;
   IF target_member OR m.organization_id IS NOT NULL THEN
     IF NOT target_member THEN SELECT * INTO du FROM public.discount_code_usage WHERE discount_code_id=d.id AND organization_id=m.organization_id AND member_id IS NULL FOR UPDATE; END IF;
     IF du.id IS NULL THEN INSERT INTO public.discount_code_usage(tenant_id,discount_code_id,organization_id,member_id,usage_count)
       VALUES(p_tenant_id,d.id,m.organization_id,CASE WHEN target_member THEN m.id END,1);
     ELSE UPDATE public.discount_code_usage SET usage_count=coalesce(usage_count,0)+1 WHERE id=du.id; END IF;
   END IF;
 END LOOP;
 SELECT array_agg(value::uuid) INTO ids FROM jsonb_array_elements_text(p_funding->'voucherIds');
 allocation:=public.voucher_credit_reserve(p_tenant_id,p_purchase_key,m.id,m.id,ids,payable,
   coalesce(p_funding->>'currency','GBP'),true,coalesce((p_funding->>'manualOrder')::boolean,false));
 IF (allocation->>'voucherMinor')::bigint<>expected THEN RAISE EXCEPTION 'Voucher balance changed'; END IF;
 FOR r IN SELECT value FROM jsonb_array_elements(p_rows) LOOP
   r:=r||jsonb_build_object('id',gen_random_uuid(),'tenant_id',p_tenant_id,'event_id',p_event_id,
     'booking_group_reference',p_purchase_key,'member_id',m.id);
   -- Populate only supplied real columns, retaining defaults for every other column.
   SELECT string_agg(format('%I',key),','),string_agg(format('(x.r).%I',key),',') INTO cols,vals
     FROM jsonb_object_keys(r) key WHERE EXISTS(SELECT 1 FROM information_schema.columns c WHERE c.table_schema='public' AND c.table_name=a.source AND c.column_name=key);
   EXECUTE format('INSERT INTO public.%I (%s) SELECT %s FROM (SELECT jsonb_populate_record(NULL::public.%I,$1) r) x RETURNING to_jsonb(%I.*)',
     a.source,cols,vals,a.source,a.source) INTO inserted USING r;
   rows_out:=rows_out||jsonb_build_array(inserted);
 END LOOP;
 -- Claim converts an existing commercial reservation into named usage. Do it
 -- before the deployed capacity RPC counts commercialUnused + named bookings,
 -- otherwise the same invitation is counted twice at the capacity boundary.
 IF p_funding->>'allocationTokenHash' IS NOT NULL THEN
   SELECT value INTO inserted FROM jsonb_array_elements(rows_out) WHERE value->>'ticket_class_id'=p_funding->>'allocationTicketId' LIMIT 1;
   IF inserted IS NULL THEN RAISE EXCEPTION 'Allocation booking missing'; END IF;
   PERFORM public.claim_sales_allocation_invitation(p_funding->>'allocationTokenHash',
     CASE WHEN a.source='booking' THEN 'simple' ELSE 'complex' END,(inserted->>'id')::uuid);
 END IF;
 FOR class_id IN SELECT DISTINCT value->>'ticket_class_id' FROM jsonb_array_elements(rows_out) WHERE value->>'ticket_class_id' IS NOT NULL LOOP
   SELECT array_agg((value->>'id')::uuid) INTO ids FROM jsonb_array_elements(rows_out) WHERE value->>'ticket_class_id'=class_id;
   IF a.source='booking' THEN
     SELECT public.check_oneoff_ticket_capacity(p_event_id,class_id,cardinality(ids),ids) INTO capacity;
   ELSE
     SELECT public.check_complex_event_ticket_capacity(p_event_id,class_id,cardinality(ids),ids) INTO capacity;
   END IF;
   IF capacity->>'ok'='false' THEN RAISE EXCEPTION 'Ticket capacity unavailable'; END IF;
 END LOOP;
 allocation:=public.voucher_credit_transition(p_tenant_id,p_purchase_key,'commit',NULL);
 result:=jsonb_build_object('success',true,'bookings',rows_out,'booking_group_reference',p_purchase_key,
   'booking_reference',p_purchase_key,'credit',allocation,'event_title',p_funding->>'eventTitle');
 UPDATE public.booking_credit_attempt SET state='committed',response=result,
   funding=p_funding||jsonb_build_object('organizationId',m.organization_id,'voucherFunding',allocation->'allocations'),event_id=p_event_id
   WHERE tenant_id=p_tenant_id AND purchase_key=p_purchase_key;
 RETURN result;
END $$;
CREATE FUNCTION public.booking_credit_reverse(p_tenant_id uuid,p_purchase_key text,p_fence uuid,p_provider_outcome text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE a public.booking_credit_attempt%ROWTYPE; m public.member%ROWTYPE; d public.discount_code%ROWTYPE;
 tf numeric; account numeric; dc text; amount_before numeric; booking_ids uuid[]; result jsonb;
 target_member boolean; event_table text; event_row jsonb;
BEGIN
 IF p_provider_outcome NOT IN ('not_started','failed','cancelled','refunded') OR p_provider_outcome IS NULL THEN
   RAISE EXCEPTION 'Reconcile provider outcome before reversing booking'; END IF;
 SELECT * INTO STRICT a FROM public.booking_credit_attempt WHERE tenant_id=p_tenant_id AND purchase_key=p_purchase_key FOR UPDATE;
 IF a.state='reversed' THEN RETURN a.response; END IF;
 IF a.state<>'committed' OR a.fence<>p_fence THEN RAISE EXCEPTION 'Invalid booking reversal fence'; END IF;
 IF a.finished_at IS NOT NULL THEN RAISE EXCEPTION 'Completed checkout requires the booking cancellation flow'; END IF;
 IF a.funding->>'paymentIntentId' IS NOT NULL AND p_provider_outcome<>'refunded' THEN RAISE EXCEPTION 'Captured payment refund evidence required'; END IF;
 SELECT * INTO STRICT m FROM public.member WHERE id=a.member_id AND tenant_id=p_tenant_id;
 tf:=coalesce((a.funding->>'trainingFundMinor')::numeric,0)/100;
 account:=coalesce((a.funding->>'accountMinor')::numeric,0)/100;
 -- Organisation provenance is frozen when finalized, not the member's current affiliation.
 IF account>0 THEN RAISE EXCEPTION 'Stored account credit requires reconciliation'; END IF;
 IF tf>0 THEN
   SELECT training_fund_balance INTO STRICT amount_before FROM public.organization
     WHERE id=(a.funding->>'organizationId')::uuid AND tenant_id=p_tenant_id FOR UPDATE;
   UPDATE public.organization SET training_fund_balance=coalesce(training_fund_balance,0)+tf
     WHERE id=(a.funding->>'organizationId')::uuid AND tenant_id=p_tenant_id;
   IF tf>0 THEN INSERT INTO public.training_fund_transaction(tenant_id,organization_id,type,amount,balance_before,balance_after,reason)
     -- Deployed training_fund_transaction type CHECK supports 'add', not
     -- 'cancellation_refund'. Retain explicit cancellation provenance in reason.
     VALUES(p_tenant_id,(a.funding->>'organizationId')::uuid,'add',tf,amount_before,amount_before+tf,'Booking compensation '||p_purchase_key); END IF;
 END IF;
 FOR dc IN SELECT DISTINCT value FROM jsonb_array_elements_text(coalesce(a.funding->'discountIds','[]')) LOOP
   SELECT * INTO STRICT d FROM public.discount_code WHERE id=dc::uuid AND tenant_id=p_tenant_id FOR UPDATE;
   target_member:=d.member_id IS NOT NULL OR d.role_id IS NOT NULL OR d.member_group_id IS NOT NULL;
   IF NOT target_member THEN UPDATE public.discount_code SET current_usage_count=greatest(0,coalesce(current_usage_count,0)-1) WHERE id=d.id; END IF;
   UPDATE public.discount_code_usage SET usage_count=greatest(0,coalesce(usage_count,0)-1) WHERE discount_code_id=d.id
     AND CASE WHEN target_member THEN member_id=a.member_id
       ELSE organization_id=(a.funding->>'organizationId')::uuid AND member_id IS NULL END;
 END LOOP;
 PERFORM public.voucher_credit_transition(p_tenant_id,p_purchase_key,'release',
   CASE WHEN p_provider_outcome IN ('not_started','failed') THEN 'cancelled' ELSE p_provider_outcome END);
 SELECT array_agg((value->>'id')::uuid) INTO booking_ids FROM jsonb_array_elements(a.response->'bookings');
 EXECUTE format('DELETE FROM public.%I WHERE tenant_id=$1 AND id=ANY($2)',a.source) USING p_tenant_id,booking_ids;
 event_table:=CASE WHEN a.source='booking' THEN 'event' ELSE 'complex_event' END;
 EXECUTE format('SELECT to_jsonb(e) FROM public.%I e WHERE id=$1 AND tenant_id=$2 FOR UPDATE',event_table) INTO event_row USING a.event_id,p_tenant_id;
 IF event_row->>'available_seats' IS NOT NULL AND (a.source='complex_event_booking' OR coalesce((event_row->>'is_unlimited_registration')::boolean,false)=false) THEN
   EXECUTE format('UPDATE public.%I SET available_seats=available_seats+$1 WHERE id=$2 AND tenant_id=$3',event_table)
     USING cardinality(booking_ids),a.event_id,p_tenant_id;
 END IF;
 result:=jsonb_build_object('success',false,'error','Booking reversed','refunded',p_provider_outcome='refunded');
 UPDATE public.booking_credit_attempt SET state='reversed',response=result WHERE tenant_id=p_tenant_id AND purchase_key=p_purchase_key;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.booking_credit_begin(uuid,text,uuid,uuid,text,text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.booking_credit_finish(uuid,text,uuid,jsonb,boolean) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.booking_credit_finalize(uuid,text,uuid,uuid,jsonb,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.booking_credit_begin(uuid,text,uuid,uuid,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.booking_credit_finish(uuid,text,uuid,jsonb,boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.booking_credit_finalize(uuid,text,uuid,uuid,jsonb,jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.booking_credit_reverse(uuid,text,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.booking_credit_reverse(uuid,text,uuid,text) TO service_role;
COMMIT;
