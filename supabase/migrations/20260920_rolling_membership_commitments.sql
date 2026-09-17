-- Rolling terms are immutable purchases, not calendar-year estimates.
-- No legacy backfill: use the offline recovery report and review evidence first.
BEGIN;
CREATE EXTENSION IF NOT EXISTS btree_gist;

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['member_membership_history', 'organisation_membership_history', 'membership_billing_agreements'] LOOP
    EXECUTE format('ALTER TABLE %I
      ADD COLUMN IF NOT EXISTS term_start_date DATE,
      ADD COLUMN IF NOT EXISTS term_end_date DATE,
      ADD COLUMN IF NOT EXISTS membership_renewal_date DATE,
      ADD COLUMN IF NOT EXISTS term_duration_months INTEGER,
      ADD COLUMN IF NOT EXISTS term_anchor_date DATE,
      ADD COLUMN IF NOT EXISTS term_key TEXT,
      ADD COLUMN IF NOT EXISTS previous_term_id UUID,
      ADD COLUMN IF NOT EXISTS commitment_snapshot JSONB', t);
    IF NOT EXISTS (SELECT FROM pg_constraint WHERE conname = t || '_rolling_complete_check') THEN
      EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK (
        (term_key IS NULL AND membership_renewal_date IS NULL AND term_duration_months IS NULL
          AND term_anchor_date IS NULL AND commitment_snapshot IS NULL AND previous_term_id IS NULL)
        OR (term_key IS NOT NULL AND term_start_date IS NOT NULL AND term_end_date IS NOT NULL
          AND membership_renewal_date IS NOT NULL AND term_duration_months IS NOT NULL AND term_duration_months IN (1,3,12)
          AND term_anchor_date IS NOT NULL AND term_anchor_date <= term_start_date
          AND term_start_date <= term_end_date AND term_end_date + 1 = membership_renewal_date
          AND term_key = ''rolling:'' || to_char(term_start_date, ''YYYY-MM-DD'')
          AND commitment_snapshot IS NOT NULL AND jsonb_typeof(commitment_snapshot) = ''object''
          AND commitment_snapshot->>''start_mode'' = ''immediate''))', t, t || '_rolling_complete_check');
    END IF;
  END LOOP;
END $$;

ALTER TABLE member_membership_history ADD COLUMN IF NOT EXISTS membership_payment_quote_id UUID REFERENCES membership_payment_quote(id);
ALTER TABLE organisation_membership_history ADD COLUMN IF NOT EXISTS membership_payment_quote_id UUID REFERENCES membership_payment_quote(id);

-- Keep fixed-cycle guarantees; rolling rows use term identity and may have
-- multiple purchases within a calendar year. Never drop agreement uniqueness.
DROP INDEX IF EXISTS member_membership_history_member_year_uniq;
CREATE UNIQUE INDEX member_membership_history_member_year_uniq
  ON member_membership_history (tenant_id, member_id, membership_year) WHERE term_key IS NULL;
DROP INDEX IF EXISTS organisation_membership_history_org_year_uniq;
CREATE UNIQUE INDEX organisation_membership_history_org_year_uniq
  ON organisation_membership_history (tenant_id, organization_id, membership_year) WHERE term_key IS NULL;
DO $$
BEGIN
  IF EXISTS (SELECT FROM organisation_membership_history WHERE billing_agreement_id IS NOT NULL
    GROUP BY billing_agreement_id HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'Duplicate organisation billing-agreement history rows must be reviewed before enabling rolling commitments';
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS organisation_membership_history_billing_agreement_uniq
  ON organisation_membership_history (billing_agreement_id) WHERE billing_agreement_id IS NOT NULL;

DO $$
DECLARE t TEXT; owner_column TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['member_membership_history', 'organisation_membership_history'] LOOP
    owner_column := CASE WHEN t = 'member_membership_history' THEN 'member_id' ELSE 'organization_id' END;
    EXECUTE format('CREATE UNIQUE INDEX IF NOT EXISTS %I ON %I (tenant_id, %I, term_key) WHERE term_key IS NOT NULL', t || '_rolling_term_uniq', t, owner_column);
    EXECUTE format('CREATE UNIQUE INDEX IF NOT EXISTS %I ON %I (tenant_id, previous_term_id) WHERE previous_term_id IS NOT NULL', t || '_rolling_successor_uniq', t);
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I (tenant_id, membership_renewal_date) WHERE term_key IS NOT NULL', t || '_rolling_renewal_idx', t);
    IF NOT EXISTS (SELECT FROM pg_constraint WHERE conname = t || '_rolling_no_overlap') THEN
      EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I EXCLUDE USING gist
        (tenant_id WITH =, %I WITH =, daterange(term_start_date, membership_renewal_date, ''[)'') WITH &&)
        WHERE (term_key IS NOT NULL)', t, t || '_rolling_no_overlap', owner_column);
    END IF;
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION rolling_commitment_fields(p_row JSONB)
RETURNS JSONB LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT jsonb_object_agg(key, value) FROM jsonb_each(p_row)
  WHERE key IN ('term_start_date','term_end_date','membership_renewal_date','term_duration_months',
    'term_anchor_date','term_key','previous_term_id','commitment_snapshot');
$$;

CREATE OR REPLACE FUNCTION enforce_rolling_membership_commitment()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  r JSONB := to_jsonb(NEW); old_r JSONB;
  c JSONB; old_c JSONB; a JSONB; predecessor JSONB; provider_key TEXT; payment_quote JSONB;
  is_agreement BOOLEAN := TG_TABLE_NAME = 'membership_billing_agreements';
  is_member BOOLEAN; owner_id UUID; tenant UUID;
  config_uuid UUID; config_row JSONB; owner_tenant UUID;
  start_date DATE; renewal_date DATE; anchor_date DATE; target_month DATE; expected_renewal DATE;
  duration INTEGER; price_key TEXT; conflict_id UUID; history_table TEXT; owner_column TEXT;
BEGIN
  c := CASE WHEN r->>'term_key' IS NOT NULL THEN rolling_commitment_fields(r) ELSE NULL END;
  IF is_agreement THEN
    a := COALESCE(NULLIF(r#>'{metadata,commitment}', 'null'::jsonb),
      NULLIF(r#>'{metadata,card,commitment}', 'null'::jsonb), NULLIF(r#>'{metadata,dd,commitment}', 'null'::jsonb));
    IF c IS NULL THEN c := a;
    ELSIF a IS NOT NULL AND rolling_commitment_fields(a) IS DISTINCT FROM c THEN
      RAISE EXCEPTION 'Agreement commitment columns and metadata disagree';
    END IF;
    FOREACH provider_key IN ARRAY ARRAY['card','dd'] LOOP
      a := NULLIF(r#>ARRAY['metadata',provider_key,'commitment'], 'null'::jsonb);
      IF a->>'term_key' IS NOT NULL AND rolling_commitment_fields(a) IS DISTINCT FROM rolling_commitment_fields(c) THEN
        RAISE EXCEPTION 'Provider commitment metadata disagrees with canonical commitment';
      END IF;
    END LOOP;
  ELSIF r->>'billing_agreement_id' IS NOT NULL THEN
    SELECT to_jsonb(x) INTO a FROM membership_billing_agreements x WHERE id = (r->>'billing_agreement_id')::uuid;
    IF a->>'term_key' IS NOT NULL THEN
      IF c IS NULL THEN c := rolling_commitment_fields(a);
      ELSIF c IS DISTINCT FROM rolling_commitment_fields(a) THEN RAISE EXCEPTION 'History and agreement commitments disagree';
      END IF;
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    old_r := to_jsonb(OLD);
    old_c := CASE WHEN old_r->>'term_key' IS NOT NULL THEN rolling_commitment_fields(old_r) ELSE NULL END;
    IF old_c IS NOT NULL THEN
      IF c IS DISTINCT FROM old_c OR r->>'tenant_id' IS DISTINCT FROM old_r->>'tenant_id'
        OR (old_r->>'member_id' IS NOT NULL AND r->>'member_id' IS DISTINCT FROM old_r->>'member_id')
        OR (old_r->>'organization_id' IS NOT NULL AND r->>'organization_id' IS DISTINCT FROM old_r->>'organization_id') THEN
        RAISE EXCEPTION 'A purchased membership commitment is immutable';
      END IF;
      IF NOT is_agreement THEN
        FOREACH price_key IN ARRAY ARRAY['config_id','band_id','annual_cost','final_cost','currency','vat_rate_percent',
          'vat_amount','total_with_vat','billing_period','billing_agreement_id',
          'prorata_cost','free_period_discount','rollover_discount','custom_discount_total','custom_discount_details',
          'membership_payment_quote_id'] LOOP
          IF r->price_key IS DISTINCT FROM old_r->price_key THEN
            RAISE EXCEPTION 'Committed membership field % is immutable', price_key;
          END IF;
        END LOOP;
        -- The snapshot records the AGREED payment arrangement. Invoice-first
        -- rows may subsequently record their ACTUAL upfront settlement rail,
        -- without changing that arrangement, price or frequency. A settled or
        -- monthly row cannot switch payment rails through a generic update.
        IF r->>'payment_method' IS DISTINCT FROM old_r->>'payment_method' AND NOT (
          old_c#>>'{commitment_snapshot,payment_frequency}' = 'upfront'
          AND COALESCE(old_r->>'payment_method', '') IN ('', 'invoice')
          AND COALESCE(old_r->>'payment_status', 'unpaid') <> 'paid'
          AND COALESCE(r->>'payment_method', '') IN ('invoice','stripe','card','bank_transfer','cash','cheque','manual','xero','quickbooks','zero_due')
        ) THEN RAISE EXCEPTION 'Committed membership payment arrangement is immutable'; END IF;
      ELSE
        IF r#>'{metadata,commitment}' IS DISTINCT FROM old_r#>'{metadata,commitment}' THEN
          RAISE EXCEPTION 'Agreement commitment metadata is immutable';
        END IF;
        FOREACH provider_key IN ARRAY ARRAY['card','dd'] LOOP
          FOREACH price_key IN ARRAY ARRAY['annual_cost','final_cost','plan_total','vat_amount','vat_rate_percent',
            'total_with_vat','currency','monthly_amount','monthly_amount_minor','instalment_count','config_id',
            'config_snapshot','config','membership_year','membership_year_start','start_mode','accepted_at',
            'terms_version','auto_renew','invoicing_mode','activation_rule','first_collection_rule','collection_day',
            'grace_days','monthly_post_grace_collection_policy','commitment'] LOOP
            IF r#>ARRAY['metadata',provider_key,price_key] IS DISTINCT FROM old_r#>ARRAY['metadata',provider_key,price_key] THEN
              RAISE EXCEPTION 'Provider consent field %.% is immutable', provider_key, price_key;
            END IF;
          END LOOP;
        END LOOP;
      END IF;
    END IF;
  END IF;
  IF c IS NULL OR c->>'term_key' IS NULL THEN
    -- Legacy updates are left untouched, but newly-created immediate terms may
    -- not accidentally bypass persistence through an older payment entrypoint.
    IF TG_OP = 'INSERT' AND NOT is_agreement AND EXISTS (
      SELECT FROM membership_tier_config WHERE id = (r->>'config_id')::uuid AND start_mode = 'immediate'
    ) THEN RAISE EXCEPTION 'Immediate membership requires an authoritative dated commitment'; END IF;
    IF TG_OP = 'INSERT' AND is_agreement AND EXISTS (
      SELECT FROM membership_tier_config WHERE id = COALESCE(
        r#>>'{metadata,card,config_id}', r#>>'{metadata,dd,config_id}')::uuid AND start_mode = 'immediate'
    ) THEN RAISE EXCEPTION 'Immediate payment agreement requires an authoritative dated commitment'; END IF;
    RETURN NEW;
  END IF;
  c := rolling_commitment_fields(c);
  NEW := jsonb_populate_record(NEW, c);
  r := to_jsonb(NEW);
  tenant := (r->>'tenant_id')::uuid;
  is_member := CASE WHEN is_agreement THEN r->>'agreement_type' = 'member' ELSE TG_TABLE_NAME = 'member_membership_history' END;
  owner_column := CASE WHEN is_member THEN 'member_id' ELSE 'organization_id' END;
  history_table := CASE WHEN is_member THEN 'member_membership_history' ELSE 'organisation_membership_history' END;
  owner_id := (r->>owner_column)::uuid;
  config_uuid := (c#>>'{commitment_snapshot,config_id}')::uuid;
  SELECT to_jsonb(x) INTO config_row FROM membership_tier_config x WHERE id = config_uuid AND tenant_id = tenant;
  -- Live config edits must not invalidate a settled/consented purchase. Only
  -- tenant ownership is live; pricing, duration and scope use the saved copy.
  IF config_row IS NULL OR (COALESCE(c#>>'{commitment_snapshot,config,structure_scope_type}', 'organization') = 'member') IS DISTINCT FROM is_member THEN
    RAISE EXCEPTION 'Membership commitment structure does not belong to this tenant/scope';
  END IF;
  IF c#>>'{commitment_snapshot,config,id}' IS DISTINCT FROM config_uuid::text
    OR c#>>'{commitment_snapshot,config,start_mode}' IS DISTINCT FROM 'immediate'
    OR c#>>'{commitment_snapshot,start_mode}' IS DISTINCT FROM 'immediate'
    OR c#>>'{commitment_snapshot,version}' IS DISTINCT FROM '1' THEN
    RAISE EXCEPTION 'Invalid immutable membership configuration snapshot';
  END IF;
  IF owner_id IS NOT NULL THEN
    EXECUTE format('SELECT tenant_id FROM %I WHERE id = $1', CASE WHEN is_member THEN 'member' ELSE 'organization' END)
      INTO owner_tenant USING owner_id;
    IF owner_tenant IS DISTINCT FROM tenant THEN RAISE EXCEPTION 'Membership owner does not belong to this tenant'; END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('rolling:' || tenant::text || ':' || owner_column || ':' || owner_id::text, 0));
  ELSIF NOT is_agreement THEN RAISE EXCEPTION 'Membership owner is required';
  END IF;
  duration := CASE c#>>'{commitment_snapshot,billing_period}' WHEN 'annual' THEN 12 WHEN 'quarterly' THEN 3 WHEN 'monthly' THEN 1 END;
  start_date := (c->>'term_start_date')::date;
  renewal_date := (c->>'membership_renewal_date')::date;
  anchor_date := (c->>'term_anchor_date')::date;
  target_month := (date_trunc('month', start_date) + make_interval(months => duration))::date;
  expected_renewal := target_month + (LEAST(EXTRACT(day FROM anchor_date)::integer,
    EXTRACT(day FROM target_month + INTERVAL '1 month - 1 day')::integer) - 1);
  IF duration IS NULL OR (c->>'term_duration_months')::integer IS DISTINCT FROM duration
    OR renewal_date IS DISTINCT FROM expected_renewal OR start_date IS NULL OR anchor_date IS NULL
    OR c#>>'{commitment_snapshot,config,billing_period}' IS DISTINCT FROM c#>>'{commitment_snapshot,billing_period}' THEN
    RAISE EXCEPTION 'Membership dates do not match the committed billing period';
  END IF;
  FOREACH price_key IN ARRAY ARRAY['annual_cost','final_cost','vat_amount','total_with_vat'] LOOP
    IF c#>>ARRAY['commitment_snapshot','amounts',price_key] IS NULL
      OR c#>>ARRAY['commitment_snapshot','amounts',price_key] !~ '^[0-9]+([.][0-9]+)?$'
      OR (c#>>ARRAY['commitment_snapshot','amounts',price_key])::numeric < 0 THEN
      RAISE EXCEPTION 'Missing or invalid committed amount %', price_key;
    END IF;
    IF NOT is_agreement AND (r->>price_key)::numeric IS DISTINCT FROM (c#>>ARRAY['commitment_snapshot','amounts',price_key])::numeric THEN
      RAISE EXCEPTION 'History amount % differs from commitment', price_key;
    END IF;
  END LOOP;
  IF c#>>'{commitment_snapshot,amounts,currency}' IS NULL
    OR c#>>'{commitment_snapshot,amounts,currency}' !~ '^[A-Z]{3}$'
    OR COALESCE(c#>>'{commitment_snapshot,payment_method}', '') = ''
    OR COALESCE(c#>>'{commitment_snapshot,payment_frequency}', '') = ''
    OR abs((c#>>'{commitment_snapshot,amounts,final_cost}')::numeric
      + (c#>>'{commitment_snapshot,amounts,vat_amount}')::numeric
      - (c#>>'{commitment_snapshot,amounts,total_with_vat}')::numeric) > 0.01 THEN
    RAISE EXCEPTION 'Invalid committed currency, payment terms or total';
  END IF;
  IF NOT is_agreement THEN
    IF r->>'currency' IS DISTINCT FROM c#>>'{commitment_snapshot,amounts,currency}'
      OR r->>'config_id' IS DISTINCT FROM config_uuid::text THEN RAISE EXCEPTION 'History differs from commitment'; END IF;
    NEW := jsonb_populate_record(NEW, jsonb_build_object('membership_year', c->>'term_key'));
    IF r->>'membership_payment_quote_id' IS NOT NULL THEN
      SELECT to_jsonb(q) INTO payment_quote FROM membership_payment_quote q WHERE id = (r->>'membership_payment_quote_id')::uuid;
    ELSIF r->>'stripe_payment_intent_id' IS NOT NULL THEN
      -- Reconciliation can restore the linkage from the already bound PI. A
      -- caller cannot claim another pending quote just by matching its dates.
      SELECT to_jsonb(q) INTO payment_quote FROM membership_payment_quote q
        WHERE stripe_payment_intent_id = r->>'stripe_payment_intent_id' AND tenant_id = tenant;
    END IF;
    IF payment_quote IS NOT NULL THEN
      IF payment_quote->>'tenant_id' IS DISTINCT FROM tenant::text
        OR payment_quote->>owner_column IS DISTINCT FROM owner_id::text
        OR (is_member AND payment_quote->>'organization_id' IS NOT NULL)
        OR rolling_commitment_fields(COALESCE(NULLIF(payment_quote->'recovered_commitment','null'::jsonb), payment_quote#>'{quote,simResult,commitment}')) IS DISTINCT FROM c
        OR payment_quote->>'stripe_payment_intent_id' IS NULL
        OR payment_quote->>'stripe_payment_intent_id' IS DISTINCT FROM r->>'stripe_payment_intent_id' THEN
        RAISE EXCEPTION 'Upfront payment reservation does not match this committed payment';
      END IF;
      NEW := jsonb_populate_record(NEW, jsonb_build_object('membership_payment_quote_id', payment_quote->>'id'));
    ELSIF r->>'membership_payment_quote_id' IS NOT NULL THEN
      RAISE EXCEPTION 'Upfront payment reservation was not found';
    END IF;
    IF a IS NOT NULL AND (a->>'tenant_id' IS DISTINCT FROM tenant::text OR a->>owner_column IS DISTINCT FROM owner_id::text) THEN
      RAISE EXCEPTION 'Billing agreement does not belong to this membership owner';
    END IF;
    IF r->>'billing_agreement_id' IS NOT NULL AND (a IS NULL OR a->>'term_key' IS NULL) THEN
      RAISE EXCEPTION 'Rolling history requires a matching committed billing agreement';
    END IF;
    IF c->>'previous_term_id' IS NOT NULL THEN
      EXECUTE format('SELECT to_jsonb(x) FROM %I x WHERE id = $1', history_table)
        INTO predecessor USING (c->>'previous_term_id')::uuid;
      IF predecessor IS NULL OR predecessor->>'tenant_id' IS DISTINCT FROM tenant::text
        OR predecessor->>owner_column IS DISTINCT FROM owner_id::text
        OR predecessor->>'membership_renewal_date' IS DISTINCT FROM c->>'term_start_date'
        OR predecessor->>'term_anchor_date' IS DISTINCT FROM c->>'term_anchor_date' THEN
        RAISE EXCEPTION 'Previous membership term must be owned by the same entity and adjacent';
      END IF;
    END IF;
  END IF;
  IF owner_id IS NOT NULL THEN
    SELECT q.id INTO conflict_id FROM membership_payment_quote q
      WHERE q.tenant_id = tenant AND q.term_key IS NOT NULL
        AND ((is_member AND q.organization_id IS NULL AND q.member_id = owner_id)
          OR (NOT is_member AND q.organization_id = owner_id))
        AND q.id IS DISTINCT FROM (payment_quote->>'id')::uuid
        AND (q.quote#>>'{simResult,commitment,term_start_date}')::date < renewal_date
        AND (q.quote#>>'{simResult,commitment,membership_renewal_date}')::date > start_date
      LIMIT 1;
    IF conflict_id IS NOT NULL THEN RAISE EXCEPTION 'An upfront payment already reserves an overlapping membership term'; END IF;
    -- Cross-provider reservation guard. History exclusion is the additional
    -- concurrency backstop; this lock also protects not-yet-finalized consent.
    EXECUTE format('SELECT id FROM membership_billing_agreements
      WHERE tenant_id = $1 AND %I = $2 AND term_key IS NOT NULL AND id <> $3
        AND status IN (''payment_setup_required'',''mandate_pending'',''first_payment_pending'',''active'',''payment_grace_period'',''payment_overdue'')
        AND daterange(term_start_date, membership_renewal_date, ''[)'') && daterange($4, $5, ''[)'')
      LIMIT 1', owner_column)
      INTO conflict_id USING tenant, owner_id,
        CASE WHEN is_agreement THEN (r->>'id')::uuid ELSE COALESCE((r->>'billing_agreement_id')::uuid, '00000000-0000-0000-0000-000000000000'::uuid) END,
        start_date, renewal_date;
    IF conflict_id IS NOT NULL THEN RAISE EXCEPTION 'An overlapping monthly membership agreement already exists'; END IF;
    IF is_agreement THEN
      EXECUTE format('SELECT id FROM %I WHERE tenant_id = $1 AND %I = $2 AND term_key IS NOT NULL
        AND billing_agreement_id IS DISTINCT FROM $3
        AND daterange(term_start_date, membership_renewal_date, ''[)'') && daterange($4,$5,''[)'') LIMIT 1', history_table, owner_column)
        INTO conflict_id USING tenant, owner_id, (r->>'id')::uuid, start_date, renewal_date;
      IF conflict_id IS NOT NULL THEN RAISE EXCEPTION 'An overlapping membership commitment already exists'; END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['member_membership_history', 'organisation_membership_history', 'membership_billing_agreements'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS rolling_commitment_guard ON %I', t);
    EXECUTE format('CREATE TRIGGER rolling_commitment_guard BEFORE INSERT OR UPDATE ON %I
      FOR EACH ROW EXECUTE FUNCTION enforce_rolling_membership_commitment()', t);
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION enforce_rolling_payment_quote()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  c JSONB := NEW.quote#>'{simResult,commitment}';
  owner_column TEXT := CASE WHEN NEW.organization_id IS NULL THEN 'member_id' ELSE 'organization_id' END;
  owner_id UUID := COALESCE(NEW.organization_id, NEW.member_id);
  history_table TEXT := CASE WHEN NEW.organization_id IS NULL THEN 'member_membership_history' ELSE 'organisation_membership_history' END;
  conflict_id UUID;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.quote IS DISTINCT FROM OLD.quote OR NEW.term_key IS DISTINCT FROM OLD.term_key
      OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.member_id IS DISTINCT FROM OLD.member_id
      OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
      OR (to_jsonb(OLD)->>'recovered_commitment' IS NOT NULL
        AND to_jsonb(NEW)->'recovered_commitment' IS DISTINCT FROM to_jsonb(OLD)->'recovered_commitment')
      OR (OLD.stripe_payment_intent_id IS NOT NULL AND NEW.stripe_payment_intent_id IS DISTINCT FROM OLD.stripe_payment_intent_id) THEN
      RAISE EXCEPTION 'An upfront payment quote is immutable';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.term_key IS NULL THEN
    IF NEW.quote#>>'{simResult,config,start_mode}' = 'immediate' THEN
      RAISE EXCEPTION 'Immediate upfront payment requires a dated commitment';
    END IF;
    RETURN NEW;
  END IF;
  IF c->>'term_key' IS DISTINCT FROM NEW.term_key OR c->>'term_start_date' IS NULL
    OR c->>'membership_renewal_date' IS NULL OR c->>'term_end_date' IS NULL
    OR NEW.term_key IS DISTINCT FROM 'rolling:' || (c->>'term_start_date')
    OR (c->>'term_start_date')::date >= (c->>'membership_renewal_date')::date
    OR (c->>'term_end_date')::date + 1 IS DISTINCT FROM (c->>'membership_renewal_date')::date
    OR c#>>'{commitment_snapshot,start_mode}' IS DISTINCT FROM 'immediate' THEN
    RAISE EXCEPTION 'Upfront quote has an incomplete membership commitment';
  END IF;
  IF NOT EXISTS (SELECT FROM member WHERE id = NEW.member_id AND tenant_id = NEW.tenant_id)
    OR (NEW.organization_id IS NOT NULL AND NOT EXISTS (SELECT FROM organization WHERE id = NEW.organization_id AND tenant_id = NEW.tenant_id))
    OR NOT EXISTS (SELECT FROM membership_tier_config WHERE id = (c#>>'{commitment_snapshot,config_id}')::uuid AND tenant_id = NEW.tenant_id) THEN
    RAISE EXCEPTION 'Upfront quote owner/config does not belong to tenant';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('rolling:' || NEW.tenant_id::text || ':' || owner_column || ':' || owner_id::text, 0));
  EXECUTE format('SELECT id FROM %I WHERE tenant_id=$1 AND %I=$2
    AND term_start_date < $4 AND membership_renewal_date > $3 LIMIT 1', history_table, owner_column)
    INTO conflict_id USING NEW.tenant_id, owner_id, (c->>'term_start_date')::date, (c->>'membership_renewal_date')::date;
  IF conflict_id IS NOT NULL THEN RAISE EXCEPTION 'Membership term already recorded'; END IF;
  EXECUTE format('SELECT id FROM membership_billing_agreements WHERE tenant_id=$1 AND %I=$2
    AND status NOT IN (''cancelled'',''expired'',''failed'')
    AND term_start_date < $4 AND membership_renewal_date > $3 LIMIT 1', owner_column)
    INTO conflict_id USING NEW.tenant_id, owner_id, (c->>'term_start_date')::date, (c->>'membership_renewal_date')::date;
  IF conflict_id IS NOT NULL THEN RAISE EXCEPTION 'A monthly payment agreement already reserves this membership term'; END IF;
  SELECT id INTO conflict_id FROM membership_payment_quote q
    WHERE q.tenant_id = NEW.tenant_id AND q.term_key IS NOT NULL
      AND ((NEW.organization_id IS NULL AND q.organization_id IS NULL AND q.member_id = owner_id)
        OR (NEW.organization_id IS NOT NULL AND q.organization_id = owner_id))
      AND (q.quote#>>'{simResult,commitment,term_start_date}')::date < (c->>'membership_renewal_date')::date
      AND (q.quote#>>'{simResult,commitment,membership_renewal_date}')::date > (c->>'term_start_date')::date;
  IF conflict_id IS NOT NULL THEN RAISE EXCEPTION 'An upfront payment already reserves an overlapping membership term'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS rolling_payment_quote_guard ON membership_payment_quote;
CREATE TRIGGER rolling_payment_quote_guard BEFORE INSERT OR UPDATE ON membership_payment_quote
  FOR EACH ROW EXECUTE FUNCTION enforce_rolling_payment_quote();

CREATE OR REPLACE FUNCTION insert_rolling_membership_commitment(
  p_tenant_id UUID, p_member_id UUID, p_organization_id UUID, p_record JSONB
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE t TEXT; owner_column TEXT; owner_id UUID; existing JSONB; result JSONB; payload JSONB; cols TEXT; vals TEXT; field_name TEXT;
BEGIN
  IF p_tenant_id IS NULL OR (p_member_id IS NULL) = (p_organization_id IS NULL) OR p_record->>'term_key' IS NULL THEN
    RAISE EXCEPTION 'A tenant, exactly one owner and a complete rolling commitment are required';
  END IF;
  t := CASE WHEN p_member_id IS NOT NULL THEN 'member_membership_history' ELSE 'organisation_membership_history' END;
  owner_column := CASE WHEN p_member_id IS NOT NULL THEN 'member_id' ELSE 'organization_id' END;
  owner_id := COALESCE(p_member_id, p_organization_id);
  PERFORM pg_advisory_xact_lock(hashtextextended('rolling:' || p_tenant_id::text || ':' || owner_column || ':' || owner_id::text, 0));
  EXECUTE format('SELECT to_jsonb(x) FROM %I x WHERE tenant_id = $1 AND %I = $2 AND term_key = $3', t, owner_column)
    INTO existing USING p_tenant_id, owner_id, p_record->>'term_key';
  IF existing IS NOT NULL THEN
    IF rolling_commitment_fields(existing) IS DISTINCT FROM rolling_commitment_fields(p_record)
      OR (p_record->>'billing_agreement_id' IS NOT NULL AND existing->>'billing_agreement_id' IS DISTINCT FROM p_record->>'billing_agreement_id') THEN
      RAISE EXCEPTION 'A different commitment already exists for this membership term';
    END IF;
    FOREACH field_name IN ARRAY ARRAY['config_id','band_id','annual_cost','final_cost','vat_amount','total_with_vat','currency','billing_period'] LOOP
      IF p_record ? field_name AND p_record->field_name IS DISTINCT FROM existing->field_name THEN
        RAISE EXCEPTION 'Retry differs from committed membership field %', field_name;
      END IF;
    END LOOP;
    RETURN jsonb_build_object('record', existing, 'idempotent', true);
  END IF;
  payload := p_record || jsonb_build_object('tenant_id', p_tenant_id, owner_column, owner_id);
  -- Populate only supplied columns so DB defaults (id, timestamps) still apply.
  SELECT string_agg(format('%I', attname), ','), string_agg(format('x.%I', attname), ',')
    INTO cols, vals FROM pg_attribute
    WHERE attrelid = t::regclass AND attnum > 0 AND NOT attisdropped AND attgenerated = '' AND payload ? attname;
  EXECUTE format('INSERT INTO %I (%s) SELECT %s FROM jsonb_populate_record(NULL::%I, $1) x RETURNING to_jsonb(%I.*)', t, cols, vals, t, t)
    INTO result USING payload;
  RETURN jsonb_build_object('record', result, 'idempotent', false);
END $$;
REVOKE ALL ON FUNCTION insert_rolling_membership_commitment(UUID, UUID, UUID, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION insert_rolling_membership_commitment(UUID, UUID, UUID, JSONB) TO service_role;
COMMIT;