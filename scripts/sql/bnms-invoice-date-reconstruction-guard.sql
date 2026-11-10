-- An exact before/after maintenance journal, not a general commitment-edit bypass.
-- No API/browser/service-role writer can authorise a repair through this table.
CREATE TABLE IF NOT EXISTS public.bnms_invoice_date_reconstruction_audit (
  history_id uuid PRIMARY KEY REFERENCES public.member_membership_history(id),
  tenant_id uuid NOT NULL CHECK (tenant_id='ff2df806-b321-4254-b651-3af11fccf1db'),
  member_id uuid NOT NULL,
  plan_hash text NOT NULL CHECK (plan_hash ~ '^[a-f0-9]{64}$'),
  before_record jsonb NOT NULL,
  after_record jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (before_record->>'id'=history_id::text AND after_record->>'id'=history_id::text),
  CHECK (before_record->>'tenant_id'=tenant_id::text AND after_record->>'tenant_id'=tenant_id::text),
  CHECK (before_record->>'member_id'=member_id::text AND after_record->>'member_id'=member_id::text),
  CHECK (before_record->>'payment_status'='paid'),
  CHECK (before_record->>'payment_method' IS NULL OR before_record->>'payment_method'='upfront'),
  CHECK (before_record->>'term_key' IS NULL AND before_record->>'commitment_snapshot' IS NULL
    AND before_record->>'renewal_policy_snapshot' IS NULL
    AND before_record->>'billing_agreement_id' IS NULL
    AND before_record->>'membership_payment_quote_id' IS NULL
    AND before_record->>'membership_successor_election_id' IS NULL),
  CHECK (after_record->>'term_start_date' IS NOT NULL
    AND after_record->>'term_end_date' IS NOT NULL
    AND (after_record->>'term_start_date')::date <= (after_record->>'term_end_date')::date
    AND jsonb_typeof(after_record->'renewal_policy_snapshot')='object'),
  CHECK (
    before_record - ARRAY['term_start_date','config_id','renewal_policy_snapshot','payment_method',
      'accounting_provider','accounting_invoice_id','accounting_invoice_number','xero_invoice_id','xero_invoice_number','notes']
    =
    after_record - ARRAY['term_start_date','config_id','renewal_policy_snapshot','payment_method',
      'accounting_provider','accounting_invoice_id','accounting_invoice_number','xero_invoice_id','xero_invoice_number','notes']
  )
);
ALTER TABLE public.bnms_invoice_date_reconstruction_audit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.bnms_invoice_date_reconstruction_audit FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.bnms_invoice_date_reconstruction_audit TO service_role;

DO $$
DECLARE definition text; marker text := '    IF TG_TABLE_NAME <> ''membership_billing_agreements''
      AND to_jsonb(OLD)->''renewal_policy_snapshot'' IS DISTINCT FROM r->''renewal_policy_snapshot'' THEN
      RAISE EXCEPTION ''Purchased renewal policy is immutable'';
    END IF;';
replacement text := '    IF TG_TABLE_NAME <> ''membership_billing_agreements''
      AND to_jsonb(OLD)->''renewal_policy_snapshot'' IS DISTINCT FROM r->''renewal_policy_snapshot'' THEN
      -- bnms_invoice_date_exact_repair_v1: only the owner-reviewed legacy transition.
      IF NOT (TG_TABLE_NAME = ''member_membership_history'' AND EXISTS (
        SELECT 1 FROM public.bnms_invoice_date_reconstruction_audit a
        WHERE a.history_id=OLD.id AND a.tenant_id=OLD.tenant_id
          AND a.member_id=(r->>''member_id'')::uuid
          AND a.before_record=to_jsonb(OLD) AND a.after_record=r
      )) THEN
        RAISE EXCEPTION ''Purchased renewal policy is immutable'';
      END IF;
    END IF;';
BEGIN
  definition := pg_get_functiondef('public.guard_membership_successor_owner()'::regprocedure);
  IF position('bnms_invoice_date_exact_repair_v1' in definition)>0 THEN RETURN; END IF;
  IF position(marker in definition)=0 THEN RAISE EXCEPTION 'Unexpected successor guard; no change applied'; END IF;
  EXECUTE replace(definition, marker, replacement);
END $$;
