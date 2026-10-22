-- Task 5241. Prepared migration; never run against SOURCE. No settings backfill:
-- missing individual_vouchers_enabled is OFF; display names independently default.
BEGIN;
-- Refuse ambiguous existing values rather than silently choosing a duplicate.
-- Partial index also serializes concurrent first-save insertions.
CREATE UNIQUE INDEX system_settings_voucher_policy_unique
  ON public.system_settings(tenant_id,setting_key)
  WHERE setting_key IN ('individual_vouchers_enabled','organization_voucher_display_name','member_voucher_display_name',
    'xero_voucher_clearing_account_code','quickbooks_voucher_clearing_account_id',
    'xero_training_fund_clearing_account_code','quickbooks_training_fund_clearing_account_id',
    'xero_program_sales_account_code','quickbooks_program_sales_item_id',
    'xero_program_tax_code','quickbooks_program_tax_code','program_price_vat_rate_percent');
ALTER TABLE public.voucher ALTER COLUMN organization_id DROP NOT NULL;
ALTER TABLE public.voucher ADD COLUMN IF NOT EXISTS member_id uuid REFERENCES public.member(id);
ALTER TABLE public.voucher ADD COLUMN IF NOT EXISTS currency text NOT NULL DEFAULT 'GBP';
ALTER TABLE public.voucher ADD CONSTRAINT voucher_exactly_one_owner
  CHECK (num_nonnulls(organization_id, member_id) = 1) NOT VALID;
ALTER TABLE public.voucher VALIDATE CONSTRAINT voucher_exactly_one_owner;
ALTER TABLE public.voucher ADD CONSTRAINT voucher_nonnegative_value CHECK (value >= 0) NOT VALID;
ALTER TABLE public.voucher VALIDATE CONSTRAINT voucher_nonnegative_value;
ALTER TABLE public.voucher_transaction ADD COLUMN IF NOT EXISTS owner_member_id uuid REFERENCES public.member(id);
ALTER TABLE public.voucher_transaction ADD COLUMN IF NOT EXISTS allocation_id uuid;
ALTER TABLE public.voucher_transaction ADD COLUMN IF NOT EXISTS owner_display_name text;

CREATE TABLE public.voucher_credit_purchase (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  purchase_key text NOT NULL CHECK (length(purchase_key) BETWEEN 1 AND 250),
  request jsonb NOT NULL,
  state text NOT NULL DEFAULT 'reserved' CHECK (state IN ('reserved','committed','released')),
  payable_minor bigint NOT NULL CHECK (payable_minor >= 0),
  currency text NOT NULL,
  member_id uuid NOT NULL REFERENCES public.member(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  committed_at timestamptz,
  released_at timestamptz,
  provider_outcome text,
  UNIQUE (tenant_id,purchase_key)
);
CREATE TABLE public.voucher_credit_allocation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_id uuid NOT NULL REFERENCES public.voucher_credit_purchase(id),
  tenant_id uuid NOT NULL,
  voucher_id uuid NOT NULL REFERENCES public.voucher(id),
  organization_id uuid REFERENCES public.organization(id),
  owner_member_id uuid REFERENCES public.member(id),
  owner_display_name text NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  ordinal integer NOT NULL,
  CHECK (num_nonnulls(organization_id,owner_member_id)=1),
  UNIQUE (purchase_id,voucher_id)
);
ALTER TABLE public.voucher_transaction ADD CONSTRAINT voucher_transaction_allocation_fk
  FOREIGN KEY (allocation_id) REFERENCES public.voucher_credit_allocation(id);
CREATE TABLE public.voucher_admin_operation (
  tenant_id uuid NOT NULL,
  idempotency_key text NOT NULL,
  request jsonb NOT NULL,
  result jsonb NOT NULL,
  PRIMARY KEY (tenant_id,idempotency_key)
);
ALTER TABLE public.voucher_credit_purchase ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.voucher_credit_allocation ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.voucher_admin_operation ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.voucher ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.voucher_transaction ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.voucher_credit_purchase,public.voucher_credit_allocation,
  public.voucher_admin_operation,public.voucher,public.voucher_transaction FROM anon,authenticated;
GRANT ALL ON public.voucher_credit_purchase,public.voucher_credit_allocation,
  public.voucher_admin_operation TO service_role;
CREATE POLICY voucher_credit_purchase_service ON public.voucher_credit_purchase TO service_role USING (true) WITH CHECK (true);
CREATE POLICY voucher_credit_allocation_service ON public.voucher_credit_allocation TO service_role USING (true) WITH CHECK (true);
CREATE POLICY voucher_admin_operation_service ON public.voucher_admin_operation TO service_role USING (true) WITH CHECK (true);
CREATE POLICY voucher_service_credit_access ON public.voucher TO service_role USING (true) WITH CHECK (true);
CREATE POLICY voucher_transaction_service_credit_access ON public.voucher_transaction TO service_role USING (true) WITH CHECK (true);

CREATE FUNCTION public.voucher_owner_balance_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP='UPDATE' AND (NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.organization_id IS DISTINCT FROM OLD.organization_id OR NEW.member_id IS DISTINCT FROM OLD.member_id
    OR NEW.currency IS DISTINCT FROM OLD.currency) THEN
    RAISE EXCEPTION 'Voucher ownership, tenant and currency are immutable';
  END IF;
  IF TG_OP='UPDATE' AND NEW.value IS DISTINCT FROM OLD.value
    AND current_setting('app.voucher_credit_write',true) IS DISTINCT FROM 'yes' THEN
    RAISE EXCEPTION 'Voucher balance changes require the atomic voucher service';
  END IF;
  -- Validate only issuance/owner mutation, not legitimate reversal after disablement.
  IF TG_OP='INSERT' THEN
    IF NEW.tenant_id IS NULL OR num_nonnulls(NEW.organization_id,NEW.member_id)<>1 THEN
      RAISE EXCEPTION 'Exactly one tenant-valid voucher owner is required';
    END IF;
    IF NEW.member_id IS NOT NULL THEN
      IF NOT EXISTS (SELECT 1 FROM public.member m WHERE m.id=NEW.member_id AND m.tenant_id=NEW.tenant_id)
        OR (current_setting('app.voucher_credit_reversal',true) IS DISTINCT FROM 'yes'
          AND NOT EXISTS (SELECT 1 FROM public.system_settings s WHERE s.tenant_id=NEW.tenant_id
          AND s.setting_key='individual_vouchers_enabled' AND s.setting_value='true')) THEN
        RAISE EXCEPTION 'Individual voucher owner invalid or scheme disabled';
      END IF;
    ELSIF NOT EXISTS (SELECT 1 FROM public.organization o WHERE o.id=NEW.organization_id AND o.tenant_id=NEW.tenant_id) THEN
      RAISE EXCEPTION 'Voucher organization is outside tenant';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER voucher_owner_balance_guard BEFORE INSERT OR UPDATE ON public.voucher
FOR EACH ROW EXECUTE FUNCTION public.voucher_owner_balance_guard();

CREATE FUNCTION public.voucher_credit_result(p_id uuid) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
 SELECT jsonb_build_object('id',p.id,'purchaseKey',p.purchase_key,'state',p.state,
   'payableMinor',p.payable_minor,'currency',p.currency,
   'voucherMinor',coalesce((SELECT sum(a.amount_minor) FROM public.voucher_credit_allocation a WHERE a.purchase_id=p.id),0),
   'remainingMinor',p.payable_minor-coalesce((SELECT sum(a.amount_minor) FROM public.voucher_credit_allocation a WHERE a.purchase_id=p.id),0),
   'allocations',coalesce((SELECT jsonb_agg(jsonb_build_object('id',a.id,'voucherId',a.voucher_id,
     'amountMinor',a.amount_minor,'organizationId',a.organization_id,'memberId',a.owner_member_id,
     'ownerType',CASE WHEN a.owner_member_id IS NULL THEN 'organization' ELSE 'member' END,
     'displayName',a.owner_display_name) ORDER BY a.ordinal)
     FROM public.voucher_credit_allocation a WHERE a.purchase_id=p.id),'[]'::jsonb))
 FROM public.voucher_credit_purchase p WHERE p.id=p_id
$$;

CREATE FUNCTION public.voucher_credit_reserve(p_tenant_id uuid,p_purchase_key text,p_member_id uuid,
 p_authenticated_member_id uuid,p_voucher_ids uuid[],p_payable_minor bigint,p_currency text,
 p_allow_organization boolean,p_manual_order boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
 req jsonb; purchase public.voucher_credit_purchase%ROWTYPE; v public.voucher%ROWTYPE;
 m public.member%ROWTYPE; auth_member public.member%ROWTYPE; org public.organization%ROWTYPE;
 remaining bigint; amount bigint; allocation uuid; label text; n integer := 0; enabled boolean;
 previous_flag text := current_setting('app.voucher_credit_write',true);
BEGIN
 IF p_tenant_id IS NULL OR p_member_id IS NULL OR p_payable_minor IS NULL OR p_payable_minor<0
   OR p_currency IS NULL OR p_currency !~ '^[A-Z]{3}$' OR coalesce(length(p_purchase_key),0) NOT BETWEEN 1 AND 250
   OR p_voucher_ids IS NULL OR array_position(p_voucher_ids,NULL) IS NOT NULL
   OR cardinality(p_voucher_ids)<>(SELECT count(DISTINCT x) FROM unnest(p_voucher_ids) x) THEN
   RAISE EXCEPTION 'Invalid voucher reservation request';
 END IF;
 req := jsonb_build_object('memberId',p_member_id,'authenticatedMemberId',p_authenticated_member_id,
   'voucherIds',p_voucher_ids,'payableMinor',p_payable_minor,'currency',p_currency,
   'allowOrganization',p_allow_organization,'manualOrder',p_manual_order);
 PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant_id::text||':'||p_purchase_key,0));
 SELECT * INTO purchase FROM public.voucher_credit_purchase p WHERE p.tenant_id=p_tenant_id AND p.purchase_key=p_purchase_key FOR UPDATE;
 IF FOUND THEN
   IF purchase.request<>req THEN RAISE EXCEPTION 'Voucher idempotency key reused with different request'; END IF;
   IF purchase.state='released' THEN RAISE EXCEPTION 'Released purchase requires a new attempt key'; END IF;
   RETURN public.voucher_credit_result(purchase.id);
 END IF;
 SELECT * INTO m FROM public.member WHERE id=p_member_id AND tenant_id=p_tenant_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'Purchaser is outside tenant'; END IF;
 SELECT * INTO auth_member FROM public.member WHERE id=p_authenticated_member_id AND tenant_id=p_tenant_id;
 SELECT EXISTS(SELECT 1 FROM public.system_settings s WHERE s.tenant_id=p_tenant_id
   AND s.setting_key='individual_vouchers_enabled' AND s.setting_value='true') INTO enabled;
 -- Deterministic locks, independent of requested redemption order.
 PERFORM 1 FROM public.voucher WHERE tenant_id=p_tenant_id AND id=ANY(p_voucher_ids) ORDER BY id FOR UPDATE;
 IF (SELECT count(*) FROM public.voucher WHERE tenant_id=p_tenant_id AND id=ANY(p_voucher_ids))<>cardinality(p_voucher_ids) THEN
   RAISE EXCEPTION 'Selected voucher unavailable';
 END IF;
 INSERT INTO public.voucher_credit_purchase(tenant_id,purchase_key,request,payable_minor,currency,member_id)
 VALUES(p_tenant_id,p_purchase_key,req,p_payable_minor,p_currency,p_member_id) RETURNING * INTO purchase;
 remaining := p_payable_minor;
 PERFORM set_config('app.voucher_credit_write','yes',true);
 FOR v IN SELECT * FROM public.voucher WHERE tenant_id=p_tenant_id AND id=ANY(p_voucher_ids)
   ORDER BY CASE WHEN p_manual_order THEN array_position(p_voucher_ids,id) END,
   expires_at,issued_at,id
 LOOP
   IF v.status IS DISTINCT FROM 'active' OR v.value<=0 OR v.expires_at<=now()
     OR v.valid_from>now() OR v.currency<>p_currency THEN RAISE EXCEPTION 'Voucher is not eligible'; END IF;
   IF v.member_id IS NOT NULL THEN
     IF NOT enabled OR v.member_id<>p_member_id THEN RAISE EXCEPTION 'Individual voucher not authorized' USING ERRCODE='42501'; END IF;
   ELSE
     IF NOT coalesce(p_allow_organization,false) OR auth_member.id IS NULL
       OR auth_member.organization_id IS DISTINCT FROM v.organization_id
       OR m.organization_id IS DISTINCT FROM v.organization_id THEN
       RAISE EXCEPTION 'Organization voucher requires authenticated organization authority' USING ERRCODE='42501';
     END IF;
     SELECT * INTO org FROM public.organization WHERE id=v.organization_id AND tenant_id=p_tenant_id;
     IF NOT FOUND OR (coalesce(org.voucher_allowed_role_ids,'[]'::jsonb)<>'[]'::jsonb
       AND NOT coalesce(org.voucher_allowed_role_ids ? auth_member.role_id::text,false)) THEN
       RAISE EXCEPTION 'Role cannot redeem organization vouchers' USING ERRCODE='42501';
     END IF;
   END IF;
   amount := least(floor(v.value*100)::bigint,remaining);
   IF amount<=0 THEN CONTINUE; END IF;
   SELECT nullif(trim(s.setting_value),'') INTO label FROM public.system_settings s WHERE s.tenant_id=p_tenant_id
     AND s.setting_key=CASE WHEN v.member_id IS NULL THEN 'organization_voucher_display_name' ELSE 'member_voucher_display_name' END LIMIT 1;
   label := coalesce(label,'Training Voucher'); n := n+1;
   INSERT INTO public.voucher_credit_allocation(purchase_id,tenant_id,voucher_id,organization_id,owner_member_id,owner_display_name,amount_minor,ordinal)
     VALUES(purchase.id,p_tenant_id,v.id,v.organization_id,v.member_id,label,amount,n) RETURNING id INTO allocation;
   UPDATE public.voucher SET value=value-amount/100.0,
     status=CASE WHEN value-amount/100.0=0 THEN 'used' ELSE status END WHERE id=v.id;
   INSERT INTO public.voucher_transaction(voucher_id,tenant_id,organization_id,owner_member_id,member_id,
     allocation_id,owner_display_name,amount,balance_before,balance_after,type,booking_reference,notes)
     VALUES(v.id,p_tenant_id,v.organization_id,v.member_id,p_member_id,allocation,label,amount/100.0,
       v.value,v.value-amount/100.0,'reservation',p_purchase_key,
       CASE WHEN p_manual_order THEN 'Server-authorized manual voucher order' END);
   remaining := remaining-amount;
 END LOOP;
 PERFORM set_config('app.voucher_credit_write',coalesce(previous_flag,''),true);
 RETURN public.voucher_credit_result(purchase.id);
END $$;

CREATE FUNCTION public.voucher_credit_transition(p_tenant_id uuid,p_purchase_key text,p_action text,
 p_provider_outcome text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE p public.voucher_credit_purchase%ROWTYPE; a public.voucher_credit_allocation%ROWTYPE;
 v public.voucher%ROWTYPE; restore_minor bigint;
 previous_flag text := current_setting('app.voucher_credit_write',true);
BEGIN
 IF p_action NOT IN ('commit','release') OR p_action IS NULL THEN RAISE EXCEPTION 'Invalid voucher transition'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant_id::text||':'||p_purchase_key,0));
 SELECT * INTO p FROM public.voucher_credit_purchase WHERE tenant_id=p_tenant_id AND purchase_key=p_purchase_key FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Voucher reservation not found'; END IF;
 IF p_action='release' AND (p_provider_outcome IS NULL OR p_provider_outcome NOT IN ('not_started','failed','cancelled','refunded')) THEN
   RAISE EXCEPTION 'Reconcile provider outcome before release';
 END IF;
 IF (p_action='commit' AND p.state='committed') OR (p_action='release' AND p.state='released') THEN
   RETURN public.voucher_credit_result(p.id);
 END IF;
 IF p.state='released' THEN RAISE EXCEPTION 'Released voucher reservation cannot be committed'; END IF;
 IF p_action='release' AND p.state='committed' AND p_provider_outcome NOT IN ('cancelled','refunded') THEN
   RAISE EXCEPTION 'Committed credit requires cancellation or refund evidence';
 END IF;
 PERFORM 1 FROM public.voucher WHERE id IN (SELECT voucher_id FROM public.voucher_credit_allocation WHERE purchase_id=p.id) ORDER BY id FOR UPDATE;
 PERFORM set_config('app.voucher_credit_write','yes',true);
 FOR a IN SELECT * FROM public.voucher_credit_allocation WHERE purchase_id=p.id ORDER BY ordinal LOOP
   SELECT * INTO STRICT v FROM public.voucher WHERE id=a.voucher_id AND tenant_id=p_tenant_id;
   -- A per-booking cancellation may already have restored part of a group.
   -- The purchase/group release must never restore those same minor units again.
   SELECT greatest(0,a.amount_minor-coalesce(round(sum(t.amount)*100)::bigint,0))
     INTO restore_minor FROM public.voucher_transaction t
     WHERE t.tenant_id=p_tenant_id AND t.allocation_id=a.id AND t.type='cancellation_refund';
   IF p_action='release' AND restore_minor=0 THEN CONTINUE; END IF;
   IF p_action='release' THEN
     UPDATE public.voucher SET value=value+restore_minor/100.0,
       status=CASE WHEN expires_at<=now() THEN 'expired' ELSE 'active' END,used_at=NULL WHERE id=v.id;
   ELSE
     UPDATE public.voucher SET used_at=now() WHERE id=v.id;
   END IF;
   INSERT INTO public.voucher_transaction(voucher_id,tenant_id,organization_id,owner_member_id,member_id,
     allocation_id,owner_display_name,amount,balance_before,balance_after,type,booking_reference)
   VALUES(v.id,p_tenant_id,a.organization_id,a.owner_member_id,p.member_id,a.id,a.owner_display_name,
     CASE WHEN p_action='release' THEN restore_minor ELSE a.amount_minor END/100.0,
     v.value,v.value+CASE WHEN p_action='release' THEN restore_minor/100.0 ELSE 0 END,
     CASE WHEN p_action='commit' THEN 'booking_usage' WHEN p.state='committed' THEN 'cancellation_refund' ELSE 'reservation_release' END,p_purchase_key);
 END LOOP;
 UPDATE public.voucher_credit_purchase SET state=CASE WHEN p_action='commit' THEN 'committed' ELSE 'released' END,
   committed_at=CASE WHEN p_action='commit' THEN now() ELSE committed_at END,
   released_at=CASE WHEN p_action='release' THEN now() ELSE released_at END,
   provider_outcome=coalesce(p_provider_outcome,provider_outcome) WHERE id=p.id;
 PERFORM set_config('app.voucher_credit_write',coalesce(previous_flag,''),true);
 RETURN public.voucher_credit_result(p.id);
END $$;

CREATE FUNCTION public.voucher_admin_write(p_tenant_id uuid,p_voucher_id uuid,p_operation text,
 p_values jsonb,p_actor text,p_idempotency_key text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE req jsonb; prior public.voucher_admin_operation%ROWTYPE; v public.voucher%ROWTYPE;
 before_value numeric := 0; result jsonb; delta numeric; label text;
 previous_flag text := current_setting('app.voucher_credit_write',true);
BEGIN
 IF p_tenant_id IS NULL OR coalesce(trim(p_actor),'')='' OR coalesce(length(p_idempotency_key),0) NOT BETWEEN 1 AND 250
   OR p_values IS NULL OR jsonb_typeof(p_values)<>'object' OR p_operation IS NULL OR p_operation NOT IN ('issue','update','delete','expire') THEN
   RAISE EXCEPTION 'Invalid admin voucher request';
 END IF;
 IF EXISTS (SELECT 1 FROM jsonb_object_keys(p_values) k WHERE k NOT IN
   ('organization_id','member_id','code','value','description','expires_at','issued_at','valid_from','funding_source','notes','status','currency')) THEN
   RAISE EXCEPTION 'Unsupported voucher field';
 END IF;
 req := jsonb_build_object('id',p_voucher_id,'operation',p_operation,'values',p_values,'actor',p_actor);
 PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant_id::text||':admin:'||p_idempotency_key,0));
 SELECT * INTO prior FROM public.voucher_admin_operation WHERE tenant_id=p_tenant_id AND idempotency_key=p_idempotency_key;
 IF FOUND THEN
   IF prior.request<>req THEN RAISE EXCEPTION 'Admin idempotency key reused'; END IF;
   -- Expiry is a repeatable state reconciliation, not a one-time issuance.
   -- A legitimate later reversal may restore credit without changing expires_at.
   -- Re-enter the voucher row lock and expire only its CURRENT remaining value;
   -- zero-value retries produce no second ledger entry.
   IF p_operation<>'expire' THEN RETURN prior.result; END IF;
 END IF;
 PERFORM set_config('app.voucher_credit_write','yes',true);
 IF p_operation='issue' THEN
   IF p_voucher_id IS NOT NULL THEN RAISE EXCEPTION 'Issue cannot supply existing ID'; END IF;
   INSERT INTO public.voucher(tenant_id,organization_id,member_id,code,value,description,expires_at,issued_at,
     valid_from,funding_source,notes,created_by,status,currency)
   VALUES(p_tenant_id,nullif(p_values->>'organization_id','')::uuid,nullif(p_values->>'member_id','')::uuid,
     p_values->>'code',(p_values->>'value')::numeric,p_values->>'description',(p_values->>'expires_at')::timestamptz,
     coalesce((p_values->>'issued_at')::timestamptz,now()),(p_values->>'valid_from')::timestamptz,
     p_values->>'funding_source',p_values->>'notes',p_actor,coalesce(p_values->>'status','active'),
     coalesce(p_values->>'currency','GBP')) RETURNING * INTO v;
 ELSE
   SELECT * INTO v FROM public.voucher WHERE id=p_voucher_id AND tenant_id=p_tenant_id FOR UPDATE;
   IF NOT FOUND THEN RAISE EXCEPTION 'Voucher not found'; END IF;
   IF (p_values ? 'member_id' AND nullif(p_values->>'member_id','')::uuid IS DISTINCT FROM v.member_id)
     OR (p_values ? 'organization_id' AND nullif(p_values->>'organization_id','')::uuid IS DISTINCT FROM v.organization_id)
     OR (p_values ? 'currency' AND p_values->>'currency' IS DISTINCT FROM v.currency) THEN
     RAISE EXCEPTION 'Voucher owner/currency cannot be reassigned';
   END IF;
   IF EXISTS(SELECT 1 FROM public.voucher_credit_allocation a JOIN public.voucher_credit_purchase p ON p.id=a.purchase_id
     WHERE a.voucher_id=v.id AND p.state='reserved') THEN RAISE EXCEPTION 'Voucher has an outstanding reservation'; END IF;
   before_value := v.value;
   IF p_operation='expire' THEN
     IF p_values<>'{}'::jsonb THEN RAISE EXCEPTION 'Expiry does not accept voucher field changes'; END IF;
     IF v.expires_at>now() THEN RAISE EXCEPTION 'Voucher has not reached its expiry'; END IF;
     v.value := 0; v.status := 'expired';
     UPDATE public.voucher SET value=0,status='expired' WHERE id=v.id;
   ELSIF p_operation='delete' THEN
     IF v.value<>0 OR EXISTS(SELECT 1 FROM public.voucher_transaction WHERE voucher_id=v.id)
       OR EXISTS(SELECT 1 FROM public.voucher_credit_allocation WHERE voucher_id=v.id) THEN
       RAISE EXCEPTION 'Voucher history/balance must be retained';
     END IF;
     DELETE FROM public.voucher WHERE id=v.id;
     result := jsonb_build_object('id',v.id,'deleted',true);
   ELSE
     v := jsonb_populate_record(v,p_values - 'organization_id' - 'member_id' - 'currency');
     UPDATE public.voucher SET code=v.code,value=v.value,description=v.description,expires_at=v.expires_at,
       issued_at=v.issued_at,valid_from=v.valid_from,funding_source=v.funding_source,notes=v.notes,status=v.status
       WHERE id=v.id;
   END IF;
 END IF;
 IF p_operation<>'delete' THEN
   IF v.value<0 OR v.value<>round(v.value,2) OR v.currency !~ '^[A-Z]{3}$'
     OR v.status IS NULL OR v.status NOT IN ('active','used','expired') THEN RAISE EXCEPTION 'Invalid voucher value, status or currency'; END IF;
   delta := v.value-before_value;
   IF delta<>0 THEN
     SELECT nullif(trim(s.setting_value),'') INTO label FROM public.system_settings s
       WHERE s.tenant_id=p_tenant_id AND s.setting_key=CASE WHEN v.member_id IS NULL
         THEN 'organization_voucher_display_name' ELSE 'member_voucher_display_name' END LIMIT 1;
     label := coalesce(label,'Training Voucher');
     INSERT INTO public.voucher_transaction(voucher_id,tenant_id,organization_id,owner_member_id,
       owner_display_name,amount,balance_before,balance_after,type,notes)
     VALUES(v.id,p_tenant_id,v.organization_id,v.member_id,label,abs(delta),before_value,v.value,
       CASE WHEN p_operation='expire' THEN 'expiry' WHEN p_operation='issue' THEN 'award'
         WHEN delta>0 THEN 'credit_adjustment' ELSE 'debit_adjustment' END,
       CASE WHEN p_operation='expire' THEN 'Voucher expired on '||v.expires_at::text||'; unused value expired '||before_value::text||' '||v.currency||'; processed by '||p_actor ELSE p_actor END);
   END IF;
   result := to_jsonb(v);
 END IF;
 INSERT INTO public.voucher_admin_operation VALUES(p_tenant_id,p_idempotency_key,req,result)
   ON CONFLICT(tenant_id,idempotency_key) DO UPDATE SET result=EXCLUDED.result;
 PERFORM set_config('app.voucher_credit_write',coalesce(previous_flag,''),true);
 RETURN result;
END $$;

REVOKE ALL ON FUNCTION public.voucher_owner_balance_guard(),public.voucher_credit_result(uuid),
 public.voucher_credit_reserve(uuid,text,uuid,uuid,uuid[],bigint,text,boolean,boolean),
 public.voucher_credit_transition(uuid,text,text,text),public.voucher_admin_write(uuid,uuid,text,jsonb,text,text)
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.voucher_owner_balance_guard(),public.voucher_credit_result(uuid),
 public.voucher_credit_reserve(uuid,text,uuid,uuid,uuid[],bigint,text,boolean,boolean),
 public.voucher_credit_transition(uuid,text,text,text),public.voucher_admin_write(uuid,uuid,text,jsonb,text,text)
 TO service_role;
COMMIT;
