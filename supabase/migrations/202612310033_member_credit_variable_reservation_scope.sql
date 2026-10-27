-- Admit real variable-monthly membership slices, not arbitrary prefixed keys.
-- This does not enable member-credit execution.
BEGIN;
CREATE FUNCTION public.member_credit_membership_purchase_scope(
 p_tenant_id uuid,p_member_id uuid,p_purchase_key text) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE accepted boolean;
BEGIN
 IF left(p_purchase_key,11)='membership:' THEN RETURN true; END IF;
 IF p_purchase_key IS NULL OR left(p_purchase_key,20)<>'variable-membership:'
   OR to_regclass('public.membership_variable_voucher_period') IS NULL THEN
   RETURN false;
 END IF;
 -- A period exists before its slices are reserved. The bounded ordinal must
 -- belong to that persisted period and its member-owned source history.
 EXECUTE $query$
  SELECT EXISTS(
   SELECT 1 FROM public.membership_variable_voucher_period p
   JOIN public.membership_voucher_settlement s
    ON s.id=p.settlement_id AND s.tenant_id=p.tenant_id
   JOIN public.member_membership_history h
    ON h.id=s.history_record_id AND h.tenant_id=s.tenant_id
   CROSS JOIN LATERAL generate_series(1,p.instalment_count) n(ordinal)
   WHERE p.tenant_id=$1 AND h.member_id=$2
    AND s.purchase_key=regexp_replace($3,':[0-9]+$','')
    AND $3=s.purchase_key||':'||n.ordinal::text
  )
 $query$ INTO accepted USING p_tenant_id,p_member_id,p_purchase_key;
 RETURN COALESCE(accepted,false);
END $$;
REVOKE ALL ON FUNCTION public.member_credit_membership_purchase_scope(uuid,uuid,text)
 FROM PUBLIC,anon,authenticated,service_role;

DO $$
DECLARE definition text;
 needle text:='p_purchase_key IS NULL OR left(p_purchase_key,11)<>''membership:''';
BEGIN
 SELECT pg_get_functiondef('public.voucher_credit_reserve(uuid,text,uuid,uuid,uuid[],bigint,text,boolean,boolean)'::regprocedure)
 INTO definition;
 IF strpos(definition,needle)=0 THEN
  RAISE EXCEPTION 'Unexpected protected membership-credit reservation contract';
 END IF;
 EXECUTE replace(definition,needle,
  'NOT public.member_credit_membership_purchase_scope(p_tenant_id,p_member_id,p_purchase_key)');
END $$;
NOTIFY pgrst,'reload schema';
COMMIT;
