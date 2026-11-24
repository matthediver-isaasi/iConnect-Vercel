BEGIN;
ALTER TABLE proposal_membership_payment_reservation DROP CONSTRAINT proposal_membership_reservation_one_owner,
  ADD COLUMN fee_token_id uuid UNIQUE REFERENCES membership_fee_token(id),
  ADD CONSTRAINT proposal_membership_reservation_one_owner CHECK(
    (payment_quote_id IS NOT NULL)::integer+(submission_id IS NOT NULL)::integer+(fee_token_id IS NOT NULL)::integer=1);
CREATE FUNCTION public.reserve_proposal_membership_fee_token(p_tenant uuid,p_token uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE t membership_fee_token%ROWTYPE; e proposal_membership_entitlement%ROWTYPE;
  r proposal_membership_payment_reservation%ROWTYPE;
BEGIN
  SELECT * INTO t FROM membership_fee_token WHERE tenant_id=p_tenant AND id=p_token;
  IF t.id IS NULL OR t.organization_id IS NULL OR t.cost_breakdown->'proposalMembership' IS NULL THEN
    RAISE EXCEPTION 'Membership fee quote is unavailable' USING ERRCODE='22023';
  END IF;
  PERFORM 1 FROM organization WHERE tenant_id=p_tenant AND id=t.organization_id FOR UPDATE;
  SELECT * INTO e FROM proposal_membership_entitlement WHERE tenant_id=p_tenant
    AND organization_id=t.organization_id AND id::text=t.cost_breakdown#>>'{proposalMembership,entitlementId}'
    AND schedule_id::text=t.cost_breakdown#>>'{proposalMembership,scheduleId}';
  IF e.id IS NOT NULL AND EXISTS(SELECT 1 FROM proposal_membership_consumption c
    JOIN organisation_membership_history h ON h.id=c.history_id AND h.tenant_id=c.tenant_id
    WHERE c.entitlement_id=e.id AND h.proposal_membership->>'feeTokenId'=t.id::text AND h.payment_status='unpaid') THEN
    RETURN true; -- A rolling fee link reserved its own history before checkout.
  END IF;
  IF e.id IS NULL OR EXISTS(SELECT 1 FROM proposal_membership_consumption WHERE entitlement_id=e.id) THEN
    RAISE EXCEPTION 'Proposal benefit is no longer available; do not start another payment' USING ERRCODE='PT409';
  END IF;
  SELECT * INTO r FROM proposal_membership_payment_reservation WHERE entitlement_id=e.id;
  IF FOUND THEN
    IF r.fee_token_id IS DISTINCT FROM t.id THEN RAISE EXCEPTION 'Proposal benefit belongs to another checkout' USING ERRCODE='PT409'; END IF;
    RETURN true;
  END IF;
  INSERT INTO proposal_membership_payment_reservation(entitlement_id,fee_token_id) VALUES(e.id,t.id);
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.reserve_proposal_membership_fee_token(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_proposal_membership_fee_token(uuid,uuid) TO service_role;
DO $patch$
DECLARE definition text; anchor text := '(r.submission_id IS NOT NULL AND r.submission_id::text IS DISTINCT FROM snapshot->>''submissionId'')';
BEGIN
 SELECT pg_get_functiondef('public.consume_proposal_membership_on_creation()'::regprocedure) INTO definition;
 IF position(anchor IN definition)=0 THEN RAISE EXCEPTION 'Form reservation contract changed'; END IF;
 EXECUTE replace(definition,anchor,anchor || ' OR (r.fee_token_id IS NOT NULL AND r.fee_token_id::text IS DISTINCT FROM snapshot->>''feeTokenId'')');
END $patch$;
COMMIT;
