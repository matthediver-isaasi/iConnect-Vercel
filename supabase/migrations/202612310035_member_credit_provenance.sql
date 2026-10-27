-- Reserved provenance may only be issued by the backed application transaction.
BEGIN;
DO $$
DECLARE definition text; needle text;
BEGIN
 definition:=pg_get_functiondef('public.apply_member_membership_amendment(uuid,uuid,uuid)'::regprocedure);
 needle:='issued:=public.voucher_admin_write(';
 IF strpos(definition,needle)=0 THEN RAISE EXCEPTION 'Unexpected backed issuance contract'; END IF;
 EXECUTE replace(definition,needle,'issued:=public.voucher_admin_write_before_member_credit(');

 definition:=pg_get_functiondef('public.voucher_admin_write(uuid,uuid,text,jsonb,text,text)'::regprocedure);
 needle:='BEGIN';
 EXECUTE replace(definition,needle,$guard$
 BEGIN
  IF p_values->>'funding_source'='membership_change' THEN
   RAISE EXCEPTION 'Membership-change provenance is reserved for verified credit issuance' USING ERRCODE='40001';
  END IF;
 $guard$);

 definition:=pg_get_functiondef('public.voucher_credit_reserve(uuid,text,uuid,uuid,uuid[],bigint,text,boolean,boolean)'::regprocedure);
 EXECUTE replace(definition,'BEGIN',$guard$
 BEGIN
  IF EXISTS(SELECT 1 FROM public.voucher v
   WHERE v.tenant_id=p_tenant_id AND v.id=ANY(p_voucher_ids) AND v.funding_source='membership_change'
    AND NOT EXISTS(SELECT 1 FROM public.member_membership_credit credit_row
     WHERE credit_row.tenant_id=v.tenant_id AND credit_row.voucher_id=v.id)) THEN
   RAISE EXCEPTION 'Membership credit accounting backing is missing' USING ERRCODE='40001';
  END IF;
 $guard$);
END $$;
ALTER FUNCTION public.member_credit_funding_proofs(uuid,uuid[]) RENAME TO member_credit_funding_proofs_before_provenance;
REVOKE ALL ON FUNCTION public.member_credit_funding_proofs_before_provenance(uuid,uuid[])
 FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.member_credit_funding_proofs(p_tenant_id uuid,p_allocation_ids uuid[])
RETURNS SETOF jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF EXISTS(
  SELECT 1 FROM public.voucher_credit_allocation a
  JOIN public.voucher v ON v.id=a.voucher_id AND v.tenant_id=a.tenant_id
  WHERE a.tenant_id=p_tenant_id AND a.id=ANY(p_allocation_ids) AND v.funding_source='membership_change'
   AND NOT EXISTS(SELECT 1 FROM public.member_membership_credit c
    WHERE c.tenant_id=v.tenant_id AND c.voucher_id=v.id)
 ) THEN RAISE EXCEPTION 'Membership credit accounting backing is missing'; END IF;
 RETURN QUERY SELECT * FROM public.member_credit_funding_proofs_before_provenance(p_tenant_id,p_allocation_ids);
END $$;
REVOKE ALL ON FUNCTION public.member_credit_funding_proofs(uuid,uuid[]) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.member_credit_funding_proofs(uuid,uuid[]) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
