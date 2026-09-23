-- Administrative recognition only; no adoption, collection or billing writes.
-- Kept outside the Alpha/Beta financial schema-verifier namespaces.
CREATE TABLE public.bnms_membership_recognition_beta_pilot (
  adoption_id uuid PRIMARY KEY,
  cohort text NOT NULL CHECK (cohort IN ('beta','pilot')),
  tenant_id uuid NOT NULL CHECK (tenant_id='ff2df806-b321-4254-b651-3af11fccf1db'),
  member_id uuid NOT NULL UNIQUE,
  history_id uuid NOT NULL UNIQUE REFERENCES public.member_membership_history(id),
  agreement_id uuid NOT NULL UNIQUE REFERENCES public.membership_billing_agreements(id),
  plan_id uuid NOT NULL UNIQUE REFERENCES public.membership_payment_plans(id),
  effective_from date NOT NULL CHECK (effective_from='2026-09-21'),
  effective_until date NOT NULL CHECK (effective_until='2027-10-01'),
  authorization_reference text NOT NULL CHECK (authorization_reference=
    'explicit-user-approval:exact-10-beta-1-pilot:2026-09-21-through-2027-09-30:preserve-collection-controls'),
  review_sha256 text NOT NULL CHECK (review_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);
ALTER TABLE public.bnms_membership_recognition_beta_pilot ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.bnms_membership_recognition_beta_pilot FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.bnms_membership_recognition_beta_pilot TO service_role;

CREATE FUNCTION public.validate_bnms_supplemental_recognition()
RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE scope_hash text;
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'Recognition audit records cannot be deleted';
  END IF;
  IF TG_OP='UPDATE' THEN
    IF (to_jsonb(NEW)-'revoked_at') IS DISTINCT FROM (to_jsonb(OLD)-'revoked_at')
      OR OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL THEN
      RAISE EXCEPTION 'Recognition is immutable except one-way revocation';
    END IF;
    -- Revocation must remain possible after canonical ownership/lifecycle drift.
    RETURN NEW;
  END IF;
  WITH cohort AS (
    SELECT 'beta' kind,a.id,a.tenant_id,a.member_id,a.history_id,a.agreement_id,a.plan_id
      FROM public.bnms_dd_beta_adoption a WHERE a.tenant_id=NEW.tenant_id
    UNION ALL
    SELECT 'pilot',a.id,a.tenant_id,a.member_id,a.history_id,a.agreement_id,a.plan_id
      FROM public.bnms_dd_pilot_adoption a WHERE a.tenant_id=NEW.tenant_id
  )
  SELECT encode(sha256(convert_to(string_agg(
    concat_ws('|',a.kind,a.id,a.tenant_id,a.member_id,a.history_id,a.agreement_id,a.plan_id),
    E'\n' ORDER BY a.kind,a.id),'UTF8')),'hex')
    INTO scope_hash FROM cohort a;
  IF scope_hash IS DISTINCT FROM '24f504d58be98163858ebeaf91d796074a50c27f4013d07169ef31e83d9a2c64' THEN
    RAISE EXCEPTION 'Exact reviewed eleven-member recognition scope required';
  END IF;
  IF NOT EXISTS (
    WITH cohort AS (
      SELECT 'beta' kind,a.id,a.tenant_id,a.member_id,a.history_id,a.agreement_id,a.plan_id
        FROM public.bnms_dd_beta_adoption a
      UNION ALL
      SELECT 'pilot',a.id,a.tenant_id,a.member_id,a.history_id,a.agreement_id,a.plan_id
        FROM public.bnms_dd_pilot_adoption a
    )
    SELECT FROM cohort a
    JOIN public.member_membership_history h ON h.id=a.history_id
    JOIN public.membership_payment_plans p ON p.id=a.plan_id
    JOIN public.membership_billing_agreements b ON b.id=a.agreement_id
    JOIN public.member m ON m.id=a.member_id AND m.tenant_id=a.tenant_id
    WHERE a.kind=NEW.cohort AND a.id=NEW.adoption_id AND a.tenant_id=NEW.tenant_id
      AND a.member_id=NEW.member_id AND a.history_id=NEW.history_id
      AND a.agreement_id=NEW.agreement_id AND a.plan_id=NEW.plan_id
      AND h.tenant_id=a.tenant_id AND h.member_id=a.member_id AND h.billing_agreement_id=a.agreement_id
      AND p.tenant_id=a.tenant_id AND p.member_id=a.member_id AND p.billing_agreement_id=a.agreement_id
      AND b.tenant_id=a.tenant_id AND b.member_id=a.member_id
      AND p.provider='gocardless' AND b.provider='gocardless'
      AND h.payment_method='direct_debit' AND h.status='pending_payment_setup' AND h.payment_status='unpaid'
      AND h.term_start_date='2026-10-01' AND h.term_end_date='2027-09-30'
      AND h.membership_renewal_date=NEW.effective_until
      AND ((a.kind='beta' AND p.status='first_payment_pending' AND b.status='first_payment_pending'
        AND p.collection_stopped_at IS NOT NULL AND p.metadata->>'bnms_release_required'='true')
        OR (a.kind='pilot' AND p.status='mandate_pending' AND b.status='mandate_pending'
        AND p.collection_stopped_at IS NULL AND p.metadata->>'bnms_release_required'='false'))
  ) THEN
    RAISE EXCEPTION 'Recognition canonical ownership or source eligibility mismatch';
  END IF;
  IF EXISTS (SELECT FROM public.bnms_dd_alpha_membership_recognition r
    WHERE r.tenant_id=NEW.tenant_id AND r.member_id=NEW.member_id
      AND r.revoked_at IS NULL AND r.effective_from<NEW.effective_until
      AND r.effective_until>NEW.effective_from)
    OR EXISTS (SELECT FROM public.member_membership_history h
      WHERE h.tenant_id=NEW.tenant_id AND h.member_id=NEW.member_id AND h.id<>NEW.history_id
        AND h.status='active' AND h.term_start_date<NEW.effective_until
        AND h.membership_renewal_date>NEW.effective_from)
  THEN RAISE EXCEPTION 'Recognition overlaps existing current membership'; END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.validate_bnms_supplemental_recognition() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.validate_bnms_supplemental_recognition() TO service_role;
CREATE TRIGGER supplemental_recognition_guard
BEFORE INSERT OR UPDATE OR DELETE ON public.bnms_membership_recognition_beta_pilot
FOR EACH ROW EXECUTE FUNCTION public.validate_bnms_supplemental_recognition();