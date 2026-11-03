-- Enable the protected post-grace binding contract, not the public rollout gate.
BEGIN;
CREATE FUNCTION public.guard_form_voucher_successor_changes()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF (NEW.status IS DISTINCT FROM OLD.status
  OR NEW.payment_method IS DISTINCT FROM OLD.payment_method
  OR NEW.switch_state IS DISTINCT FROM OLD.switch_state)
 AND EXISTS(SELECT FROM public.form_membership_voucher_checkout b
  WHERE b.election_id=OLD.id AND b.tenant_id=OLD.tenant_id AND b.released_at IS NULL) THEN
  RAISE EXCEPTION 'Close and reconcile the bound credit checkout before changing this renewal';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_form_voucher_successor_changes() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER form_voucher_successor_changes BEFORE UPDATE ON public.membership_successor_election
 FOR EACH ROW EXECUTE FUNCTION public.guard_form_voucher_successor_changes();

DO $patch$
DECLARE definition text; marker text:= $m$OR sim#>>'{formRenewal,state}'='post_grace_renewal'$m$;
BEGIN
 definition:=pg_get_functiondef('public.bind_form_membership_voucher_checkout(uuid,uuid,uuid,jsonb,text)'::regprocedure);
 IF (length(definition)-length(replace(definition,marker,'')))/length(marker)<>1 THEN
  RAISE EXCEPTION 'Unexpected form voucher binding contract';
 END IF;
 EXECUTE replace(definition,marker,'');
END $patch$;

-- A shifted service date is not a different purchased voucher period.
-- Accept only the exact before/after term-key pair in the protected receipt.
CREATE FUNCTION public.membership_voucher_term_key_matches(p_tenant_id uuid,p_settlement_id uuid,p_term_key text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT EXISTS(
  SELECT FROM public.membership_voucher_settlement s
  WHERE s.id=p_settlement_id AND s.tenant_id=p_tenant_id AND s.state<>'released'
   AND (s.monthly_snapshot#>>'{commitment,term_key}'=p_term_key OR EXISTS(
    SELECT FROM public.form_membership_voucher_checkout b
    JOIN public.membership_post_grace_renewal r ON r.election_id=b.election_id AND r.tenant_id=b.tenant_id
    JOIN public.membership_post_grace_date_application a ON a.reservation_id=r.id AND a.tenant_id=r.tenant_id
    WHERE b.fee_token_id=s.fee_token_id AND b.tenant_id=s.tenant_id AND b.released_at IS NULL
     AND r.member_id=b.member_id AND a.state='applied'
     AND a.before_rows#>>'{history,term_key}'=s.monthly_snapshot#>>'{commitment,term_key}'
     AND a.after_rows#>>'{history,term_key}'=p_term_key
     AND a.after_rows#>>'{history,id}'=s.history_record_id::text
   ))
 )
$$;
REVOKE ALL ON FUNCTION public.membership_voucher_term_key_matches(uuid,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.membership_voucher_term_key_matches(uuid,uuid,text) TO service_role;
DO $patch$
DECLARE definition text; marker text;
BEGIN
 definition:=pg_get_functiondef('public.membership_variable_voucher_bind()'::regprocedure);
 marker:=$m$s.monthly_snapshot#>>'{commitment,term_key}' IS DISTINCT FROM NEW.term_key$m$;
 IF (length(definition)-length(replace(definition,marker,'')))/length(marker)<>1 THEN
  RAISE EXCEPTION 'Unexpected variable voucher binding contract';
 END IF;
 EXECUTE replace(definition,marker,'NOT public.membership_voucher_term_key_matches(NEW.tenant_id,s.id,NEW.term_key)');
 definition:=pg_get_functiondef('public.membership_variable_voucher_settle_before_restart_dates(uuid,uuid)'::regprocedure);
 marker:=$m$r.term_key IS DISTINCT FROM s.monthly_snapshot#>>'{commitment,term_key}'$m$;
 IF (length(definition)-length(replace(definition,marker,'')))/length(marker)<>1 THEN
  RAISE EXCEPTION 'Unexpected variable voucher settlement contract';
 END IF;
 EXECUTE replace(definition,marker,'NOT public.membership_voucher_term_key_matches(p_tenant_id,s.id,r.term_key)');
END $patch$;
COMMIT;
