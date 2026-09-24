-- REVIEW ONLY. Separate 95-person workbook cohort. No Alpha/Beta/pilot changes.
-- Install inside the separately reviewed operator transaction; this file creates no memberships.
CREATE TABLE public.bnms_dd_manual_manifest (
  sha256 text PRIMARY KEY CHECK(sha256 ~ '^[a-f0-9]{64}$'),
  tenant_id uuid NOT NULL CHECK(tenant_id='ff2df806-b321-4254-b651-3af11fccf1db'),
  workbook_sha256 text NOT NULL CHECK(workbook_sha256='ddbc1a3d789e17ad78d507284b7823570e2f383fd5455f1e57a6a6e962f09d2a'),
  evidence jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(workbook_sha256)
);
CREATE TABLE public.bnms_dd_manual_adoption (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL CHECK(tenant_id='ff2df806-b321-4254-b651-3af11fccf1db'),
  member_id uuid NOT NULL UNIQUE REFERENCES public.member(id),
  customer_id text NOT NULL UNIQUE,
  mandate_id text NOT NULL UNIQUE,
  agreement_id uuid NOT NULL UNIQUE REFERENCES public.membership_billing_agreements(id),
  plan_id uuid NOT NULL UNIQUE REFERENCES public.membership_payment_plans(id),
  history_id uuid NOT NULL UNIQUE REFERENCES public.member_membership_history(id),
  workbook_sha256 text NOT NULL CHECK(workbook_sha256='ddbc1a3d789e17ad78d507284b7823570e2f383fd5455f1e57a6a6e962f09d2a'),
  manifest_sha256 text NOT NULL REFERENCES public.bnms_dd_manual_manifest(sha256),
  evidence_sha256 text NOT NULL CHECK(evidence_sha256 ~ '^[a-f0-9]{64}$'),
  evidence jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(id,tenant_id,member_id,plan_id,manifest_sha256)
);
CREATE TABLE public.bnms_dd_manual_release (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  member_id uuid NOT NULL UNIQUE,
  adoption_id uuid NOT NULL UNIQUE,
  plan_id uuid NOT NULL UNIQUE,
  manifest_sha256 text NOT NULL,
  processing_not_before timestamptz NOT NULL CHECK(processing_not_before='2026-10-01 00:00:00 Europe/London'::timestamptz),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(adoption_id,tenant_id,member_id,plan_id,manifest_sha256)
    REFERENCES public.bnms_dd_manual_adoption(id,tenant_id,member_id,plan_id,manifest_sha256)
);
-- Recognition is dated administrative evidence, not active/paid history.
CREATE VIEW public.bnms_dd_manual_membership_recognition WITH(security_invoker=true) AS
 SELECT a.tenant_id,a.member_id,a.history_id,a.agreement_id,a.plan_id,a.id AS adoption_id,
   '2026-09-24'::date AS effective_from,'2027-10-01'::date AS effective_until,
   NULL::timestamptz AS revoked_at,'bnms_manual_95'::text AS provenance,a.workbook_sha256,a.manifest_sha256
 FROM public.bnms_dd_manual_adoption a
 JOIN public.bnms_dd_manual_release r ON r.adoption_id=a.id;
ALTER TABLE public.bnms_dd_manual_manifest ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bnms_dd_manual_adoption ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bnms_dd_manual_release ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.bnms_dd_manual_manifest,public.bnms_dd_manual_adoption,public.bnms_dd_manual_release,
  public.bnms_dd_manual_membership_recognition FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.bnms_dd_manual_manifest,public.bnms_dd_manual_adoption,public.bnms_dd_manual_release,
  public.bnms_dd_manual_membership_recognition TO service_role;

CREATE FUNCTION public.bnms_manual_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN RAISE EXCEPTION 'Manual cohort approval/adoption/release is immutable'; END $$;
CREATE TRIGGER bnms_manual_manifest_immutable BEFORE UPDATE OR DELETE ON public.bnms_dd_manual_manifest
 FOR EACH ROW EXECUTE FUNCTION public.bnms_manual_immutable();
CREATE TRIGGER bnms_manual_adoption_immutable BEFORE UPDATE OR DELETE ON public.bnms_dd_manual_adoption
 FOR EACH ROW EXECUTE FUNCTION public.bnms_manual_immutable();
CREATE TRIGGER bnms_manual_release_immutable BEFORE UPDATE OR DELETE ON public.bnms_dd_manual_release
 FOR EACH ROW EXECUTE FUNCTION public.bnms_manual_immutable();

CREATE FUNCTION public.bnms_manual_complete_scope() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE identity_hash text;
BEGIN
 SELECT encode(sha256(convert_to(string_agg(member_id::text||'|'||customer_id||'|'||mandate_id,E'\n'
   ORDER BY member_id::text||'|'||customer_id||'|'||mandate_id),'UTF8')),'hex')
 INTO identity_hash FROM bnms_dd_manual_adoption;
 IF identity_hash IS DISTINCT FROM 'b3c63bee0485ba106b0df6c2339821a48dcf4b6d4f0cc2066268a0237978c7f4'
   OR (SELECT count(*) FROM bnms_dd_manual_adoption)<>95
   OR (SELECT count(*) FROM bnms_dd_manual_release)<>95
   OR (SELECT count(*) FROM bnms_dd_manual_manifest)<>1
   OR (SELECT sum((evidence->>'monthlyQuoteMinor')::integer) FROM bnms_dd_manual_adoption)<>87174 THEN
   RAISE EXCEPTION 'Exact 95-person atomic manual scope and approved total required';
 END IF;
 IF EXISTS(
   SELECT FROM bnms_dd_manual_adoption a
   JOIN membership_billing_agreements b ON b.id=a.agreement_id
   JOIN membership_payment_plans p ON p.id=a.plan_id
   JOIN member_membership_history h ON h.id=a.history_id
   JOIN member m ON m.id=a.member_id
   WHERE b.tenant_id<>a.tenant_id OR p.tenant_id<>a.tenant_id OR h.tenant_id<>a.tenant_id OR m.tenant_id<>a.tenant_id
     OR b.member_id IS DISTINCT FROM a.member_id OR p.member_id IS DISTINCT FROM a.member_id OR h.member_id IS DISTINCT FROM a.member_id
     OR p.billing_agreement_id IS DISTINCT FROM b.id OR h.billing_agreement_id IS DISTINCT FROM b.id
     OR b.gocardless_customer_id IS DISTINCT FROM a.customer_id OR b.gocardless_mandate_id IS DISTINCT FROM a.mandate_id
     OR p.gocardless_mandate_id IS DISTINCT FROM a.mandate_id
     OR b.provider<>'gocardless' OR b.environment<>'live' OR p.provider<>'gocardless' OR p.environment<>'live'
     OR b.status<>'first_payment_pending' OR p.status<>'first_payment_pending'
     OR h.status<>'pending_payment_setup' OR h.payment_status<>'unpaid' OR h.paid_at IS NOT NULL
     OR m.status<>'active' OR m.membership_paused IS TRUE
     OR b.metadata->'dd' IS DISTINCT FROM a.evidence->'dd'
     OR b.metadata#>>'{dd,accepted_at}' IS NOT NULL
     OR b.metadata#>>'{dd,billing_request_mode}' IS DISTINCT FROM 'migration_existing_mandate'
     OR b.metadata#>>'{dd,collection_policy,pricing_policy}' IS DISTINCT FROM 'dynamic'
     OR b.metadata#>>'{dd,invoicing_mode}' IS DISTINCT FROM 'per_instalment'
     OR p.metadata->>'collection_mode' IS DISTINCT FROM 'dynamic'
     OR p.metadata->>'dynamic_first_date' IS DISTINCT FROM '2026-10-01'
     OR p.dynamic_next_check_at IS DISTINCT FROM '2026-10-01 00:00:00 Europe/London'::timestamptz
     OR p.dynamic_next_collection_date IS DISTINCT FROM '2026-10-01'::date OR p.collection_stopped_at IS NOT NULL
     OR p.amount_minor IS DISTINCT FROM (a.evidence->>'monthlyQuoteMinor')::integer OR p.currency<>'GBP'
     OR a.evidence#>>'{accounting,bankAccountId}' IS DISTINCT FROM 'd115eacc-1fa7-476d-844e-d3d7f07f5db5'
     OR a.evidence#>>'{accounting,xeroTenantId}' IS DISTINCT FROM '3d57dce6-2205-462f-abf6-9c7cbf00be23'
     OR NULLIF(a.evidence#>>'{accounting,contactId}','') IS NULL
     OR NULLIF(a.evidence#>>'{accounting,contactEmail}','') IS NULL
     OR NULLIF(a.evidence#>>'{accounting,revenueCode}','') IS NULL
     OR a.evidence#>>'{accounting,contactEvidence,ContactID}' IS DISTINCT FROM a.evidence#>>'{accounting,contactId}'
     OR a.evidence#>>'{accounting,contactEvidence,ContactStatus}' IS DISTINCT FROM 'ACTIVE'
     OR lower(trim(a.evidence#>>'{accounting,contactEvidence,EmailAddress}')) IS DISTINCT FROM a.evidence#>>'{accounting,contactEmail}'
     OR (a.evidence#>>'{accounting,revenueCode}' IS DISTINCT FROM a.evidence#>>'{structure,nominal_code}'
       AND (a.evidence#>>'{structure,structure_match_value}'='Associate'
         AND a.evidence#>>'{structure,nominal_code}' IS NULL
         AND a.evidence#>>'{accounting,revenueCode}'='202'
         AND a.evidence#>>'{accounting,revenueEvidence,source}'='cached_original_explicit_associate_nominal'
         AND a.evidence#>>'{accounting,revenueEvidence,code}'='202'
         AND a.evidence#>>'{accounting,revenueEvidence,contactId}'=a.evidence#>>'{accounting,contactId}') IS NOT TRUE)
 ) THEN RAISE EXCEPTION 'Manual canonical ownership, unpaid term or accounting binding mismatch'; END IF;
 IF EXISTS(SELECT FROM bnms_dd_manual_adoption a JOIN bnms_dd_manual_adoption b
   ON a.member_id<>b.member_id AND a.evidence#>>'{accounting,contactId}'=b.evidence#>>'{accounting,contactId}')
 THEN RAISE EXCEPTION 'Manual Xero contact owner collision'; END IF;
 IF EXISTS(SELECT FROM bnms_dd_manual_adoption a JOIN bnms_dd_manual_manifest m ON m.sha256=a.manifest_sha256
   WHERE NOT EXISTS(SELECT FROM jsonb_array_elements(m.evidence->'members') e WHERE e->>'memberId'=a.member_id::text AND e=a.evidence)
     OR m.evidence#>>'{approval,legacyCollectorHandover}' IS DISTINCT FROM 'user_confirmed_all_95_disabled_no_other_collections'
     OR m.evidence#>>'{approval,invoicePreflight}' IS DISTINCT FROM 'explicit_user_no_invoice_retrieval'
     OR m.evidence#>>'{approval,recognitionFrom}' IS DISTINCT FROM '2026-09-24'
     OR m.evidence#>>'{approval,recognitionUntil}' IS DISTINCT FROM '2027-10-01'
     OR a.evidence#>>'{accounting,bankEvidence,AccountID}' IS DISTINCT FROM 'd115eacc-1fa7-476d-844e-d3d7f07f5db5'
     OR a.evidence#>>'{accounting,bankEvidence,Status}' IS DISTINCT FROM 'ACTIVE'
     OR a.evidence#>>'{accounting,bankEvidence,Type}' IS DISTINCT FROM 'BANK'
     OR a.evidence#>>'{accounting,bankEvidence,CurrencyCode}' IS DISTINCT FROM 'GBP')
 THEN RAISE EXCEPTION 'Manual exact manifest authority/bank evidence mismatch'; END IF;
 IF EXISTS(SELECT FROM bnms_dd_manual_adoption a JOIN membership_billing_agreements b
   ON (b.member_id=a.member_id OR b.gocardless_mandate_id=a.mandate_id OR b.gocardless_customer_id=a.customer_id)
   AND b.id<>a.agreement_id)
 OR EXISTS(SELECT FROM bnms_dd_manual_adoption a JOIN membership_payment_plans p
   ON (p.member_id=a.member_id OR p.gocardless_mandate_id=a.mandate_id) AND p.id<>a.plan_id)
 OR EXISTS(SELECT FROM bnms_dd_manual_adoption a JOIN member_membership_history h ON h.member_id=a.member_id AND h.id<>a.history_id)
 THEN RAISE EXCEPTION 'Manual cohort duplicate canonical identity'; END IF;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER bnms_manual_complete_adoption AFTER INSERT ON public.bnms_dd_manual_adoption
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.bnms_manual_complete_scope();
CREATE CONSTRAINT TRIGGER bnms_manual_complete_release AFTER INSERT ON public.bnms_dd_manual_release
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.bnms_manual_complete_scope();
CREATE CONSTRAINT TRIGGER bnms_manual_complete_manifest AFTER INSERT ON public.bnms_dd_manual_manifest
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.bnms_manual_complete_scope();

CREATE FUNCTION public.bnms_manual_reservation_gate() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE a public.bnms_dd_manual_adoption; r public.bnms_dd_manual_release; checked_at timestamptz;
BEGIN
 SELECT * INTO a FROM bnms_dd_manual_adoption WHERE plan_id=NEW.plan_id OR agreement_id=NEW.billing_agreement_id;
 IF NOT FOUND THEN RETURN NEW; END IF;
 SELECT * INTO STRICT r FROM bnms_dd_manual_release WHERE adoption_id=a.id;
 IF clock_timestamp()<r.processing_not_before THEN RAISE EXCEPTION 'Manual October 1 London submission gate'; END IF;
 IF NEW.tenant_id<>a.tenant_id OR NEW.plan_id<>a.plan_id OR NEW.billing_agreement_id<>a.agreement_id
   OR NEW.currency<>'GBP' OR NEW.due_date<'2026-10-01'::date OR NEW.due_date>'2027-09-30'::date
   OR NEW.requested_charge_date<NEW.due_date OR NEW.requested_charge_date>NEW.due_date+7
   OR (NEW.collection_number=1 AND NEW.amount_minor<>(a.evidence->>'monthlyQuoteMinor')::integer)
 THEN RAISE EXCEPTION 'Manual reservation identity, amount or cadence mismatch'; END IF;
 IF TG_OP='INSERT' THEN
   checked_at := (NEW.provider_evidence->>'checked_at')::timestamptz;
   IF NEW.provider_evidence->>'status' IS DISTINCT FROM 'active'
     OR checked_at IS NULL OR checked_at<r.processing_not_before OR checked_at>clock_timestamp()
     OR checked_at<clock_timestamp()-interval '15 minutes'
     OR NEW.requested_charge_date<(clock_timestamp() AT TIME ZONE 'Europe/London')::date
     OR NEW.requested_charge_date IS DISTINCT FROM (NEW.provider_evidence->>'next_possible_charge_date')::date
   THEN RAISE EXCEPTION 'Manual reservation requires fresh active mandate and provider debit date'; END IF;
 ELSIF NEW.provider_evidence->>'checked_at' IS DISTINCT FROM OLD.provider_evidence->>'checked_at'
   OR NEW.provider_evidence->>'next_possible_charge_date' IS DISTINCT FROM OLD.provider_evidence->>'next_possible_charge_date'
 THEN RAISE EXCEPTION 'Manual original provider evidence immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER bnms_manual_reservation_gate BEFORE INSERT OR UPDATE ON public.gocardless_collection_reservations
 FOR EACH ROW EXECUTE FUNCTION public.bnms_manual_reservation_gate();

CREATE FUNCTION public.bnms_manual_canonical_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE a public.bnms_dd_manual_adoption;
BEGIN
 SELECT * INTO a FROM bnms_dd_manual_adoption
 WHERE CASE TG_TABLE_NAME WHEN 'membership_billing_agreements' THEN agreement_id=OLD.id
   WHEN 'membership_payment_plans' THEN plan_id=OLD.id ELSE history_id=OLD.id END;
 IF NOT FOUND THEN IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF; END IF;
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Manual canonical records cannot be deleted'; END IF;
 IF NEW.tenant_id IS DISTINCT FROM a.tenant_id OR NEW.member_id IS DISTINCT FROM a.member_id OR NEW.id<>OLD.id
 THEN RAISE EXCEPTION 'Manual owner immutable'; END IF;
 IF TG_TABLE_NAME='membership_billing_agreements' THEN
   IF NEW.gocardless_customer_id IS DISTINCT FROM a.customer_id OR NEW.gocardless_mandate_id IS DISTINCT FROM a.mandate_id
     OR NEW.provider<>'gocardless' OR NEW.environment<>'live'
     OR NEW.metadata->'dd' IS DISTINCT FROM OLD.metadata->'dd'
     OR NEW.metadata->'commitment' IS DISTINCT FROM OLD.metadata->'commitment'
     OR NEW.commitment_snapshot IS DISTINCT FROM OLD.commitment_snapshot
     OR NEW.metadata->>'bnms_manual_cohort' IS DISTINCT FROM OLD.metadata->>'bnms_manual_cohort'
   THEN RAISE EXCEPTION 'Manual purchased terms/provider immutable'; END IF;
 ELSIF TG_TABLE_NAME='membership_payment_plans' THEN
   IF NEW.billing_agreement_id IS DISTINCT FROM a.agreement_id OR NEW.gocardless_mandate_id IS DISTINCT FROM a.mandate_id
     OR NEW.provider<>'gocardless' OR NEW.environment<>'live' OR NEW.gocardless_subscription_id IS NOT NULL
     OR NEW.metadata->>'collection_mode' IS DISTINCT FROM 'dynamic'
     OR NEW.metadata->>'dynamic_first_date' IS DISTINCT FROM '2026-10-01'
     OR NEW.metadata->>'bnms_manual_cohort' IS DISTINCT FROM OLD.metadata->>'bnms_manual_cohort'
   THEN RAISE EXCEPTION 'Manual plan identity/cadence immutable'; END IF;
 ELSE
   IF NEW.billing_agreement_id IS DISTINCT FROM a.agreement_id
     OR NEW.term_start_date IS DISTINCT FROM OLD.term_start_date OR NEW.term_end_date IS DISTINCT FROM OLD.term_end_date
     OR NEW.commitment_snapshot IS DISTINCT FROM OLD.commitment_snapshot
   THEN RAISE EXCEPTION 'Manual membership dated terms immutable'; END IF;
   IF (NEW.status='active' OR NEW.payment_status IN ('paid','partial') OR NEW.paid_at IS NOT NULL)
     AND NOT EXISTS(SELECT FROM gocardless_payments p JOIN gocardless_collection_reservations r
       ON r.gocardless_payment_id=p.gocardless_payment_id AND r.plan_id=a.plan_id AND r.billing_agreement_id=a.agreement_id
       WHERE p.tenant_id=a.tenant_id AND p.plan_id=a.plan_id AND p.gocardless_mandate_id=a.mandate_id
       AND p.status IN ('confirmed','paid_out') AND r.collection_number=1 AND p.charge_date>='2026-10-01')
   THEN RAISE EXCEPTION 'Manual activation requires first managed confirmed payment'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER bnms_manual_agreement_guard BEFORE UPDATE OR DELETE ON public.membership_billing_agreements
 FOR EACH ROW EXECUTE FUNCTION public.bnms_manual_canonical_guard();
CREATE TRIGGER bnms_manual_plan_guard BEFORE UPDATE OR DELETE ON public.membership_payment_plans
 FOR EACH ROW EXECUTE FUNCTION public.bnms_manual_canonical_guard();
CREATE TRIGGER bnms_manual_history_guard BEFORE UPDATE OR DELETE ON public.member_membership_history
 FOR EACH ROW EXECUTE FUNCTION public.bnms_manual_canonical_guard();
CREATE FUNCTION public.bnms_manual_duplicate_owner_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE a public.bnms_dd_manual_adoption; expected uuid;
BEGIN
 SELECT * INTO a FROM bnms_dd_manual_adoption WHERE member_id=NEW.member_id;
 IF FOUND THEN
   expected:=CASE TG_TABLE_NAME WHEN 'membership_billing_agreements' THEN a.agreement_id
     WHEN 'membership_payment_plans' THEN a.plan_id ELSE a.history_id END;
   IF NEW.id IS DISTINCT FROM expected THEN RAISE EXCEPTION 'Manual adopted owner cannot gain duplicate canonical commitment'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER bnms_manual_agreement_duplicate BEFORE INSERT OR UPDATE ON public.membership_billing_agreements
 FOR EACH ROW EXECUTE FUNCTION public.bnms_manual_duplicate_owner_guard();
CREATE TRIGGER bnms_manual_plan_duplicate BEFORE INSERT OR UPDATE ON public.membership_payment_plans
 FOR EACH ROW EXECUTE FUNCTION public.bnms_manual_duplicate_owner_guard();
CREATE TRIGGER bnms_manual_history_duplicate BEFORE INSERT OR UPDATE ON public.member_membership_history
 FOR EACH ROW EXECUTE FUNCTION public.bnms_manual_duplicate_owner_guard();
CREATE FUNCTION public.bnms_manual_payment_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE a public.bnms_dd_manual_adoption;
BEGIN
 IF TG_OP='UPDATE' AND EXISTS(SELECT FROM bnms_dd_manual_adoption WHERE mandate_id=OLD.gocardless_mandate_id)
   AND (NEW.gocardless_mandate_id IS DISTINCT FROM OLD.gocardless_mandate_id
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.plan_id IS DISTINCT FROM OLD.plan_id)
 THEN RAISE EXCEPTION 'Manual managed payment ownership immutable'; END IF;
 SELECT * INTO a FROM bnms_dd_manual_adoption WHERE mandate_id=NEW.gocardless_mandate_id;
 IF NOT FOUND THEN RETURN NEW; END IF;
 IF clock_timestamp()<'2026-10-01 00:00:00 Europe/London'::timestamptz
   OR NEW.tenant_id IS DISTINCT FROM a.tenant_id OR NEW.plan_id IS DISTINCT FROM a.plan_id
   OR NEW.charge_date IS NULL OR NEW.charge_date<'2026-10-01'
   OR NOT EXISTS(SELECT FROM gocardless_collection_reservations r
     WHERE r.plan_id=a.plan_id AND r.tenant_id=a.tenant_id AND r.billing_agreement_id=a.agreement_id
       AND r.gocardless_payment_id=NEW.gocardless_payment_id AND r.amount_minor=NEW.amount_minor
       AND r.currency=NEW.currency AND r.requested_charge_date=NEW.charge_date)
 THEN RAISE EXCEPTION 'Manual historical/unreserved payment cannot enter managed future collection'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER bnms_manual_payment_guard BEFORE INSERT OR UPDATE ON public.gocardless_payments
 FOR EACH ROW EXECUTE FUNCTION public.bnms_manual_payment_guard();
REVOKE ALL ON FUNCTION public.bnms_manual_immutable(),public.bnms_manual_complete_scope(),
 public.bnms_manual_reservation_gate(),public.bnms_manual_canonical_guard(),public.bnms_manual_duplicate_owner_guard(),
 public.bnms_manual_payment_guard() FROM PUBLIC,anon,authenticated,service_role;