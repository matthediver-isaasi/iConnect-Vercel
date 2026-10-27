-- Reviewed personal upfront credit lifecycle. No backfill/provider calls.
BEGIN;
ALTER TABLE public.voucher ALTER COLUMN expires_at DROP NOT NULL;
CREATE TABLE public.member_membership_credit (
 amendment_id uuid PRIMARY KEY REFERENCES public.member_credit_backing_claim(amendment_id),
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 member_id uuid NOT NULL REFERENCES public.member(id),
 voucher_id uuid NOT NULL UNIQUE REFERENCES public.voucher(id),
 provider_payment_id text NOT NULL CHECK(length(provider_payment_id)>0),
 liability_binding jsonb NOT NULL,
 amount_minor bigint NOT NULL CHECK(amount_minor>0),
 issued_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,provider_payment_id)
);
CREATE TABLE public.member_credit_expiry_review (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 amendment_id uuid NOT NULL REFERENCES public.member_membership_credit(amendment_id),
 tenant_id uuid NOT NULL REFERENCES public.tenant(id),
 actor_id uuid NOT NULL,
 available_balance numeric NOT NULL,
 note text NOT NULL CHECK(length(btrim(note)) BETWEEN 1 AND 2000),
 reviewed_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.member_membership_credit ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.member_credit_expiry_review ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.member_membership_credit,public.member_credit_expiry_review FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.member_membership_credit,public.member_credit_expiry_review TO service_role;
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON public.member_membership_credit
 FOR EACH ROW EXECUTE FUNCTION public.reject_member_change_authority_mutation();
CREATE TRIGGER immutable BEFORE UPDATE OR DELETE ON public.member_credit_expiry_review
 FOR EACH ROW EXECUTE FUNCTION public.reject_member_change_authority_mutation();

ALTER TABLE public.member_change_execution DROP CONSTRAINT member_change_execution_settlement_choice_check;
ALTER TABLE public.member_change_execution ADD CONSTRAINT member_change_execution_settlement_choice_check
 CHECK(settlement_choice IN ('collect','refund','none','credit'));
DO $$
DECLARE body text; old_guard text:=$old$AND a.authority->'settlement'->>'surplusHandling' IN ('refund','approval')),false)$old$;
BEGIN
 body:=pg_get_functiondef('public.begin_member_change_execution(uuid,uuid,uuid,uuid,text,text)'::regprocedure);
 IF position(old_guard IN body)=0 OR position('request:=a.authority' IN body)=0 THEN
   RAISE EXCEPTION 'Unexpected execution contract; review before migration';
 END IF;
 body:=replace(body,old_guard,$new$AND a.authority->'settlement'->>'surplusHandling' IN ('refund','approval'))
   OR (p_choice='credit' AND (c->'delta'->>'grossMinor')::bigint<0
     AND public.member_credit_execution_available()
     AND a.authority->'settlement'->>'surplusHandling' IN ('credit','approval')
     AND a.authority->'settlement'->>'creditExpiryLiabilityTreatment'='manual_review'
     AND a.authority->'creditLiabilityBinding'->>'kind'='iconnect_member_credit_liability'
     AND a.authority->'creditLiabilityBinding'->>'providerTenantId'=
       a.authority->'fundingEvidence'->'providerEvidence'->>'providerTenantId'),false)$new$);
 body:=replace(body,'request:=a.authority',$new$IF p_choice='credit' THEN
   q:=q||jsonb_build_object('memberCreditLiabilityBinding',a.authority->'creditLiabilityBinding',
     'creditExpiryDays',a.authority->'policySnapshot'->'policy'->'creditExpiryDays');
 END IF;
 request:=a.authority$new$);
 EXECUTE body;
END $$;

ALTER FUNCTION public.apply_member_membership_amendment(uuid,uuid,uuid)
 RENAME TO apply_member_amendment_before_credit;
REVOKE ALL ON FUNCTION public.apply_member_amendment_before_credit(uuid,uuid,uuid)
 FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.apply_member_membership_amendment(p_tenant_id uuid,p_amendment_id uuid,p_actor_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE a public.member_membership_amendment; s public.member_membership_amendment_settlement;
 claim public.member_credit_backing_claim; result jsonb; issued jsonb; expires timestamptz; days integer;
BEGIN
 SELECT * INTO a FROM public.member_membership_amendment WHERE tenant_id=p_tenant_id AND id=p_amendment_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'Amendment not found' USING ERRCODE='40001'; END IF;
 PERFORM 1 FROM public.member WHERE tenant_id=p_tenant_id AND id=a.member_id FOR UPDATE;
 result:=public.apply_member_amendment_before_credit(p_tenant_id,p_amendment_id,p_actor_id);
 IF result->>'conflict'='true' OR a.quote->'memberCreditLiabilityBinding' IS NULL
   OR EXISTS(SELECT 1 FROM public.member_membership_credit WHERE amendment_id=a.id) THEN RETURN result; END IF;
 SELECT * INTO s FROM public.member_membership_amendment_settlement WHERE amendment_id=a.id AND tenant_id=p_tenant_id FOR UPDATE;
 SELECT * INTO claim FROM public.member_credit_backing_claim WHERE amendment_id=a.id AND tenant_id=p_tenant_id;
 IF NOT FOUND OR claim.context IS DISTINCT FROM s.context OR s.choice IS DISTINCT FROM 'credit'
   OR s.evidence->>'verified' IS DISTINCT FROM 'true'
   OR s.evidence->>'kind' IS DISTINCT FROM 'member_credit_backed'
   OR s.evidence->>'documentId' IS DISTINCT FROM claim.document_id
   OR s.evidence->>'liabilityAccountId' IS DISTINCT FROM claim.context->'memberCreditLiabilityBinding'->>'accountId'
   OR COALESCE(length(s.evidence->>'paymentId'),0)=0
   OR s.evidence->>'retainedCreditMinor' IS DISTINCT FROM '0' THEN
   RAISE EXCEPTION 'Verified claimed accounting backing required' USING ERRCODE='40001';
 END IF;
 days:=(a.quote->>'creditExpiryDays')::integer;
 IF days IS NOT NULL AND days NOT BETWEEN 1 AND 36500 THEN RAISE EXCEPTION 'Invalid credit expiry'; END IF;
 expires:=CASE WHEN days IS NULL THEN NULL ELSE now()+make_interval(days=>days) END;
 issued:=public.voucher_admin_write(p_tenant_id,NULL,'issue',jsonb_build_object(
   'member_id',a.member_id,'code','MC-'||replace(a.id::text,'-',''),
   'value',(s.context->'amounts'->>'grossMinor')::numeric/100,
   'currency',s.context->>'currency','description','Membership change credit',
   'funding_source','membership_change','expires_at',expires),
   'membership-change:'||a.actor_id::text,'membership-change:'||a.id::text);
 INSERT INTO public.member_membership_credit(amendment_id,tenant_id,member_id,voucher_id,
   provider_payment_id,liability_binding,amount_minor)
 VALUES(a.id,p_tenant_id,a.member_id,(issued->>'id')::uuid,s.evidence->>'paymentId',
   s.context->'memberCreditLiabilityBinding',(s.context->'amounts'->>'grossMinor')::bigint);
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.apply_member_membership_amendment(uuid,uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.apply_member_membership_amendment(uuid,uuid,uuid) TO service_role;

-- Backed credit must not be manually increased, reassigned, deleted or silently
-- zeroed by generic expiry. Date-based eligibility already stops redemption.
ALTER FUNCTION public.voucher_admin_write(uuid,uuid,text,jsonb,text,text) RENAME TO voucher_admin_write_before_member_credit;
REVOKE ALL ON FUNCTION public.voucher_admin_write_before_member_credit(uuid,uuid,text,jsonb,text,text)
 FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.voucher_admin_write(p_tenant_id uuid,p_voucher_id uuid,p_operation text,
 p_values jsonb,p_actor text,p_idempotency_key text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE v public.voucher; previous_flag text:=current_setting('app.voucher_credit_write',true);
BEGIN
 IF p_voucher_id IS NOT NULL THEN
   SELECT * INTO v FROM public.voucher WHERE id=p_voucher_id AND tenant_id=p_tenant_id FOR UPDATE;
   IF p_operation='expire' AND v.expires_at IS NULL THEN RAISE EXCEPTION 'Voucher has no expiry'; END IF;
   IF EXISTS(SELECT 1 FROM public.member_membership_credit WHERE voucher_id=v.id AND tenant_id=p_tenant_id) THEN
     IF p_operation IS DISTINCT FROM 'expire' OR p_values IS DISTINCT FROM '{}'::jsonb
       OR v.expires_at>now() THEN RAISE EXCEPTION 'Backed membership credit requires its dedicated finance lifecycle'; END IF;
     PERFORM set_config('app.voucher_credit_write','yes',true);
     UPDATE public.voucher SET status='expired' WHERE id=v.id RETURNING * INTO v;
     PERFORM set_config('app.voucher_credit_write',COALESCE(previous_flag,''),true);
     RETURN to_jsonb(v);
   END IF;
 END IF;
 RETURN public.voucher_admin_write_before_member_credit(p_tenant_id,p_voucher_id,p_operation,p_values,p_actor,p_idempotency_key);
END $$;
REVOKE ALL ON FUNCTION public.voucher_admin_write(uuid,uuid,text,jsonb,text,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.voucher_admin_write(uuid,uuid,text,jsonb,text,text) TO service_role;

CREATE FUNCTION public.review_member_credit_expiry(p_tenant_id uuid,p_amendment_id uuid,p_actor_id uuid,p_note text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE c public.member_membership_credit; v public.voucher; result public.member_credit_expiry_review;
BEGIN
 SELECT * INTO c FROM public.member_membership_credit WHERE tenant_id=p_tenant_id AND amendment_id=p_amendment_id;
 IF NOT FOUND OR p_actor_id IS NULL OR length(btrim(COALESCE(p_note,''))) NOT BETWEEN 1 AND 2000 THEN
   RAISE EXCEPTION 'Credit and audited review required' USING ERRCODE='40001'; END IF;
 SELECT * INTO v FROM public.voucher WHERE id=c.voucher_id AND tenant_id=p_tenant_id FOR UPDATE;
 IF NOT FOUND OR v.expires_at IS NULL OR v.expires_at>now() THEN RAISE EXCEPTION 'Credit has not expired'; END IF;
 INSERT INTO public.member_credit_expiry_review(amendment_id,tenant_id,actor_id,available_balance,note)
 VALUES(c.amendment_id,p_tenant_id,p_actor_id,v.value,btrim(p_note)) RETURNING * INTO result;
 RETURN to_jsonb(result);
END $$;
REVOKE ALL ON FUNCTION public.review_member_credit_expiry(uuid,uuid,uuid,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.review_member_credit_expiry(uuid,uuid,uuid,text) TO service_role;
CREATE FUNCTION public.list_member_credit_expiry_reviews(p_tenant_id uuid,p_after uuid DEFAULT NULL,p_limit integer DEFAULT 100)
RETURNS SETOF jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT jsonb_build_object('amendmentId',c.amendment_id,'memberId',c.member_id,
   'voucherCode',v.code,'currency',v.currency,'availableMinor',(v.value*100)::bigint,
   'expiresAt',v.expires_at,'needsReview',r.id IS NULL OR r.available_balance IS DISTINCT FROM v.value,
   'lastReview',CASE WHEN r.id IS NULL THEN NULL ELSE jsonb_build_object('note',r.note,
     'reviewedAt',r.reviewed_at,'actorId',r.actor_id,'availableMinor',(r.available_balance*100)::bigint) END)
 FROM public.member_membership_credit c JOIN public.voucher v ON v.id=c.voucher_id AND v.tenant_id=c.tenant_id
 LEFT JOIN LATERAL (SELECT * FROM public.member_credit_expiry_review r
   WHERE r.amendment_id=c.amendment_id AND r.tenant_id=c.tenant_id ORDER BY r.reviewed_at DESC,r.id DESC LIMIT 1) r ON true
 WHERE c.tenant_id=p_tenant_id AND v.expires_at<=now() AND v.value>0
   AND (p_after IS NULL OR c.amendment_id>p_after)
 ORDER BY c.amendment_id LIMIT LEAST(GREATEST(p_limit,1),100)
$$;
CREATE INDEX member_credit_review_latest ON public.member_credit_expiry_review(amendment_id,reviewed_at DESC,id DESC);
REVOKE ALL ON FUNCTION public.list_member_credit_expiry_reviews(uuid,uuid,integer) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.list_member_credit_expiry_reviews(uuid,uuid,integer) TO service_role;
-- Membership-change surplus is intended for eligible membership payments,
-- not the event/other voucher paths that do not post liability redemption.
ALTER FUNCTION public.voucher_credit_reserve(uuid,text,uuid,uuid,uuid[],bigint,text,boolean,boolean)
 RENAME TO voucher_credit_reserve_before_member_credit;
REVOKE ALL ON FUNCTION public.voucher_credit_reserve_before_member_credit(uuid,text,uuid,uuid,uuid[],bigint,text,boolean,boolean)
 FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.voucher_credit_reserve(p_tenant_id uuid,p_purchase_key text,p_member_id uuid,
 p_authenticated_member_id uuid,p_voucher_ids uuid[],p_payable_minor bigint,p_currency text,
 p_allow_organization boolean,p_manual_order boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE c public.member_membership_credit; code text;
BEGIN
 FOR c IN SELECT * FROM public.member_membership_credit
   WHERE tenant_id=p_tenant_id AND voucher_id=ANY(p_voucher_ids) LOOP
   IF p_purchase_key IS NULL OR left(p_purchase_key,11)<>'membership:'
     OR c.member_id IS DISTINCT FROM p_member_id THEN
     RAISE EXCEPTION 'Membership credit requires its owning member membership purchase' USING ERRCODE='40001'; END IF;
   SELECT setting_value INTO code FROM public.system_settings
     WHERE tenant_id=p_tenant_id AND setting_key='xero_voucher_clearing_account_code';
   IF code IS DISTINCT FROM c.liability_binding->>'accountCode' THEN
     RAISE EXCEPTION 'Membership credit liability mapping changed' USING ERRCODE='40001'; END IF;
 END LOOP;
 RETURN public.voucher_credit_reserve_before_member_credit(p_tenant_id,p_purchase_key,p_member_id,
   p_authenticated_member_id,p_voucher_ids,p_payable_minor,p_currency,p_allow_organization,p_manual_order);
END $$;
REVOKE ALL ON FUNCTION public.voucher_credit_reserve(uuid,text,uuid,uuid,uuid[],bigint,text,boolean,boolean)
 FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.voucher_credit_reserve(uuid,text,uuid,uuid,uuid[],bigint,text,boolean,boolean) TO service_role;
CREATE FUNCTION public.member_credit_funding_proofs(p_tenant_id uuid,p_allocation_ids uuid[])
RETURNS SETOF jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT DISTINCT jsonb_build_object('amendment',to_jsonb(a),'settlement',to_jsonb(s),'binding',c.liability_binding)
 FROM public.voucher_credit_allocation allocation JOIN public.member_membership_credit c
   ON c.voucher_id=allocation.voucher_id AND c.tenant_id=allocation.tenant_id
 JOIN public.member_membership_amendment a ON a.id=c.amendment_id AND a.tenant_id=c.tenant_id
 JOIN public.member_membership_amendment_settlement s ON s.amendment_id=a.id AND s.tenant_id=a.tenant_id
 WHERE c.tenant_id=p_tenant_id AND allocation.id=ANY(p_allocation_ids)
$$;
REVOKE ALL ON FUNCTION public.member_credit_funding_proofs(uuid,uuid[]) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.member_credit_funding_proofs(uuid,uuid[]) TO service_role;
CREATE FUNCTION public.member_credit_execution_available() RETURNS boolean
 -- Remains closed until restoration of consumed credit also verifies the
 -- corresponding liability reversal. Receipt/issuance tests alone do not
 -- establish safety of a later membership-payment refund.
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$ SELECT false $$;
REVOKE ALL ON FUNCTION public.member_credit_execution_available() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.member_credit_execution_available() TO service_role;
COMMIT;
