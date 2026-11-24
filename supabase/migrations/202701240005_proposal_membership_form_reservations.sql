BEGIN;
ALTER TABLE public.proposal_membership_payment_reservation
  ALTER COLUMN payment_quote_id DROP NOT NULL,
  ADD COLUMN submission_id uuid UNIQUE REFERENCES public.form_submission(id),
  ADD CONSTRAINT proposal_membership_reservation_one_owner CHECK (
    (payment_quote_id IS NOT NULL)::integer+(submission_id IS NOT NULL)::integer=1
  );

CREATE FUNCTION public.reserve_proposal_membership_form() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE benefit jsonb := NEW.payment_meta#>'{membership,quote,proposal_membership}';
  e proposal_membership_entitlement%ROWTYPE; reserved proposal_membership_payment_reservation%ROWTYPE;
BEGIN
  IF benefit IS NULL OR benefit='null'::jsonb THEN RETURN NEW; END IF;
  SELECT * INTO e FROM proposal_membership_entitlement WHERE tenant_id=NEW.tenant_id
    AND id::text=benefit->>'entitlementId';
  IF e.id IS NULL OR e.organization_id::text IS DISTINCT FROM NEW.payment_meta->>'prefill_organization_id'
    OR e.schedule_id::text IS DISTINCT FROM NEW.payment_meta#>>'{membership,quote,config_id}' THEN
    RAISE EXCEPTION 'Proposal benefit does not match this form organisation and schedule' USING ERRCODE='22023';
  END IF;
  PERFORM 1 FROM organization WHERE tenant_id=e.tenant_id AND id=e.organization_id FOR UPDATE;
  SELECT * INTO reserved FROM proposal_membership_payment_reservation WHERE entitlement_id=e.id;
  IF FOUND THEN
    IF reserved.submission_id IS DISTINCT FROM NEW.id THEN
      RAISE EXCEPTION 'This benefit is reserved by another checkout; resume the original submission' USING ERRCODE='PT409';
    END IF;
    RETURN NEW;
  END IF;
  IF EXISTS(SELECT 1 FROM proposal_membership_consumption WHERE entitlement_id=e.id) THEN
    RAISE EXCEPTION 'This proposal benefit has already been used; recalculate membership' USING ERRCODE='PT409';
  END IF;
  INSERT INTO proposal_membership_payment_reservation(entitlement_id,submission_id) VALUES(e.id,NEW.id);
  RETURN NEW;
END $$;
CREATE TRIGGER proposal_membership_form_reserve AFTER INSERT OR UPDATE OF payment_meta ON public.form_submission
  FOR EACH ROW EXECUTE FUNCTION public.reserve_proposal_membership_form();
REVOKE ALL ON FUNCTION public.reserve_proposal_membership_form() FROM PUBLIC,anon,authenticated,service_role;

DO $patch$
DECLARE definition text; anchor text := 'r.entitlement_id=e.id AND r.payment_quote_id IS DISTINCT FROM NEW.membership_payment_quote_id';
BEGIN
  SELECT pg_get_functiondef('public.consume_proposal_membership_on_creation()'::regprocedure) INTO definition;
  IF position(anchor IN definition)=0 THEN RAISE EXCEPTION 'Payment reservation contract changed'; END IF;
  EXECUTE replace(definition,anchor,$replacement$
    r.entitlement_id=e.id AND
    ((r.payment_quote_id IS NOT NULL AND r.payment_quote_id IS DISTINCT FROM NEW.membership_payment_quote_id)
      OR (r.submission_id IS NOT NULL AND r.submission_id::text IS DISTINCT FROM snapshot->>'submissionId'))
  $replacement$);
END $patch$;
COMMIT;
