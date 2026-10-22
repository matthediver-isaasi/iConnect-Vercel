-- Task 5241: bounded owner-preserving cancellation parity. Apply after 0001.
-- Does NOT authorize cancellation or alter replacement policy: callers must
-- authorize both. Expired vouchers without explicit replacement remain skipped.
BEGIN;
CREATE TABLE public.voucher_booking_refund (
  tenant_id uuid NOT NULL,
  source text NOT NULL CHECK (source IN ('booking','complex_event_booking')),
  booking_id uuid NOT NULL,
  voucher_id uuid NOT NULL REFERENCES public.voucher(id),
  usage_reference text NOT NULL,
  amount_minor bigint NOT NULL CHECK(amount_minor>0),
  replacement_voucher_id uuid REFERENCES public.voucher(id),
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,source,booking_id,voucher_id)
);
ALTER TABLE public.voucher_booking_refund ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.voucher_booking_refund FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.voucher_booking_refund TO service_role;
CREATE POLICY voucher_booking_refund_service ON public.voucher_booking_refund TO service_role USING(true) WITH CHECK(true);

-- Freeze attendee funding attribution on first cancellation. Integer intervals
-- distribute fractional attendee pennies deterministically without losing any
-- of the original per-voucher minor units. Zero shares are persisted too.
CREATE TABLE public.voucher_booking_credit_share (
 tenant_id uuid NOT NULL,source text NOT NULL CHECK(source IN ('booking','complex_event_booking')),
 booking_id uuid NOT NULL,allocation_id uuid NOT NULL REFERENCES public.voucher_credit_allocation(id),
 amount_minor bigint NOT NULL CHECK(amount_minor>=0),
 PRIMARY KEY(tenant_id,source,booking_id,allocation_id)
);
ALTER TABLE public.voucher_booking_credit_share ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.voucher_booking_credit_share FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.voucher_booking_credit_share TO service_role;
CREATE POLICY voucher_booking_credit_share_service ON public.voucher_booking_credit_share TO service_role USING(true);

CREATE FUNCTION public.voucher_credit_refund_booking(p_tenant_id uuid,p_booking_id uuid,p_source text,
 p_refund_allocation jsonb,p_reversal_options jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
 b jsonb; ref text; group_ref text; refs text[]; budget bigint; refunded bigint;
 usage record; v public.voucher%ROWTYPE; replacement public.voucher%ROWTYPE;
 prior public.voucher_booking_refund%ROWTYPE; amount bigint; available bigint; selected numeric;
 new_expiry timestamptz; label text; item jsonb; items jsonb := '[]'; replacements jsonb := '[]';
 previous_flag text := current_setting('app.voucher_credit_write',true);
 previous_reversal text := current_setting('app.voucher_credit_reversal',true);
 v_purchase_id uuid; share_minor bigint;
BEGIN
 IF p_tenant_id IS NULL OR p_booking_id IS NULL OR p_source IS NULL
   OR p_source NOT IN ('booking','complex_event_booking')
   OR jsonb_typeof(coalesce(p_refund_allocation,'{}'))<>'object'
   OR jsonb_typeof(coalesce(p_reversal_options,'{}'))<>'object' THEN
   RAISE EXCEPTION 'Invalid booking voucher refund request';
 END IF;
 EXECUTE format('SELECT to_jsonb(b) FROM public.%I b WHERE b.id=$1 AND b.tenant_id=$2',p_source)
   INTO b USING p_booking_id,p_tenant_id;
 IF b IS NULL THEN RAISE EXCEPTION 'Booking not found in tenant'; END IF;
 ref := nullif(b->>'booking_reference','');
 group_ref := coalesce(nullif(b->>'booking_group_reference',''),ref);
 budget := greatest(0,floor(coalesce((b->>'voucher_amount')::numeric,0)*100)::bigint);
 IF ref IS NULL THEN RETURN jsonb_build_object('vouchers',items,'replacements',replacements); END IF;
 -- Same lock as reserve/transition; prevents group-release vs booking-refund races.
 PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant_id::text||':'||group_ref,0));
 EXECUTE format('SELECT to_jsonb(b) FROM public.%I b WHERE b.id=$1 AND b.tenant_id=$2 FOR UPDATE',p_source)
   INTO b USING p_booking_id,p_tenant_id;
 budget := greatest(0,floor(coalesce((b->>'voucher_amount')::numeric,0)*100)::bigint);
 IF coalesce(nullif(b->>'booking_group_reference',''),b->>'booking_reference') IS DISTINCT FROM group_ref THEN
   RAISE EXCEPTION 'Booking provenance changed; retry cancellation';
 END IF;
 EXECUTE format('SELECT array_agg(b.booking_reference) FROM public.%I b WHERE b.tenant_id=$1
   AND (coalesce(nullif(to_jsonb(b)->>''booking_group_reference'',''''),b.booking_reference)=$2 OR b.booking_reference=$2)',p_source)
   INTO refs USING p_tenant_id,group_ref;
 refs := array_append(coalesce(refs,ARRAY[]::text[]),group_ref);
 SELECT p.id INTO v_purchase_id FROM public.voucher_credit_purchase p
   WHERE p.tenant_id=p_tenant_id AND p.purchase_key=group_ref
     AND EXISTS(SELECT 1 FROM public.voucher_transaction t
       JOIN public.voucher_credit_allocation a ON a.id=t.allocation_id
       WHERE a.purchase_id=p.id AND t.tenant_id=p_tenant_id AND t.type='booking_usage');
 IF v_purchase_id IS NOT NULL THEN
   IF NOT EXISTS(SELECT 1 FROM public.voucher_booking_credit_share s
      JOIN public.voucher_credit_allocation a ON a.id=s.allocation_id
      WHERE a.purchase_id=v_purchase_id AND s.tenant_id=p_tenant_id AND s.source=p_source) THEN
     -- Attendee rows historically store fractional major-unit shares (e.g.
     -- 20/3). Round cumulative boundaries, never each attendee down. Intersect
     -- those boundaries with original ordered voucher allocation boundaries.
     EXECUTE format($shares$
       INSERT INTO public.voucher_booking_credit_share(tenant_id,source,booking_id,allocation_id,amount_minor)
       WITH bookings AS (
         SELECT b.id,greatest(0,coalesce(b.voucher_amount,0)) AS raw
         FROM public.%I b WHERE b.tenant_id=$1
           AND coalesce(nullif(to_jsonb(b)->>'booking_group_reference',''),b.booking_reference)=$2
       ), attendee_ranges AS (
         SELECT id,round(coalesce(sum(raw) OVER(ORDER BY id ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),0)*100)::bigint AS lo,
           round(sum(raw) OVER(ORDER BY id ROWS UNBOUNDED PRECEDING)*100)::bigint AS hi FROM bookings
       ), allocation_ranges AS (
         SELECT a.id,coalesce(sum(a.amount_minor) OVER(ORDER BY a.ordinal,a.id ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),0)::bigint AS lo,
           sum(a.amount_minor) OVER(ORDER BY a.ordinal,a.id ROWS UNBOUNDED PRECEDING)::bigint AS hi
         FROM public.voucher_credit_allocation a WHERE a.purchase_id=$3 AND a.tenant_id=$1
       )
       SELECT $1,$4,b.id,a.id,greatest(0,least(b.hi,a.hi)-greatest(b.lo,a.lo))
       FROM attendee_ranges b CROSS JOIN allocation_ranges a
       ON CONFLICT DO NOTHING
     $shares$,p_source) USING p_tenant_id,group_ref,v_purchase_id,p_source;
   END IF;
   SELECT coalesce(sum(s.amount_minor),0)::bigint INTO budget
     FROM public.voucher_booking_credit_share s WHERE s.tenant_id=p_tenant_id AND s.source=p_source
       AND s.booking_id=p_booking_id AND s.allocation_id IN (
         SELECT id FROM public.voucher_credit_allocation WHERE purchase_id=v_purchase_id);
 END IF;
 -- Prior legacy and new refunds both consume this booking's fixed credit cap.
 SELECT coalesce(round(sum(t.amount)*100)::bigint,0) INTO refunded FROM public.voucher_transaction t
   WHERE t.tenant_id=p_tenant_id AND t.booking_reference=ref AND t.type='cancellation_refund';
 budget := greatest(0,budget-refunded);
 PERFORM 1 FROM public.voucher WHERE tenant_id=p_tenant_id AND id IN (
   SELECT voucher_id FROM public.voucher_transaction WHERE tenant_id=p_tenant_id AND booking_reference=group_ref AND type='booking_usage'
 ) ORDER BY id FOR UPDATE;
 PERFORM set_config('app.voucher_credit_write','yes',true);
 FOR usage IN
   SELECT t.voucher_id,sum(t.amount) AS amount,
     (array_agg(t.allocation_id) FILTER(WHERE t.allocation_id IS NOT NULL))[1] AS allocation_id,
     min(t.created_at) AS used_at
   FROM public.voucher_transaction t WHERE t.tenant_id=p_tenant_id
     AND t.booking_reference=group_ref AND t.type='booking_usage'
     -- Legacy complex single-voucher bookings keep their original restriction.
     AND (v_purchase_id IS NOT NULL OR p_source<>'complex_event_booking'
       OR nullif(b->>'voucher_id','') IS NULL OR t.voucher_id::text=b->>'voucher_id')
   GROUP BY t.voucher_id ORDER BY min(t.created_at),t.voucher_id
 LOOP
   SELECT * INTO STRICT v FROM public.voucher WHERE id=usage.voucher_id AND tenant_id=p_tenant_id;
   SELECT * INTO prior FROM public.voucher_booking_refund WHERE tenant_id=p_tenant_id
     AND source=p_source AND booking_id=p_booking_id AND voucher_id=v.id;
   IF FOUND THEN items := items || jsonb_build_array(prior.result); CONTINUE; END IF;
   IF EXISTS(SELECT 1 FROM public.voucher_transaction t WHERE t.tenant_id=p_tenant_id
     AND t.voucher_id=v.id AND t.booking_reference=ref AND t.type='cancellation_refund') THEN
     items := items || jsonb_build_array(jsonb_build_object('voucherId',v.id,'code',v.code,'amount',0,'success',true,'skipped',true));
     CONTINUE;
   END IF;
   -- Remaining original usage, net of refunds for ANY booking in this group.
   SELECT greatest(0,floor(usage.amount*100)::bigint-coalesce(round(sum(t.amount)*100)::bigint,0))
     INTO available FROM public.voucher_transaction t WHERE t.tenant_id=p_tenant_id AND t.voucher_id=v.id
       AND t.type='cancellation_refund' AND (t.booking_reference=ANY(refs)
         OR (usage.allocation_id IS NOT NULL AND t.allocation_id=usage.allocation_id));
   amount := least(budget,available);
   IF v_purchase_id IS NOT NULL THEN
     SELECT s.amount_minor INTO share_minor FROM public.voucher_booking_credit_share s
       WHERE s.tenant_id=p_tenant_id AND s.source=p_source AND s.booking_id=p_booking_id
         AND s.allocation_id=usage.allocation_id;
     amount := least(amount,coalesce(share_minor,0));
   END IF;
   IF coalesce(p_refund_allocation->'vouchers','{}') ? v.id::text THEN
     selected := (p_refund_allocation->'vouchers'->>v.id::text)::numeric;
     IF selected IS NULL OR selected<0 OR selected<>round(selected,2) THEN RAISE EXCEPTION 'Invalid voucher refund allocation'; END IF;
     amount := least(amount,floor(selected*100)::bigint);
   END IF;
   IF amount<=0 THEN
     items := items || jsonb_build_array(jsonb_build_object('voucherId',v.id,'code',v.code,'amount',0,'success',true,'skipped',true));
     CONTINUE;
   END IF;
   replacement := NULL; new_expiry := NULL;
   SELECT nullif(trim(s.setting_value),'') INTO label FROM public.system_settings s WHERE s.tenant_id=p_tenant_id
     AND s.setting_key=CASE WHEN v.member_id IS NULL THEN 'organization_voucher_display_name' ELSE 'member_voucher_display_name' END LIMIT 1;
   label := coalesce(label,'Training Voucher');
   IF v.expires_at<=now() THEN
     SELECT (r->>'newExpiryDate')::timestamptz INTO new_expiry
       FROM jsonb_array_elements(coalesce(p_reversal_options->'voucherReplacements','[]')) r
       WHERE r->>'voucherId'=v.id::text LIMIT 1;
     IF new_expiry IS NULL THEN
       items := items || jsonb_build_array(jsonb_build_object('voucherId',v.id,'code',v.code,'amount',amount/100.0,
         'success',false,'expired',true,'skipped',true)); CONTINUE;
     END IF;
     IF new_expiry<=now() THEN RAISE EXCEPTION 'Replacement voucher expiry must be in the future'; END IF;
     -- Exception is scoped to this owner-preserving, ledger-bounded reversal.
     PERFORM set_config('app.voucher_credit_reversal','yes',true);
     INSERT INTO public.voucher(tenant_id,organization_id,member_id,code,value,description,expires_at,status,currency)
       VALUES(p_tenant_id,v.organization_id,v.member_id,'REFUND-'||v.code||'-'||gen_random_uuid()::text,
         amount/100.0,'Replacement for expired voucher '||v.code||' (cancellation of '||ref||')',new_expiry,'active',v.currency)
       RETURNING * INTO replacement;
     PERFORM set_config('app.voucher_credit_reversal',coalesce(previous_reversal,''),true);
     INSERT INTO public.voucher_transaction(voucher_id,tenant_id,organization_id,owner_member_id,owner_display_name,
       booking_reference,amount,balance_before,balance_after,type,notes)
       VALUES(replacement.id,p_tenant_id,v.organization_id,v.member_id,label,ref,amount/100.0,0,amount/100.0,
         'replacement_credit','Replacement funded by refund from original voucher '||v.id::text);
     item := jsonb_build_object('voucherId',v.id,'code',v.code,'amount',amount/100.0,'success',true,'expired',true,
       'replacementCreated',true,'newVoucherCode',replacement.code,'newVoucherId',replacement.id);
     replacements := replacements || jsonb_build_array(jsonb_build_object('type','voucher','originalCode',v.code,
       'newCode',replacement.code,'amount',amount/100.0,'expiryDate',new_expiry));
   ELSE
     UPDATE public.voucher SET value=value+amount/100.0,status='active',used_at=NULL WHERE id=v.id;
     item := jsonb_build_object('voucherId',v.id,'code',v.code,'amount',amount/100.0,'success',true,'reinstated',true);
   END IF;
   INSERT INTO public.voucher_transaction(voucher_id,tenant_id,organization_id,owner_member_id,owner_display_name,
     allocation_id,booking_reference,member_id,amount,balance_before,balance_after,type,notes)
     VALUES(v.id,p_tenant_id,v.organization_id,v.member_id,label,usage.allocation_id,ref,
       nullif(b->>'member_id','')::uuid,amount/100.0,v.value,
       v.value+CASE WHEN replacement.id IS NULL THEN amount/100.0 ELSE 0 END,'cancellation_refund',
       CASE WHEN replacement.id IS NOT NULL THEN 'Refund issued to replacement voucher '||replacement.id::text END);
   INSERT INTO public.voucher_booking_refund(tenant_id,source,booking_id,voucher_id,usage_reference,amount_minor,replacement_voucher_id,result)
     VALUES(p_tenant_id,p_source,p_booking_id,v.id,group_ref,amount,replacement.id,item);
   items := items || jsonb_build_array(item); budget := budget-amount;
 END LOOP;
 IF items='[]'::jsonb AND budget>0 THEN
   RAISE EXCEPTION 'Original voucher usage provenance missing; manual reconciliation required';
 END IF;
 PERFORM set_config('app.voucher_credit_write',coalesce(previous_flag,''),true);
 RETURN jsonb_build_object('vouchers',items,'replacements',replacements);
END $$;
REVOKE ALL ON FUNCTION public.voucher_credit_refund_booking(uuid,uuid,text,jsonb,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.voucher_credit_refund_booking(uuid,uuid,text,jsonb,jsonb) TO service_role;
COMMIT;
