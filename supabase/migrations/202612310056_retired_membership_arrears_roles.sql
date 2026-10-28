BEGIN;
-- A later receipt may settle debt but cannot restore the role of a retired
-- purchase, including after a separate new purchase has restored access.
CREATE OR REPLACE FUNCTION public.restore_membership_arrears_fallback_role(
 p_tenant_id uuid,p_action_id uuid
) RETURNS TABLE(result_status text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE a public.membership_arrears_role_action; m public.member; outcome text;
BEGIN
 SELECT * INTO a FROM public.membership_arrears_role_action
  WHERE id=p_action_id AND tenant_id=p_tenant_id FOR UPDATE;
 IF NOT FOUND OR a.restored_at IS NOT NULL THEN
  RETURN QUERY SELECT 'already_completed'::text; RETURN;
 END IF;
 SELECT * INTO m FROM public.member
  WHERE id=a.member_id AND tenant_id=p_tenant_id FOR UPDATE;
 IF NOT FOUND THEN outcome:='member_missing';
 ELSIF EXISTS(
  SELECT 1 FROM public.membership_payment_plans p
  JOIN public.member_membership_history h ON h.billing_agreement_id=p.billing_agreement_id
   AND h.tenant_id=p.tenant_id AND h.member_id=a.member_id
  WHERE p.id=a.plan_id AND p.tenant_id=p_tenant_id
   AND h.status IN ('cancelled_by_request','replaced')
 ) THEN outcome:='retired_purchase_preserved';
 ELSIF m.role_id IS NOT DISTINCT FROM a.assigned_role_id THEN
  UPDATE public.member SET role_id=a.previous_role_id
   WHERE id=m.id AND tenant_id=p_tenant_id;
  outcome:='restored';
 ELSE outcome:='manual_change_preserved';
 END IF;
 UPDATE public.membership_arrears_role_action
  SET restored_at=now(),restoration_status=outcome,updated_at=now() WHERE id=a.id;
 RETURN QUERY SELECT outcome;
END $$;
REVOKE ALL ON FUNCTION public.restore_membership_arrears_fallback_role(uuid,uuid)
 FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.restore_membership_arrears_fallback_role(uuid,uuid) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
