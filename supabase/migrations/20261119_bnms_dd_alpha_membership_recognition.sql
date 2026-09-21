-- No rows are inserted by schema installation. Exact-cohort runner is separate.
-- No financial table, history lifecycle, role, consent or contract is mutated.
CREATE TABLE public.bnms_dd_alpha_membership_recognition (
  adoption_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL CHECK (tenant_id='ff2df806-b321-4254-b651-3af11fccf1db'),
  member_id uuid NOT NULL UNIQUE,
  history_id uuid NOT NULL UNIQUE REFERENCES public.member_membership_history(id),
  agreement_id uuid NOT NULL UNIQUE REFERENCES public.membership_billing_agreements(id),
  plan_id uuid NOT NULL UNIQUE REFERENCES public.membership_payment_plans(id),
  effective_from date NOT NULL CHECK (effective_from='2026-09-21'),
  effective_until date NOT NULL CHECK (effective_until='2027-10-01'),
  revoked_at timestamptz,
  authorization_reference text NOT NULL CHECK (length(authorization_reference)>0),
  review_sha256 text NOT NULL CHECK (review_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (adoption_id,tenant_id,member_id)
    REFERENCES public.bnms_dd_alpha_adoption(id,tenant_id,member_id)
);
ALTER TABLE public.bnms_dd_alpha_membership_recognition ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.bnms_dd_alpha_membership_recognition FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.bnms_dd_alpha_membership_recognition TO service_role;

CREATE FUNCTION public.validate_membership_recognition()
RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Membership recognition audit records cannot be deleted'; END IF;
  IF TG_OP='UPDATE' THEN
    -- Revocation is the only allowed amendment; expiry cannot drift with billing.
    IF (to_jsonb(NEW)-'revoked_at') IS DISTINCT FROM (to_jsonb(OLD)-'revoked_at')
      OR OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL THEN
      RAISE EXCEPTION 'Alpha membership recognition is immutable except one-way revocation';
    END IF;
  END IF;
  IF NOT EXISTS (
    SELECT FROM bnms_dd_alpha_adoption a
    JOIN member_membership_history h ON h.id=a.history_id
    JOIN membership_payment_plans p ON p.id=a.plan_id
    JOIN membership_billing_agreements b ON b.id=a.agreement_id
    WHERE a.id=NEW.adoption_id AND a.tenant_id=NEW.tenant_id AND a.member_id=NEW.member_id
      AND a.history_id=NEW.history_id AND a.plan_id=NEW.plan_id AND a.agreement_id=NEW.agreement_id
      AND a.manifest_sha256='3aff20a6e04338c3b3532d57c6be4b8395afa5ff8d5dbbe878daab52017f395a'
      AND h.member_id=a.member_id AND h.tenant_id=a.tenant_id AND h.billing_agreement_id=a.agreement_id
      AND p.member_id=a.member_id AND p.tenant_id=a.tenant_id
      AND b.member_id=a.member_id AND b.tenant_id=a.tenant_id
      AND h.membership_renewal_date=NEW.effective_until
  ) THEN RAISE EXCEPTION 'Alpha membership recognition canonical ownership mismatch'; END IF;
  RETURN NEW;
END;
$$;
-- Deliberately outside the financial release verifier's alpha trigger namespace.
CREATE TRIGGER membership_recognition_guard
BEFORE INSERT OR UPDATE OR DELETE ON public.bnms_dd_alpha_membership_recognition
FOR EACH ROW EXECUTE FUNCTION public.validate_membership_recognition();