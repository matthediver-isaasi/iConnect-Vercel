-- Task #3883: immutable commercial-sale to provider invoice links.
CREATE TABLE public.sales_accounting_customer_mapping (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenant(id) ON DELETE CASCADE,
  organisation_id uuid NOT NULL,
  provider text NOT NULL,
  provider_customer_id text,
  provider_customer_name text,
  match_kind text NOT NULL,
  claim_token uuid,
  confirmed_by text,
  confirmed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,organisation_id,provider),
  UNIQUE(tenant_id,provider,provider_customer_id),
  CHECK(provider IN ('xero','quickbooks')),
  CHECK(match_kind IN ('creating','created','exact','confirmed')),
  CHECK((match_kind='creating' AND provider_customer_id IS NULL AND confirmed_at IS NULL AND claim_token IS NOT NULL)
    OR (match_kind IN ('created','exact') AND provider_customer_id IS NOT NULL AND confirmed_at IS NULL AND claim_token IS NULL)
    OR (match_kind='confirmed' AND provider_customer_id IS NOT NULL AND confirmed_at IS NOT NULL AND claim_token IS NULL))
);
CREATE OR REPLACE FUNCTION public.guard_sales_accounting_mapping_tenant()
RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.organization o WHERE o.id=NEW.organisation_id AND o.tenant_id=NEW.tenant_id)
  THEN RAISE EXCEPTION 'Organisation does not belong to accounting mapping tenant' USING ERRCODE='23503';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER sales_accounting_mapping_tenant BEFORE INSERT OR UPDATE
  ON public.sales_accounting_customer_mapping FOR EACH ROW
  EXECUTE FUNCTION public.guard_sales_accounting_mapping_tenant();

CREATE OR REPLACE FUNCTION public.claim_sales_accounting_customer_mapping(
  p_tenant_id uuid,p_organisation_id uuid,p_provider text,p_actor_id text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE m public.sales_accounting_customer_mapping%ROWTYPE;
DECLARE token uuid := gen_random_uuid();
BEGIN
  IF auth.role()<>'service_role' THEN RAISE EXCEPTION 'service role required' USING ERRCODE='42501'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant_id::text||':'||p_organisation_id::text||':'||p_provider,0));
  SELECT * INTO m FROM public.sales_accounting_customer_mapping WHERE tenant_id=p_tenant_id
    AND organisation_id=p_organisation_id AND provider=p_provider FOR UPDATE;
  IF FOUND AND m.provider_customer_id IS NOT NULL THEN RETURN jsonb_build_object('state','mapped','mappingId',m.id,'customerId',m.provider_customer_id); END IF;
  IF FOUND AND m.created_at > now()-interval '10 minutes' THEN RETURN jsonb_build_object('state','in_progress','mappingId',m.id); END IF;
  IF NOT FOUND THEN
    INSERT INTO public.sales_accounting_customer_mapping(tenant_id,organisation_id,provider,match_kind,claim_token)
      VALUES(p_tenant_id,p_organisation_id,p_provider,'creating',token) RETURNING * INTO m;
  ELSE
    UPDATE public.sales_accounting_customer_mapping SET created_at=now(),updated_at=now(),match_kind='creating',claim_token=token
      WHERE id=m.id RETURNING * INTO m;
  END IF;
  RETURN jsonb_build_object('state','claimed','mappingId',m.id,'claimToken',m.claim_token);
END $$;

CREATE OR REPLACE FUNCTION public.release_sales_accounting_customer_mapping_claim(
  p_tenant_id uuid,p_mapping_id uuid,p_claim_token uuid
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE affected integer;
BEGIN
  IF auth.role()<>'service_role' THEN RAISE EXCEPTION 'service role required' USING ERRCODE='42501'; END IF;
  DELETE FROM public.sales_accounting_customer_mapping WHERE tenant_id=p_tenant_id AND id=p_mapping_id
    AND match_kind='creating' AND provider_customer_id IS NULL AND claim_token=p_claim_token;
  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected=1;
END $$;

CREATE TABLE public.sales_accounting_invoice_link (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenant(id) ON DELETE CASCADE,
  sale_id uuid NOT NULL,
  quote_version_id uuid NOT NULL,
  provider text NOT NULL,
  provider_invoice_id text NOT NULL,
  provider_invoice_number text,
  provider_invoice_url text,
  provider_status text NOT NULL DEFAULT 'unknown',
  provider_status_raw text,
  provider_created_at timestamptz,
  status_refreshed_at timestamptz,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,sale_id,provider),
  UNIQUE(tenant_id,provider,provider_invoice_id),
  FOREIGN KEY(tenant_id,sale_id) REFERENCES public.sales_commercial_sale(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(tenant_id,quote_version_id) REFERENCES public.sales_quote_version(tenant_id,id) ON DELETE RESTRICT,
  CHECK(provider IN ('xero','quickbooks')),
  CHECK(provider_status IN ('draft','authorised','open','paid','voided','deleted','unknown'))
);

CREATE TABLE public.sales_accounting_invoice_attempt (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenant(id) ON DELETE CASCADE,
  sale_id uuid NOT NULL,
  provider text NOT NULL,
  provider_idempotency_key text NOT NULL,
  actor_id text NOT NULL,
  state text NOT NULL DEFAULT 'started',
  error_code text,
  error_message text,
  link_id uuid REFERENCES public.sales_accounting_invoice_link(id) ON DELETE SET NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  FOREIGN KEY(tenant_id,sale_id) REFERENCES public.sales_commercial_sale(tenant_id,id) ON DELETE RESTRICT,
  CHECK(provider IN ('xero','quickbooks')),
  CHECK(state IN ('started','succeeded','failed'))
);
CREATE INDEX sales_accounting_attempt_lookup
  ON public.sales_accounting_invoice_attempt(tenant_id,sale_id,provider,started_at DESC);

CREATE TABLE public.sales_accounting_tax_mapping (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenant(id) ON DELETE CASCADE,
  provider text NOT NULL,
  tax_treatment text NOT NULL,
  tax_rate_bps integer NOT NULL,
  provider_tax_code text NOT NULL,
  provider_tax_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,provider,tax_treatment,tax_rate_bps),
  CHECK(provider IN ('xero','quickbooks')),
  CHECK(tax_rate_bps BETWEEN 0 AND 100000)
);

ALTER TABLE public.sales_accounting_customer_mapping ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sales_accounting_invoice_link ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sales_accounting_invoice_attempt ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sales_accounting_tax_mapping ENABLE ROW LEVEL SECURITY;
CREATE POLICY sales_accounting_mapping_service ON public.sales_accounting_customer_mapping TO service_role USING(true) WITH CHECK(true);
CREATE POLICY sales_accounting_link_service ON public.sales_accounting_invoice_link TO service_role USING(true) WITH CHECK(true);
CREATE POLICY sales_accounting_attempt_service ON public.sales_accounting_invoice_attempt TO service_role USING(true) WITH CHECK(true);
CREATE POLICY sales_accounting_tax_service ON public.sales_accounting_tax_mapping TO service_role USING(true) WITH CHECK(true);
GRANT ALL ON public.sales_accounting_customer_mapping,public.sales_accounting_invoice_link,
  public.sales_accounting_invoice_attempt,public.sales_accounting_tax_mapping TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_sales_accounting_customer_mapping(uuid,uuid,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_sales_accounting_customer_mapping_claim(uuid,uuid,uuid) TO service_role;

-- There is one durable command per sale/provider. The advisory transaction
-- lock makes the read/create/retry decision atomic without holding a database
-- transaction open across the provider HTTP call. A stale started command is
-- reclaimed with the same provider idempotency key; it never spawns a new key.
CREATE OR REPLACE FUNCTION public.claim_sales_accounting_invoice_attempt(
  p_tenant_id uuid, p_sale_id uuid, p_provider text, p_actor_id text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE a public.sales_accounting_invoice_attempt%ROWTYPE;
DECLARE l public.sales_accounting_invoice_link%ROWTYPE;
-- si_ + 47 hexadecimal SHA-256 characters = exactly 50 provider-safe
-- characters. Both full UUIDs and provider participate before truncation.
DECLARE k text := 'si_'||substr(encode(extensions.digest(
  p_tenant_id::text||':'||p_sale_id::text||':'||p_provider,'sha256'
),'hex'),1,47);
BEGIN
  IF auth.role()<>'service_role' THEN RAISE EXCEPTION 'service role required' USING ERRCODE='42501'; END IF;
  IF p_provider NOT IN ('xero','quickbooks') OR p_actor_id IS NULL THEN RAISE EXCEPTION 'invalid invoice claim' USING ERRCODE='22023'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant_id::text||':'||p_sale_id::text||':'||p_provider,0));
  SELECT * INTO l FROM public.sales_accounting_invoice_link
    WHERE tenant_id=p_tenant_id AND sale_id=p_sale_id AND provider=p_provider;
  IF FOUND THEN RETURN jsonb_build_object('state','linked','linkId',l.id,'providerIdempotencyKey',k); END IF;
  SELECT * INTO a FROM public.sales_accounting_invoice_attempt
    WHERE tenant_id=p_tenant_id AND sale_id=p_sale_id AND provider=p_provider
    ORDER BY started_at DESC LIMIT 1 FOR UPDATE;
  IF FOUND AND a.state='started' AND a.started_at > now()-interval '10 minutes' THEN
    RETURN jsonb_build_object('state','in_progress','attemptId',a.id,'providerIdempotencyKey',a.provider_idempotency_key);
  END IF;
  IF FOUND THEN
    UPDATE public.sales_accounting_invoice_attempt SET state='started',error_code=NULL,error_message=NULL,
      completed_at=NULL,started_at=now() WHERE id=a.id RETURNING * INTO a;
  ELSE
    INSERT INTO public.sales_accounting_invoice_attempt(tenant_id,sale_id,provider,provider_idempotency_key,actor_id)
      VALUES(p_tenant_id,p_sale_id,p_provider,k,p_actor_id) RETURNING * INTO a;
  END IF;
  RETURN jsonb_build_object('state','claimed','attemptId',a.id,'providerIdempotencyKey',a.provider_idempotency_key);
END $$;
GRANT EXECUTE ON FUNCTION public.claim_sales_accounting_invoice_attempt(uuid,uuid,text,text) TO service_role;

-- Invoice linkage identifies an immutable commercial source. Status display
-- fields may be refreshed, but no update can repoint an external invoice.
CREATE OR REPLACE FUNCTION public.guard_sales_accounting_invoice_link()
RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$
DECLARE source_version uuid;
BEGIN
  IF TG_OP='INSERT' THEN
    SELECT quote_version_id INTO source_version FROM public.sales_commercial_sale
      WHERE tenant_id=NEW.tenant_id AND id=NEW.sale_id;
    IF source_version IS NULL OR source_version<>NEW.quote_version_id THEN
      RAISE EXCEPTION 'Invoice link quote version must equal sale quote version' USING ERRCODE='23503';
    END IF;
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW)-ARRAY['provider_invoice_number','provider_invoice_url','provider_status',
      'provider_status_raw','status_refreshed_at','updated_at'])
     <> (to_jsonb(OLD)-ARRAY['provider_invoice_number','provider_invoice_url','provider_status',
      'provider_status_raw','status_refreshed_at','updated_at']) THEN
    RAISE EXCEPTION 'Accounting invoice linkage source fields are immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER sales_accounting_invoice_link_guard BEFORE INSERT OR UPDATE
  ON public.sales_accounting_invoice_link FOR EACH ROW EXECUTE FUNCTION public.guard_sales_accounting_invoice_link();

CREATE OR REPLACE FUNCTION public.save_sales_accounting_configuration(
  p_tenant_id uuid,p_provider text,p_mappings jsonb,p_quickbooks_sales_item_id text
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE mapping jsonb;
BEGIN
  IF auth.role()<>'service_role' THEN RAISE EXCEPTION 'service role required' USING ERRCODE='42501'; END IF;
  IF p_provider NOT IN ('xero','quickbooks') OR jsonb_typeof(p_mappings)<>'array'
     OR jsonb_array_length(p_mappings)=0 THEN
    RAISE EXCEPTION 'invalid accounting configuration' USING ERRCODE='22023';
  END IF;
  IF p_provider='quickbooks' AND nullif(btrim(p_quickbooks_sales_item_id),'') IS NULL THEN
    RAISE EXCEPTION 'QuickBooks sales item is required' USING ERRCODE='22023';
  END IF;
  DELETE FROM public.sales_accounting_tax_mapping WHERE tenant_id=p_tenant_id AND provider=p_provider;
  FOR mapping IN SELECT value FROM jsonb_array_elements(p_mappings) LOOP
    INSERT INTO public.sales_accounting_tax_mapping(
      tenant_id,provider,tax_treatment,tax_rate_bps,provider_tax_code,provider_tax_name
    ) VALUES (
      p_tenant_id,p_provider,'standard',(mapping->>'taxRateBps')::integer,
      mapping->>'providerTaxCodeId',mapping->>'providerTaxCodeName'
    );
  END LOOP;
  IF p_provider='quickbooks' THEN
    INSERT INTO public.system_settings(tenant_id,setting_key,setting_value)
      VALUES(p_tenant_id,'quickbooks_sales_item_id',p_quickbooks_sales_item_id)
    ON CONFLICT(tenant_id,setting_key) DO UPDATE SET setting_value=EXCLUDED.setting_value;
  END IF;
END $$;
GRANT EXECUTE ON FUNCTION public.save_sales_accounting_configuration(uuid,text,jsonb,text) TO service_role;