-- Task #3876: tenant-scoped Sales settings, atomic identifiers, and immutable
-- server-authored audit. Browser roles have no direct table/function access.

CREATE TABLE public.sales_settings (
  tenant_id uuid PRIMARY KEY REFERENCES public.tenant(id) ON DELETE CASCADE,
  quote_prefix varchar(16) NOT NULL DEFAULT 'Q',
  quote_number_padding integer NOT NULL DEFAULT 6,
  default_currency varchar(3) NOT NULL DEFAULT 'GBP',
  default_tax_rate_bps integer NOT NULL DEFAULT 0,
  default_terms text NOT NULL DEFAULT '',
  module_enabled boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1,
  updated_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sales_settings_quote_prefix_check
    CHECK (quote_prefix ~ '^[A-Z0-9][A-Z0-9-]{0,15}$'),
  CONSTRAINT sales_settings_quote_padding_check
    CHECK (quote_number_padding BETWEEN 1 AND 12),
  CONSTRAINT sales_settings_currency_check
    CHECK (default_currency ~ '^[A-Z]{3}$'),
  CONSTRAINT sales_settings_tax_bps_check
    CHECK (default_tax_rate_bps BETWEEN 0 AND 100000),
  CONSTRAINT sales_settings_terms_length_check
    CHECK (length(default_terms) <= 20000),
  CONSTRAINT sales_settings_version_check CHECK (version > 0)
);

CREATE TABLE public.sales_number_sequence (
  tenant_id uuid NOT NULL REFERENCES public.tenant(id) ON DELETE CASCADE,
  kind varchar(30) NOT NULL,
  last_value bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sales_number_sequence_tenant_kind_unique UNIQUE (tenant_id, kind),
  CONSTRAINT sales_number_sequence_kind_check CHECK (kind IN ('quote')),
  CONSTRAINT sales_number_sequence_value_check CHECK (last_value >= 0)
);

CREATE TABLE public.sales_audit_event (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenant(id) ON DELETE CASCADE,
  actor_id text NOT NULL,
  actor_type varchar(30) NOT NULL,
  action varchar(100) NOT NULL,
  entity_type varchar(100) NOT NULL,
  entity_id text NOT NULL,
  before_data jsonb,
  after_data jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sales_audit_actor_type_check
    CHECK (actor_type IN ('tenant_user', 'member', 'system')),
  CONSTRAINT sales_audit_before_object_check
    CHECK (before_data IS NULL OR jsonb_typeof(before_data) = 'object'),
  CONSTRAINT sales_audit_after_object_check
    CHECK (after_data IS NULL OR jsonb_typeof(after_data) = 'object'),
  CONSTRAINT sales_audit_metadata_object_check
    CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE INDEX idx_sales_audit_event_tenant_created
  ON public.sales_audit_event (tenant_id, created_at DESC);
CREATE INDEX idx_sales_audit_event_tenant_entity
  ON public.sales_audit_event (tenant_id, entity_type, entity_id, created_at DESC);

CREATE OR REPLACE FUNCTION public.guard_sales_audit_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  RAISE EXCEPTION 'Sales audit events are immutable'
    USING ERRCODE = '23514', CONSTRAINT = 'sales_audit_event_immutable';
END;
$$;

CREATE TRIGGER sales_audit_event_immutable_trigger
  BEFORE UPDATE OR DELETE ON public.sales_audit_event
  FOR EACH ROW EXECUTE FUNCTION public.guard_sales_audit_immutable();

-- Optimistic versioning prevents lost settings updates. Actor and tenant are
-- supplied only by the authenticated server API, never accepted from payload.
CREATE OR REPLACE FUNCTION public.patch_sales_settings(
  p_tenant_id uuid,
  p_expected_version integer,
  p_patch jsonb,
  p_actor_id text,
  p_actor_type text
)
RETURNS SETOF public.sales_settings
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  old_row public.sales_settings%ROWTYPE;
  new_row public.sales_settings%ROWTYPE;
BEGIN
  IF p_tenant_id IS NULL OR p_actor_id IS NULL OR p_actor_id = ''
     OR p_actor_type NOT IN ('tenant_user', 'member', 'system') THEN
    RAISE EXCEPTION 'Valid tenant and server-authored actor are required'
      USING ERRCODE = '22023';
  END IF;
  IF p_expected_version IS NULL OR p_expected_version < 1
     OR p_patch IS NULL OR jsonb_typeof(p_patch) <> 'object' THEN
    RAISE EXCEPTION 'Valid expected version and settings patch are required'
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.sales_settings (tenant_id)
  VALUES (p_tenant_id)
  ON CONFLICT (tenant_id) DO NOTHING;

  SELECT * INTO old_row FROM public.sales_settings
    WHERE tenant_id = p_tenant_id FOR UPDATE;
  IF old_row.version <> p_expected_version THEN
    RAISE EXCEPTION 'Sales settings version conflict'
      USING ERRCODE = '40001';
  END IF;

  UPDATE public.sales_settings
  SET quote_prefix = CASE WHEN p_patch ? 'quotePrefix'
        THEN p_patch->>'quotePrefix' ELSE quote_prefix END,
      quote_number_padding = CASE WHEN p_patch ? 'quoteNumberPadding'
        THEN (p_patch->>'quoteNumberPadding')::integer ELSE quote_number_padding END,
      default_currency = CASE WHEN p_patch ? 'defaultCurrency'
        THEN p_patch->>'defaultCurrency' ELSE default_currency END,
      default_tax_rate_bps = CASE WHEN p_patch ? 'defaultTaxRateBps'
        THEN (p_patch->>'defaultTaxRateBps')::integer ELSE default_tax_rate_bps END,
      default_terms = CASE WHEN p_patch ? 'defaultTerms'
        THEN p_patch->>'defaultTerms' ELSE default_terms END,
      module_enabled = CASE WHEN p_patch ? 'moduleEnabled'
        THEN (p_patch->>'moduleEnabled')::boolean ELSE module_enabled END,
      version = version + 1,
      updated_by = p_actor_id,
      updated_at = now()
  WHERE tenant_id = p_tenant_id
  RETURNING * INTO new_row;

  INSERT INTO public.sales_audit_event (
    tenant_id, actor_id, actor_type, action, entity_type, entity_id,
    before_data, after_data
  ) VALUES (
    p_tenant_id, p_actor_id, p_actor_type, 'settings.updated',
    'sales_settings', p_tenant_id::text, to_jsonb(old_row), to_jsonb(new_row)
  );
  RETURN NEXT new_row;
END;
$$;

-- One INSERT .. ON CONFLICT statement obtains PostgreSQL's row lock and
-- increments once per caller, so concurrent allocations cannot duplicate.
CREATE OR REPLACE FUNCTION public.allocate_sales_identifier(
  p_tenant_id uuid,
  p_kind text,
  p_actor_id text,
  p_actor_type text
)
RETURNS TABLE(identifier text, sequence_value bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  settings_row public.sales_settings%ROWTYPE;
BEGIN
  IF p_tenant_id IS NULL OR p_actor_id IS NULL OR p_actor_id = ''
     OR p_actor_type NOT IN ('tenant_user', 'member', 'system') THEN
    RAISE EXCEPTION 'Valid tenant and server-authored actor are required'
      USING ERRCODE = '22023';
  END IF;
  IF p_kind <> 'quote' THEN
    RAISE EXCEPTION 'Unsupported Sales sequence kind' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.sales_settings (tenant_id) VALUES (p_tenant_id)
    ON CONFLICT (tenant_id) DO NOTHING;
  SELECT * INTO settings_row FROM public.sales_settings
    WHERE tenant_id = p_tenant_id;

  INSERT INTO public.sales_number_sequence (tenant_id, kind, last_value)
    VALUES (p_tenant_id, p_kind, 1)
  ON CONFLICT (tenant_id, kind) DO UPDATE
    SET last_value = public.sales_number_sequence.last_value + 1,
        updated_at = now()
  RETURNING last_value INTO sequence_value;

  identifier := settings_row.quote_prefix
    || lpad(sequence_value::text, settings_row.quote_number_padding, '0');
  INSERT INTO public.sales_audit_event (
    tenant_id, actor_id, actor_type, action, entity_type, entity_id, metadata
  ) VALUES (
    p_tenant_id, p_actor_id, p_actor_type, 'identifier.allocated',
    'sales_number_sequence', identifier,
    jsonb_build_object('kind', p_kind, 'sequenceValue', sequence_value)
  );
  RETURN NEXT;
END;
$$;

ALTER TABLE public.sales_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sales_number_sequence ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sales_audit_event ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.sales_settings FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.sales_number_sequence FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.sales_audit_event FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.patch_sales_settings(uuid, integer, jsonb, text, text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.allocate_sales_identifier(uuid, text, text, text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.guard_sales_audit_immutable()
  FROM PUBLIC, anon, authenticated;

GRANT SELECT ON TABLE public.sales_settings TO service_role;
GRANT SELECT ON TABLE public.sales_number_sequence TO service_role;
GRANT SELECT ON TABLE public.sales_audit_event TO service_role;
GRANT EXECUTE ON FUNCTION public.patch_sales_settings(uuid, integer, jsonb, text, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.allocate_sales_identifier(uuid, text, text, text)
  TO service_role;

CREATE POLICY sales_settings_service_select ON public.sales_settings
  FOR SELECT TO service_role USING (true);
CREATE POLICY sales_number_sequence_service_select ON public.sales_number_sequence
  FOR SELECT TO service_role USING (true);
CREATE POLICY sales_audit_event_service_select ON public.sales_audit_event
  FOR SELECT TO service_role USING (true);

COMMENT ON TABLE public.sales_settings IS
  'Tenant Sales defaults. Mutations use optimistic versioned server RPC only.';
COMMENT ON TABLE public.sales_number_sequence IS
  'Tenant and document-kind scoped monotonically increasing identifier state.';
COMMENT ON TABLE public.sales_audit_event IS
  'Append-only, immutable, server-authored Sales audit events.';

-- Role access uses exclusions, so all existing portal roles must fail closed
-- until an administrator explicitly grants the new Sales module.
UPDATE public.role
SET excluded_features = ARRAY(
  SELECT DISTINCT feature
  FROM unnest(
    COALESCE(excluded_features, ARRAY[]::text[])
    || ARRAY['sales']::text[]
  ) AS feature
)
WHERE NOT COALESCE(excluded_features, ARRAY[]::text[]) @> ARRAY['sales']::text[];