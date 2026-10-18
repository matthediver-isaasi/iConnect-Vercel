-- Task #5151. Apply after catalogue, direct-tax, and acceptance-task columns.
-- Service-only creation: parent, ordered components, and audit commit together.
CREATE OR REPLACE FUNCTION public.create_sales_catalogue_record(
  p_tenant_id uuid, p_type text, p_record jsonb, p_items jsonb,
  p_actor_id text, p_actor_type text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_product public.sales_catalogue_product%ROWTYPE;
  v_bundle public.sales_catalogue_bundle%ROWTYPE;
  v_after jsonb;
  v_id uuid;
  v_pricing jsonb;
  v_count integer;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  IF p_tenant_id IS NULL OR p_actor_id IS NULL OR btrim(p_actor_id) = ''
    OR p_actor_type IS NULL OR p_actor_type NOT IN ('tenant_user','member','system')
    OR p_type IS NULL OR p_type NOT IN ('products','bundles')
    OR p_record IS NULL OR jsonb_typeof(p_record) <> 'object' THEN
    RAISE EXCEPTION 'Invalid catalogue create request' USING ERRCODE = '22023';
  END IF;

  IF p_type = 'products' THEN
    v_product := jsonb_populate_record(NULL::public.sales_catalogue_product, p_record);
    IF v_product.category_id IS NOT NULL THEN
      PERFORM 1 FROM public.sales_catalogue_category
        WHERE tenant_id = p_tenant_id AND id = v_product.category_id AND is_active
        FOR SHARE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Select an active category belonging to this tenant' USING ERRCODE = '22023';
      END IF;
    END IF;
    IF v_product.event_reference_kind = 'simple' THEN
      SELECT pricing_config INTO v_pricing FROM public.event
        WHERE tenant_id = p_tenant_id AND id = v_product.event_id FOR SHARE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Event reference does not belong to this tenant' USING ERRCODE = '22023';
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(
          CASE WHEN jsonb_typeof(v_pricing->'ticket_classes') = 'array'
            THEN v_pricing->'ticket_classes' ELSE '[]'::jsonb END
        ) ticket WHERE ticket->>'id' = v_product.ticket_type_id
      ) THEN
        RAISE EXCEPTION 'Ticket type does not belong to the referenced event' USING ERRCODE = '22023';
      END IF;
    ELSIF v_product.event_reference_kind = 'complex' THEN
      PERFORM 1 FROM public.complex_event
        WHERE tenant_id = p_tenant_id AND id = v_product.event_id FOR SHARE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Complex event reference does not belong to this tenant' USING ERRCODE = '22023';
      END IF;
      PERFORM 1 FROM public.complex_event_ticket_class
        WHERE tenant_id = p_tenant_id AND complex_event_id = v_product.event_id
          AND id::text = v_product.ticket_type_id FOR SHARE;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Ticket class does not belong to the referenced complex event' USING ERRCODE = '22023';
      END IF;
    END IF;

    -- Explicit columns prevent copied IDs, archive flags, and audit metadata
    -- from overriding normal new-record defaults, even at the RPC boundary.
    INSERT INTO public.sales_catalogue_product (
      tenant_id, category_id, code, sku, name, short_description, description,
      currency, standard_price_minor, minimum_price_minor, cost_minor,
      tax_treatment, tax_rate_bps, tax_code, available_from, available_to,
      capacity_metadata, display_order, event_reference_kind, event_id,
      ticket_type_id, create_task_on_acceptance, created_by, updated_by
    ) VALUES (
      p_tenant_id, v_product.category_id, v_product.code, v_product.sku, v_product.name,
      v_product.short_description, v_product.description, v_product.currency,
      v_product.standard_price_minor, v_product.minimum_price_minor, v_product.cost_minor,
      v_product.tax_treatment, COALESCE(v_product.tax_rate_bps, 0), v_product.tax_code,
      v_product.available_from, v_product.available_to,
      COALESCE(v_product.capacity_metadata, '{}'::jsonb), COALESCE(v_product.display_order, 0),
      v_product.event_reference_kind, v_product.event_id, v_product.ticket_type_id,
      COALESCE(v_product.create_task_on_acceptance, false), p_actor_id, p_actor_id
    ) RETURNING id, to_jsonb(sales_catalogue_product.*) INTO v_id, v_after;
  ELSE
    IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' THEN
      RAISE EXCEPTION 'Bundle items must be a non-empty array' USING ERRCODE = '22023';
    END IF;
    IF jsonb_array_length(p_items) = 0 THEN
      RAISE EXCEPTION 'Bundle items must be a non-empty array' USING ERRCODE = '22023';
    END IF;
    -- SHARE (not KEY SHARE) also fences concurrent archive/status changes.
    -- Stable order avoids conflicting bundle creates taking locks in reverse.
    PERFORM 1 FROM public.sales_catalogue_product
      WHERE tenant_id = p_tenant_id AND is_active
        AND id IN (SELECT (item->>'productId')::uuid FROM jsonb_array_elements(p_items) item)
      ORDER BY id FOR SHARE;
    GET DIAGNOSTICS v_count = ROW_COUNT;
    IF v_count <> jsonb_array_length(p_items) THEN
      RAISE EXCEPTION 'Bundle requires distinct active products belonging to this tenant' USING ERRCODE = '22023';
    END IF;
    v_bundle := jsonb_populate_record(NULL::public.sales_catalogue_bundle, p_record);
    INSERT INTO public.sales_catalogue_bundle (
      tenant_id, code, name, description, currency, selling_price_minor,
      minimum_price_minor, presentation_mode, available_from, available_to,
      display_order, created_by, updated_by
    ) VALUES (
      p_tenant_id, v_bundle.code, v_bundle.name, v_bundle.description, v_bundle.currency,
      v_bundle.selling_price_minor, v_bundle.minimum_price_minor,
      COALESCE(v_bundle.presentation_mode, 'bundle'), v_bundle.available_from,
      v_bundle.available_to, COALESCE(v_bundle.display_order, 0), p_actor_id, p_actor_id
    ) RETURNING id, to_jsonb(sales_catalogue_bundle.*) INTO v_id, v_after;
    INSERT INTO public.sales_catalogue_bundle_item (
      tenant_id, bundle_id, product_id, quantity, display_order
    ) SELECT p_tenant_id, v_id, (item.value->>'productId')::uuid,
        (item.value->>'quantity')::integer, item.ordinality - 1
      FROM jsonb_array_elements(p_items) WITH ORDINALITY item(value, ordinality);
    v_after := v_after || jsonb_build_object('items', (
      SELECT jsonb_agg(jsonb_build_object(
        'id', id, 'productId', product_id, 'quantity', quantity, 'displayOrder', display_order
      ) ORDER BY display_order)
      FROM public.sales_catalogue_bundle_item WHERE tenant_id = p_tenant_id AND bundle_id = v_id
    ));
  END IF;
  INSERT INTO public.sales_audit_event (
    tenant_id, actor_id, actor_type, action, entity_type, entity_id, before_data, after_data
  ) VALUES (
    p_tenant_id, p_actor_id, p_actor_type,
    CASE p_type WHEN 'products' THEN 'product.created' ELSE 'bundle.created' END,
    CASE p_type WHEN 'products' THEN 'sales_catalogue_product' ELSE 'sales_catalogue_bundle' END,
    v_id, NULL, v_after
  );
  RETURN v_after;
END;
$$;
REVOKE ALL ON FUNCTION public.create_sales_catalogue_record(uuid,text,jsonb,jsonb,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_sales_catalogue_record(uuid,text,jsonb,jsonb,text,text) TO service_role;
