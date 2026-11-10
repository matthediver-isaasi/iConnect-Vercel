-- Forward-only: no historical allocation or setting backfill.
BEGIN;
-- Non-allocating selections still need immutable catalogue/payment evidence.
CREATE TABLE IF NOT EXISTS public.form_bundle_selection (
  submission_id uuid PRIMARY KEY REFERENCES public.form_submission(id) ON DELETE RESTRICT,
  tenant_id uuid NOT NULL,
  bundle_id uuid NOT NULL,
  field_id text NOT NULL,
  bundle_name text NOT NULL,
  amount_minor bigint NOT NULL,
  currency text NOT NULL,
  FOREIGN KEY (tenant_id,bundle_id) REFERENCES public.sales_catalogue_bundle(tenant_id,id)
);
ALTER TABLE public.form_bundle_selection ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.form_bundle_selection FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.form_bundle_selection TO service_role;
CREATE POLICY form_bundle_selection_service_read ON public.form_bundle_selection
  FOR SELECT TO service_role USING (true);
CREATE FUNCTION public.guard_form_bundle_selection_receipt() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'Bundle selection evidence is immutable' USING ERRCODE='23514';
END;
$$;
CREATE TRIGGER form_bundle_selection_immutable BEFORE UPDATE OR DELETE ON public.form_bundle_selection
  FOR EACH ROW EXECUTE FUNCTION public.guard_form_bundle_selection_receipt();
REVOKE ALL ON FUNCTION public.guard_form_bundle_selection_receipt() FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.allocate_submission_bundle() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE f public.form; field jsonb; selected uuid; allocation jsonb; payment jsonb;
  b public.sales_catalogue_bundle; remaining integer; reduce_stock boolean;
BEGIN
  SELECT * INTO f FROM public.form WHERE id=NEW.form_id AND tenant_id=NEW.tenant_id;
  IF NOT FOUND THEN RETURN NEW; END IF;
  SELECT value INTO field FROM jsonb_array_elements(COALESCE(f.fields,'[]'::jsonb))
    WHERE value->>'type'='sales_bundle';
  IF field IS NULL OR NEW.submission_data->>'__bundle_hidden'=field->>'id'
    OR NULLIF(NEW.submission_data->>(field->>'id'),'') IS NULL THEN RETURN NEW; END IF;
  IF f.form_type='survey' OR (SELECT count(*) FROM jsonb_array_elements(f.fields)
    WHERE value->>'type'='sales_bundle')<>1 THEN
    RAISE EXCEPTION 'Unsupported bundle configuration' USING ERRCODE='22023';
  END IF;
  IF field ? 'reduce_bundle_stock_on_submission'
    AND jsonb_typeof(field->'reduce_bundle_stock_on_submission') IS DISTINCT FROM 'boolean' THEN
    RAISE EXCEPTION 'Reduce bundle stock on submission must be on or off' USING ERRCODE='22023';
  END IF;
  reduce_stock := field->'reduce_bundle_stock_on_submission' IS DISTINCT FROM 'false'::jsonb;
  selected := (NEW.submission_data->>(field->>'id'))::uuid;
  IF NOT COALESCE(field->'allowed_bundle_ids' ? selected::text,false) THEN
    RAISE EXCEPTION 'Bundle is not allowed on this form' USING ERRCODE='22023';
  END IF;
  IF NEW.payment_provider IS NOT NULL AND NEW.payment_provider NOT IN ('stripe','gocardless') THEN
    RAISE EXCEPTION 'Bundles support one-off payment only' USING ERRCODE='22023';
  END IF;
  IF reduce_stock THEN
    allocation := public.reserve_form_bundle(NEW.tenant_id,selected,NEW.id,field->>'id',NEW.id::text);
  ELSE
    -- Same lock order as allocation/admin edits; availability is still enforced.
    SELECT * INTO b FROM public.sales_catalogue_bundle
      WHERE tenant_id=NEW.tenant_id AND id=selected FOR UPDATE;
    IF NOT FOUND OR NOT b.is_active OR b.archived_at IS NOT NULL
      OR b.available_from>now() OR b.available_to<now() THEN
      RAISE EXCEPTION 'Bundle is unavailable' USING ERRCODE='22023';
    END IF;
    SELECT s.remaining INTO remaining FROM public.form_bundle_stock s
      WHERE s.tenant_id=NEW.tenant_id AND s.bundle_id=selected FOR UPDATE;
    IF remaining=0 THEN
      RAISE EXCEPTION 'Bundle is sold out; choose another selection' USING ERRCODE='P0001';
    END IF;
    INSERT INTO public.form_bundle_selection
      VALUES(NEW.id,NEW.tenant_id,selected,field->>'id',b.name,b.selling_price_minor,b.currency);
    allocation := jsonb_build_object('bundle_name',b.name,'amount_minor',b.selling_price_minor,'currency',b.currency);
  END IF;
  SELECT value INTO payment FROM jsonb_array_elements(f.fields)
    WHERE value->>'type'='payment' AND value->>'price_field_id'=field->>'id';
  IF NEW.payment_provider IS NOT NULL AND payment IS NOT NULL AND
    (NEW.payment_amount IS DISTINCT FROM (allocation->>'amount_minor')::numeric/100
      OR upper(NEW.payment_currency) IS DISTINCT FROM allocation->>'currency') THEN
    RAISE EXCEPTION 'Bundle price changed; request a new quote' USING ERRCODE='40001';
  END IF;
  UPDATE public.form_submission SET submission_data=(submission_data-'__bundle_labels') ||
    jsonb_build_object('__bundle_labels',jsonb_build_object(field->>'id',allocation->>'bundle_name'))
    WHERE id=NEW.id;
  IF NEW.payment_provider IS NULL AND reduce_stock THEN
    PERFORM public.finalize_form_bundle(NEW.tenant_id,NEW.id,'consumed');
  ELSIF NEW.payment_provider IS NOT NULL AND NEW.payment_status='paid' THEN
    RAISE EXCEPTION 'Paid bundle submissions require an existing attempt' USING ERRCODE='22023';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.guard_form_bundle_submission() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE a record;
BEGIN
  SELECT field_id,bundle_name INTO a FROM public.form_bundle_allocation WHERE submission_id=OLD.id
    UNION ALL SELECT field_id,bundle_name FROM public.form_bundle_selection WHERE submission_id=OLD.id;
  IF NOT FOUND THEN RETURN NEW; END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.form_id IS DISTINCT FROM OLD.form_id
    OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
    OR NEW.submission_data->a.field_id IS DISTINCT FROM OLD.submission_data->a.field_id THEN
    RAISE EXCEPTION 'Accepted bundle selection and submission identity cannot change' USING ERRCODE='23514';
  END IF;
  NEW.submission_data := (NEW.submission_data-'__bundle_labels') ||
    jsonb_build_object('__bundle_labels',jsonb_build_object(a.field_id,a.bundle_name));
  IF OLD.payment_provider IS NOT NULL AND
    (NEW.submission_data-'__bundle_labels') IS DISTINCT FROM (OLD.submission_data-'__bundle_labels') THEN
    RAISE EXCEPTION 'Bundle checkout answers are immutable' USING ERRCODE='23514';
  END IF;
  IF NEW.payment_amount IS DISTINCT FROM OLD.payment_amount
    OR NEW.payment_currency IS DISTINCT FROM OLD.payment_currency
    OR NEW.payment_provider IS DISTINCT FROM OLD.payment_provider
    OR (OLD.payment_reference IS NOT NULL AND NEW.payment_reference IS DISTINCT FROM OLD.payment_reference) THEN
    RAISE EXCEPTION 'Bundle payment attempt is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

-- Even a direct service RPC must not retroactively allocate a disabled receipt.
CREATE FUNCTION public.guard_nonallocating_bundle_selection() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM public.form_bundle_selection WHERE submission_id=NEW.submission_id) THEN
    RAISE EXCEPTION 'Accepted bundle selection does not allocate stock' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER guard_nonallocating_bundle_selection BEFORE INSERT ON public.form_bundle_allocation
  FOR EACH ROW EXECUTE FUNCTION public.guard_nonallocating_bundle_selection();
REVOKE ALL ON FUNCTION public.guard_nonallocating_bundle_selection() FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.form_bundle_stock_option_version() RETURNS integer
LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$ SELECT 1; $$;
REVOKE ALL ON FUNCTION public.form_bundle_stock_option_version() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.form_bundle_stock_option_version() TO service_role;
COMMIT;
