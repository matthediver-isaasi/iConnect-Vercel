-- Organisation membership year replacement.
--
-- PREPARED ONLY. Apply to DEST with the pinned migration runner after owner
-- approval; never replay blindly against older schemas.
--
-- A recorded organisation year may be retired ('replaced') and re-created for
-- the identical period with new pricing. The original keeps its dates and
-- invoice and is linked to its replacement. Replacement lineage is NOT renewal
-- lineage: previous_term_id is untouched.
--
-- Rollback (only while no replaced rows exist):
--   DROP FUNCTION public.apply_organisation_membership_replacement(uuid,uuid,uuid,text,text,jsonb);
--   DROP TRIGGER organisation_membership_replacement_guard ON public.organisation_membership_history;
--   DROP FUNCTION public.guard_organisation_membership_replacement();
--   DROP TABLE public.organisation_membership_replacement;
--   ALTER TABLE public.organisation_membership_history DROP COLUMN replaces_record_id,
--     DROP COLUMN replaced_by_record_id, DROP COLUMN replaced_at, DROP COLUMN replaced_by,
--     DROP COLUMN replacement_reason;
--   then rebuild the three indexes and the overlap constraint without
--   "AND status IS DISTINCT FROM 'replaced'".
BEGIN;

DO $$
BEGIN
  IF to_regclass('public.organisation_membership_history') IS NULL THEN
    RAISE EXCEPTION 'organisation_membership_history is required';
  END IF;
  IF EXISTS (SELECT 1 FROM public.organisation_membership_history WHERE status = 'replaced') THEN
    RAISE EXCEPTION 'Existing replaced organisation rows need provenance review before rollout';
  END IF;
END $$;

ALTER TABLE public.organisation_membership_history
  ADD COLUMN IF NOT EXISTS replaces_record_id uuid REFERENCES public.organisation_membership_history(id),
  ADD COLUMN IF NOT EXISTS replaced_by_record_id uuid REFERENCES public.organisation_membership_history(id) DEFERRABLE INITIALLY DEFERRED,
  ADD COLUMN IF NOT EXISTS replaced_at timestamptz,
  ADD COLUMN IF NOT EXISTS replaced_by uuid,
  ADD COLUMN IF NOT EXISTS replacement_reason text;

CREATE UNIQUE INDEX IF NOT EXISTS organisation_membership_history_replaces_uniq
  ON public.organisation_membership_history(replaces_record_id) WHERE replaces_record_id IS NOT NULL;

-- Durable operation journal. One row per original; idempotent per request key.
CREATE TABLE IF NOT EXISTS public.organisation_membership_replacement (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  source_record_id uuid NOT NULL UNIQUE REFERENCES public.organisation_membership_history(id),
  target_record_id uuid NOT NULL UNIQUE REFERENCES public.organisation_membership_history(id) DEFERRABLE INITIALLY DEFERRED,
  idempotency_key text NOT NULL,
  reason text NOT NULL CHECK (length(btrim(reason)) > 0),
  actor_id uuid NOT NULL,
  membership_year text NOT NULL,
  currency text,
  accounting_provider text,
  override jsonb,
  addon_lines jsonb NOT NULL DEFAULT '[]'::jsonb,
  invoice_snapshot jsonb,
  original_invoice_id text,
  original_invoice_number text,
  original_total numeric(12,2) NOT NULL DEFAULT 0,
  original_paid numeric(12,2) NOT NULL DEFAULT 0,
  replacement_total numeric(12,2) NOT NULL DEFAULT 0,
  credit_note_state text NOT NULL DEFAULT 'pending'
    CHECK (credit_note_state IN ('pending','done','not_required','failed')),
  credit_note_id text,
  credit_note_number text,
  credit_note_amount numeric(12,2),
  invoice_state text NOT NULL DEFAULT 'pending'
    CHECK (invoice_state IN ('pending','done','not_required','failed')),
  invoice_id text,
  invoice_number text,
  online_invoice_url text,
  allocation_state text NOT NULL DEFAULT 'pending'
    CHECK (allocation_state IN ('pending','done','not_required','failed')),
  allocation_amount numeric(12,2),
  email_state text NOT NULL DEFAULT 'pending'
    CHECK (email_state IN ('pending','done','not_required','failed')),
  sync_state text NOT NULL DEFAULT 'pending'
    CHECK (sync_state IN ('pending','in_progress','complete','failed')),
  lease_token uuid,
  lease_expires_at timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (tenant_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS organisation_membership_replacement_org_idx
  ON public.organisation_membership_replacement(tenant_id, organization_id);
ALTER TABLE public.organisation_membership_replacement ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.organisation_membership_replacement FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.organisation_membership_replacement FROM service_role;
GRANT SELECT ON public.organisation_membership_replacement TO service_role;
-- Step state is service-owned; identity, lineage and amounts are not.
GRANT UPDATE (accounting_provider, credit_note_state, credit_note_id, credit_note_number, credit_note_amount,
  invoice_state, invoice_id, invoice_number, online_invoice_url, allocation_state, allocation_amount,
  email_state, sync_state, lease_token, lease_expires_at, attempts, last_error, updated_at, completed_at)
  ON public.organisation_membership_replacement TO service_role;

-- Retired rows leave uniqueness/overlap authority; live rows keep every rule.
DO $$
DECLARE t text := 'organisation_membership_history'; index_name text; definition text; predicate text;
BEGIN
  FOREACH index_name IN ARRAY ARRAY[t || '_org_year_uniq', t || '_rolling_term_uniq', t || '_rolling_successor_uniq'] LOOP
    SELECT pg_get_indexdef(to_regclass('public.' || index_name)) INTO definition;
    predicate := CASE WHEN index_name LIKE '%year_uniq' THEN 'term_key IS NULL'
      WHEN index_name LIKE '%term_uniq' THEN 'term_key IS NOT NULL' ELSE 'previous_term_id IS NOT NULL' END;
    IF definition IS NULL OR position(predicate IN definition) = 0 THEN
      RAISE EXCEPTION 'History uniqueness contract changed for %', index_name;
    END IF;
    IF position('replaced' IN definition) = 0 THEN
      EXECUTE format('DROP INDEX public.%I', index_name);
      EXECUTE replace(definition, predicate, predicate || ' AND status IS DISTINCT FROM ''replaced''');
    END IF;
  END LOOP;
  SELECT pg_get_constraintdef(oid) INTO definition FROM pg_constraint
    WHERE conrelid = ('public.' || t)::regclass AND conname = t || '_rolling_no_overlap';
  IF definition IS NULL OR position('term_key IS NOT NULL' IN definition) = 0 THEN
    RAISE EXCEPTION 'History overlap contract changed';
  END IF;
  IF position('replaced' IN definition) = 0 THEN
    EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT %I', t, t || '_rolling_no_overlap');
    EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I %s', t, t || '_rolling_no_overlap',
      replace(definition, 'term_key IS NOT NULL', 'term_key IS NOT NULL AND status IS DISTINCT FROM ''replaced'''));
  END IF;
END $$;

-- Only the protected application function may retire a row, create a
-- replacement, or write lineage. A replaced row is never reactivated.
CREATE OR REPLACE FUNCTION public.guard_organisation_membership_replacement()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE op text := current_setting('app.organisation_membership_replacement', true);
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.status = 'replaced' AND NEW.status IS DISTINCT FROM 'replaced' THEN
      RAISE EXCEPTION 'A replaced membership year cannot be reactivated';
    END IF;
    IF OLD.status = 'replaced' AND (NEW.membership_year IS DISTINCT FROM OLD.membership_year
      OR NEW.term_start_date IS DISTINCT FROM OLD.term_start_date OR NEW.term_end_date IS DISTINCT FROM OLD.term_end_date) THEN
      RAISE EXCEPTION 'A replaced membership year keeps its original period';
    END IF;
    IF (NEW.status = 'replaced' AND OLD.status IS DISTINCT FROM 'replaced')
      OR NEW.replaces_record_id IS DISTINCT FROM OLD.replaces_record_id
      OR NEW.replaced_by_record_id IS DISTINCT FROM OLD.replaced_by_record_id
      OR NEW.replaced_at IS DISTINCT FROM OLD.replaced_at
      OR NEW.replaced_by IS DISTINCT FROM OLD.replaced_by
      OR NEW.replacement_reason IS DISTINCT FROM OLD.replacement_reason THEN
      IF op IS NULL OR op = '' OR NOT EXISTS (SELECT 1 FROM public.organisation_membership_replacement r
        WHERE r.id::text = op AND r.source_record_id = NEW.id AND r.tenant_id = NEW.tenant_id) THEN
        RAISE EXCEPTION 'Protected replacement application required to retire this membership year';
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status = 'replaced' OR NEW.replaced_by_record_id IS NOT NULL OR NEW.replaced_at IS NOT NULL THEN
    RAISE EXCEPTION 'A membership year cannot be created as replaced';
  END IF;
  IF NEW.replaces_record_id IS NOT NULL THEN
    IF op IS NULL OR op = '' OR NOT EXISTS (SELECT 1 FROM public.organisation_membership_replacement r
      WHERE r.id::text = op AND r.target_record_id = NEW.id AND r.source_record_id = NEW.replaces_record_id
        AND r.tenant_id = NEW.tenant_id) THEN
      RAISE EXCEPTION 'Protected replacement application required to create a replacement year';
    END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_organisation_membership_replacement() FROM PUBLIC, anon, authenticated, service_role;
DROP TRIGGER IF EXISTS organisation_membership_replacement_guard ON public.organisation_membership_history;
CREATE TRIGGER organisation_membership_replacement_guard
  BEFORE INSERT OR UPDATE ON public.organisation_membership_history
  FOR EACH ROW EXECUTE FUNCTION public.guard_organisation_membership_replacement();

-- Atomic application: lock the original, verify it is still the replaceable
-- live year, copy its period exactly, retire it and insert the replacement.
-- p_history carries only pricing/descriptive fields; period, ownership, PO,
-- frozen joining-incentive evidence and status come from the original;
-- lineage, payment-method and accounting columns are left empty. Replaying the same idempotency key returns the first result.
CREATE OR REPLACE FUNCTION public.apply_organisation_membership_replacement(
  p_tenant_id uuid, p_source_record_id uuid, p_actor_id uuid, p_reason text,
  p_idempotency_key text, p_payload jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  src public.organisation_membership_history;
  prior public.organisation_membership_replacement;
  op_id uuid := gen_random_uuid();
  target_id uuid := gen_random_uuid();
  h jsonb := coalesce(p_payload->'history', '{}'::jsonb);
  allowed text[] := ARRAY['config_id','band_id','tier_label','field_value','annual_cost','prorata_cost',
    'free_period_discount','rollover_discount','custom_discount_total','custom_discount_details','final_cost',
    'currency','billing_period','vat_rate_percent','vat_amount','total_with_vat',
    'year_number','prorata_days','free_period_days_applied','override_applied','override_type','notes',
    'xero_project_code','payment_status','paid_at'];
  copied text[] := ARRAY['tenant_id','organization_id','membership_year','term_start_date','term_end_date',
    'scheduled_activation_date','annual_renewal_state','membership_renewal_date','term_duration_months',
    'term_anchor_date','status','purchase_order_number','incentive_snapshot'];
  k text; cols text := ''; vals text := ''; src_json jsonb;
BEGIN
  IF p_tenant_id IS NULL OR p_source_record_id IS NULL OR p_actor_id IS NULL
    OR p_idempotency_key IS NULL OR length(btrim(coalesce(p_reason,''))) = 0 THEN
    RAISE EXCEPTION 'Tenant, original year, actor, reason and idempotency key are required' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO prior FROM public.organisation_membership_replacement
    WHERE tenant_id = p_tenant_id AND (idempotency_key = p_idempotency_key OR source_record_id = p_source_record_id);
  IF FOUND THEN
    IF prior.idempotency_key IS DISTINCT FROM p_idempotency_key OR prior.source_record_id IS DISTINCT FROM p_source_record_id THEN
      RAISE EXCEPTION 'This membership year has already been replaced' USING ERRCODE = 'PT409';
    END IF;
    RETURN jsonb_build_object('operation_id', prior.id, 'target_record_id', prior.target_record_id, 'replayed', true);
  END IF;
  SELECT * INTO src FROM public.organisation_membership_history
    WHERE id = p_source_record_id AND tenant_id = p_tenant_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Membership year not found' USING ERRCODE = 'P0002'; END IF;
  IF src.status IN ('replaced','cancelled','canceled','void','expired_checkout','cancelled_by_request')
    OR src.cancelled_for_switch_at IS NOT NULL OR src.replaced_by_record_id IS NOT NULL THEN
    RAISE EXCEPTION 'This membership year is not replaceable' USING ERRCODE = 'PT409';
  END IF;
  IF src.term_key IS NOT NULL THEN
    RAISE EXCEPTION 'Rolling commitment terms cannot be replaced' USING ERRCODE = 'PT409';
  END IF;
  IF (p_payload ? 'period') AND (
    (p_payload->'period'->>'membership_year') IS DISTINCT FROM src.membership_year
    OR (p_payload->'period'->>'term_start_date') IS DISTINCT FROM src.term_start_date::text
    OR (p_payload->'period'->>'term_end_date') IS DISTINCT FROM src.term_end_date::text) THEN
    RAISE EXCEPTION 'The membership period cannot be changed by a replacement' USING ERRCODE = '22023';
  END IF;
  FOR k IN SELECT jsonb_object_keys(h) LOOP
    IF NOT (k = ANY(allowed)) THEN
      RAISE EXCEPTION 'Replacement field % is not permitted', k USING ERRCODE = '22023';
    END IF;
  END LOOP;

  PERFORM set_config('app.organisation_membership_replacement', op_id::text, true);
  INSERT INTO public.organisation_membership_replacement(
    id, tenant_id, organization_id, source_record_id, target_record_id, idempotency_key, reason, actor_id,
    membership_year, currency, accounting_provider, override, addon_lines, invoice_snapshot, original_invoice_id,
    original_invoice_number, original_total, original_paid, replacement_total,
    credit_note_state, invoice_state, allocation_state, email_state)
  VALUES (op_id, p_tenant_id, src.organization_id, src.id, target_id, p_idempotency_key, btrim(p_reason), p_actor_id,
    src.membership_year, coalesce(h->>'currency', src.currency), p_payload->>'accounting_provider',
    p_payload->'override', coalesce(p_payload->'addon_lines', '[]'::jsonb), p_payload->'invoice_snapshot',
    coalesce(src.accounting_invoice_id, src.xero_invoice_id),
    coalesce(src.accounting_invoice_number, src.xero_invoice_number),
    coalesce((p_payload->>'original_total')::numeric, 0), coalesce((p_payload->>'original_paid')::numeric, 0),
    coalesce((p_payload->>'replacement_total')::numeric, 0),
    coalesce(p_payload->>'credit_note_state', 'pending'), coalesce(p_payload->>'invoice_state', 'pending'),
    coalesce(p_payload->>'allocation_state', 'pending'), coalesce(p_payload->>'email_state', 'pending'));

  UPDATE public.organisation_membership_history
    SET status = 'replaced', replaced_by_record_id = target_id, replaced_at = now(),
        replaced_by = p_actor_id, replacement_reason = btrim(p_reason)
    WHERE id = src.id;

  src_json := to_jsonb(src);
  cols := 'id, replaces_record_id, replacement_reason, replaced_by';
  vals := quote_literal(target_id) || '::uuid, ' || quote_literal(src.id) || '::uuid, '
    || quote_literal(btrim(p_reason)) || ', ' || quote_literal(p_actor_id) || '::uuid';
  FOREACH k IN ARRAY copied LOOP
    IF src_json ? k AND src_json->>k IS NOT NULL THEN
      cols := cols || ', ' || quote_ident(k);
      vals := vals || format(', (jsonb_populate_record(NULL::public.organisation_membership_history, %L::jsonb)).%I',
        jsonb_build_object(k, src_json->k), k);
    END IF;
  END LOOP;
  FOR k IN SELECT jsonb_object_keys(h) LOOP
    IF h->>k IS NOT NULL AND NOT (k = ANY(copied)) THEN
      cols := cols || ', ' || quote_ident(k);
      vals := vals || format(', (jsonb_populate_record(NULL::public.organisation_membership_history, %L::jsonb)).%I',
        jsonb_build_object(k, h->k), k);
    END IF;
  END LOOP;
  EXECUTE format('INSERT INTO public.organisation_membership_history (%s) VALUES (%s)', cols, vals);

  RETURN jsonb_build_object('operation_id', op_id, 'target_record_id', target_id, 'replayed', false);
END $$;
REVOKE ALL ON FUNCTION public.apply_organisation_membership_replacement(uuid,uuid,uuid,text,text,jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_organisation_membership_replacement(uuid,uuid,uuid,text,text,jsonb)
  TO service_role;

COMMIT;
