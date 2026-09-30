-- Task #3877: server-only, tenant-scoped commercial catalogue.
CREATE TABLE public.sales_catalogue_category (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenant(id) ON DELETE CASCADE,
  code varchar(64) NOT NULL, name varchar(255) NOT NULL, description text,
  display_order integer NOT NULL DEFAULT 0, is_active boolean NOT NULL DEFAULT true,
  archived_at timestamptz, archived_by text, created_by text, updated_by text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sales_catalogue_category_tenant_id_unique UNIQUE (tenant_id,id),
  CONSTRAINT sales_catalogue_category_code_unique UNIQUE (tenant_id,code),
  CONSTRAINT sales_catalogue_category_code_check CHECK (code ~ '^[A-Z0-9][A-Z0-9_-]{0,63}$'),
  CONSTRAINT sales_catalogue_category_name_check CHECK (length(btrim(name)) BETWEEN 1 AND 255),
  CONSTRAINT sales_catalogue_category_order_check CHECK (display_order >= 0),
  CONSTRAINT sales_catalogue_category_archive_check CHECK ((is_active AND archived_at IS NULL) OR (NOT is_active AND archived_at IS NOT NULL))
);

CREATE TABLE public.sales_catalogue_product (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenant(id) ON DELETE CASCADE,
  category_id uuid, code varchar(64) NOT NULL, sku varchar(100), name varchar(255) NOT NULL,
  short_description varchar(500), description text, currency varchar(3) NOT NULL, standard_price_minor bigint NOT NULL,
  minimum_price_minor bigint, cost_minor bigint, tax_treatment varchar(30) NOT NULL,
  tax_rate_bps integer NOT NULL DEFAULT 0, available_from timestamptz, available_to timestamptz,
  capacity_metadata jsonb NOT NULL DEFAULT '{}'::jsonb, display_order integer NOT NULL DEFAULT 0,
  event_reference_kind varchar(20), event_id uuid, ticket_type_id text,
  is_active boolean NOT NULL DEFAULT true, archived_at timestamptz, archived_by text,
  created_by text, updated_by text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sales_catalogue_product_tenant_id_unique UNIQUE (tenant_id,id),
  CONSTRAINT sales_catalogue_product_code_unique UNIQUE (tenant_id,code),
  CONSTRAINT sales_catalogue_product_sku_unique UNIQUE (tenant_id,sku),
  CONSTRAINT sales_catalogue_product_category_fk FOREIGN KEY (tenant_id,category_id) REFERENCES public.sales_catalogue_category(tenant_id,id) ON DELETE RESTRICT,
  CONSTRAINT sales_catalogue_product_code_check CHECK (code ~ '^[A-Z0-9][A-Z0-9_-]{0,63}$'),
  CONSTRAINT sales_catalogue_product_currency_check CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT sales_catalogue_product_money_check CHECK (standard_price_minor >= 0 AND (minimum_price_minor IS NULL OR minimum_price_minor BETWEEN 0 AND standard_price_minor) AND (cost_minor IS NULL OR cost_minor >= 0)),
  CONSTRAINT sales_catalogue_product_tax_check CHECK (tax_treatment IN ('standard','zero_rated','exempt','outside_scope') AND tax_rate_bps BETWEEN 0 AND 100000),
  CONSTRAINT sales_catalogue_product_dates_check CHECK (available_to IS NULL OR available_from IS NULL OR available_to >= available_from),
  CONSTRAINT sales_catalogue_product_capacity_check CHECK (jsonb_typeof(capacity_metadata)='object'),
  CONSTRAINT sales_catalogue_product_order_check CHECK (display_order >= 0),
  CONSTRAINT sales_catalogue_product_event_check CHECK ((event_reference_kind IS NULL AND event_id IS NULL AND ticket_type_id IS NULL) OR (event_reference_kind IN ('simple','complex') AND event_id IS NOT NULL AND length(ticket_type_id)>0)),
  CONSTRAINT sales_catalogue_product_archive_check CHECK ((is_active AND archived_at IS NULL) OR (NOT is_active AND archived_at IS NOT NULL))
);

CREATE TABLE public.sales_catalogue_bundle (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES public.tenant(id) ON DELETE CASCADE,
  code varchar(64) NOT NULL, name varchar(255) NOT NULL, description text, currency varchar(3) NOT NULL,
  selling_price_minor bigint NOT NULL, minimum_price_minor bigint, presentation_mode varchar(20) NOT NULL DEFAULT 'bundle',
  available_from timestamptz, available_to timestamptz, display_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true, archived_at timestamptz, archived_by text, created_by text, updated_by text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sales_catalogue_bundle_tenant_id_unique UNIQUE (tenant_id,id),
  CONSTRAINT sales_catalogue_bundle_code_unique UNIQUE (tenant_id,code),
  CONSTRAINT sales_catalogue_bundle_code_check CHECK (code ~ '^[A-Z0-9][A-Z0-9_-]{0,63}$'),
  CONSTRAINT sales_catalogue_bundle_currency_check CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT sales_catalogue_bundle_money_check CHECK (selling_price_minor >= 0 AND (minimum_price_minor IS NULL OR minimum_price_minor BETWEEN 0 AND selling_price_minor)),
  CONSTRAINT sales_catalogue_bundle_mode_check CHECK (presentation_mode IN ('bundle','itemised')),
  CONSTRAINT sales_catalogue_bundle_dates_check CHECK (available_to IS NULL OR available_from IS NULL OR available_to >= available_from),
  CONSTRAINT sales_catalogue_bundle_order_check CHECK (display_order >= 0),
  CONSTRAINT sales_catalogue_bundle_archive_check CHECK ((is_active AND archived_at IS NULL) OR (NOT is_active AND archived_at IS NOT NULL))
);

CREATE TABLE public.sales_catalogue_bundle_item (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES public.tenant(id) ON DELETE CASCADE,
  bundle_id uuid NOT NULL, product_id uuid NOT NULL, quantity integer NOT NULL, display_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sales_catalogue_bundle_item_unique UNIQUE (tenant_id,bundle_id,product_id),
  CONSTRAINT sales_catalogue_bundle_item_bundle_fk FOREIGN KEY (tenant_id,bundle_id) REFERENCES public.sales_catalogue_bundle(tenant_id,id) ON DELETE CASCADE,
  CONSTRAINT sales_catalogue_bundle_item_product_fk FOREIGN KEY (tenant_id,product_id) REFERENCES public.sales_catalogue_product(tenant_id,id) ON DELETE RESTRICT,
  CONSTRAINT sales_catalogue_bundle_item_quantity_check CHECK (quantity BETWEEN 1 AND 100000),
  CONSTRAINT sales_catalogue_bundle_item_order_check CHECK (display_order >= 0)
);

CREATE INDEX idx_sales_catalogue_category_list ON public.sales_catalogue_category(tenant_id,is_active,display_order);
CREATE INDEX idx_sales_catalogue_product_list ON public.sales_catalogue_product(tenant_id,is_active,name);
CREATE INDEX idx_sales_catalogue_product_category ON public.sales_catalogue_product(tenant_id,category_id);
CREATE INDEX idx_sales_catalogue_bundle_list ON public.sales_catalogue_bundle(tenant_id,is_active,display_order);
CREATE INDEX idx_sales_catalogue_bundle_item_bundle ON public.sales_catalogue_bundle_item(tenant_id,bundle_id,display_order);

CREATE OR REPLACE FUNCTION public.replace_sales_catalogue_bundle_items(
  p_tenant_id uuid,
  p_bundle_id uuid,
  p_items jsonb
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF auth.role() <> 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  IF jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'bundle items must be a non-empty array' USING ERRCODE = '22023';
  END IF;
  PERFORM 1
  FROM public.sales_catalogue_bundle
  WHERE tenant_id = p_tenant_id AND id = p_bundle_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'catalogue bundle not found' USING ERRCODE = 'P0002';
  END IF;

  DELETE FROM public.sales_catalogue_bundle_item
  WHERE tenant_id = p_tenant_id AND bundle_id = p_bundle_id;

  INSERT INTO public.sales_catalogue_bundle_item (
    tenant_id, bundle_id, product_id, quantity, display_order
  )
  SELECT
    p_tenant_id,
    p_bundle_id,
    (item.value->>'productId')::uuid,
    (item.value->>'quantity')::integer,
    item.ordinality - 1
  FROM jsonb_array_elements(p_items) WITH ORDINALITY AS item(value, ordinality);
END;
$$;

ALTER TABLE public.sales_catalogue_category ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sales_catalogue_product ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sales_catalogue_bundle ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sales_catalogue_bundle_item ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.sales_catalogue_category, public.sales_catalogue_product, public.sales_catalogue_bundle, public.sales_catalogue_bundle_item FROM PUBLIC, anon, authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.sales_catalogue_category, public.sales_catalogue_product, public.sales_catalogue_bundle, public.sales_catalogue_bundle_item TO service_role;
GRANT INSERT ON public.sales_audit_event TO service_role;
REVOKE ALL ON FUNCTION public.replace_sales_catalogue_bundle_items(uuid,uuid,jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.replace_sales_catalogue_bundle_items(uuid,uuid,jsonb) TO service_role;
CREATE POLICY sales_catalogue_category_service ON public.sales_catalogue_category FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY sales_catalogue_product_service ON public.sales_catalogue_product FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY sales_catalogue_bundle_service ON public.sales_catalogue_bundle FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY sales_catalogue_bundle_item_service ON public.sales_catalogue_bundle_item FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY sales_catalogue_audit_service_insert ON public.sales_audit_event FOR INSERT TO service_role WITH CHECK (true);

COMMENT ON TABLE public.sales_catalogue_product IS 'Tenant catalogue products; event references are validated by the server and prices are integer minor units.';
COMMENT ON TABLE public.sales_catalogue_bundle IS 'Reusable product composition with an independent selling price.';