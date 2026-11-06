-- Independent form bundle inventory. Does not allocate component inventory,
-- exhibition space, proposal items, or Sales orders.
-- No stock row means Unlimited. Remaining means available, excluding holds.
BEGIN;

CREATE TABLE public.form_bundle_stock (
  tenant_id uuid NOT NULL,
  bundle_id uuid NOT NULL,
  remaining integer CHECK (remaining IS NULL OR remaining >= 0),
  reserved integer NOT NULL DEFAULT 0 CHECK (reserved >= 0),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, bundle_id),
  FOREIGN KEY (tenant_id, bundle_id)
    REFERENCES public.sales_catalogue_bundle(tenant_id, id) ON DELETE RESTRICT
);

CREATE TABLE public.form_bundle_allocation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  bundle_id uuid NOT NULL,
  submission_id uuid NOT NULL REFERENCES public.form_submission(id) ON DELETE RESTRICT,
  field_id text NOT NULL CHECK (length(field_id) BETWEEN 1 AND 255),
  attempt_key text NOT NULL CHECK (length(attempt_key) BETWEEN 1 AND 255),
  state text NOT NULL CHECK (state IN ('held', 'consumed', 'released')),
  bundle_name text NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor BETWEEN 0 AND 9007199254740991),
  currency varchar(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  -- This records whether the initial reservation deducted finite stock.
  -- Mode changes are forbidden with holds, so releases never invent stock.
  finite boolean NOT NULL,
  release_evidence jsonb,
  next_check_at timestamptz NOT NULL DEFAULT now() + interval '24 hours',
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  finalized_at timestamptz,
  UNIQUE (tenant_id, submission_id),
  UNIQUE (submission_id),
  UNIQUE (tenant_id, attempt_key),
  FOREIGN KEY (tenant_id, bundle_id)
    REFERENCES public.form_bundle_stock(tenant_id, bundle_id) ON DELETE RESTRICT,
  CHECK ((state = 'held' AND finalized_at IS NULL AND release_evidence IS NULL)
    OR (state = 'consumed' AND finalized_at IS NOT NULL AND release_evidence IS NULL)
    OR (state = 'released' AND finalized_at IS NOT NULL AND release_evidence IS NOT NULL))
);
CREATE INDEX form_bundle_allocation_held
  ON public.form_bundle_allocation(created_at, id) WHERE state = 'held';

CREATE FUNCTION public.guard_form_bundle_allocation() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Bundle allocation evidence cannot be deleted' USING ERRCODE = '23514';
  END IF;
  IF (to_jsonb(NEW) - ARRAY['state','release_evidence','finalized_at','next_check_at','last_error'])
       IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['state','release_evidence','finalized_at','next_check_at','last_error'])
    OR OLD.state <> 'held' OR NEW.state NOT IN ('held','consumed','released')
    OR (NEW.state = 'held' AND (NEW.release_evidence IS DISTINCT FROM OLD.release_evidence
      OR NEW.finalized_at IS DISTINCT FROM OLD.finalized_at)) THEN
    RAISE EXCEPTION 'Bundle allocation is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER form_bundle_allocation_immutable
  BEFORE UPDATE OR DELETE ON public.form_bundle_allocation
  FOR EACH ROW EXECUTE FUNCTION public.guard_form_bundle_allocation();

CREATE FUNCTION public.guard_form_bundle_submission() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE a public.form_bundle_allocation;
BEGIN
  SELECT * INTO a FROM public.form_bundle_allocation WHERE submission_id = OLD.id;
  IF FOUND AND (
    NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.form_id IS DISTINCT FROM OLD.form_id
    OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
    OR NEW.submission_data->a.field_id IS DISTINCT FROM OLD.submission_data->a.field_id
  ) THEN
    RAISE EXCEPTION 'Accepted bundle selection and submission identity cannot change' USING ERRCODE = '23514';
  END IF;
  IF FOUND THEN
    NEW.submission_data := (NEW.submission_data - '__bundle_labels') ||
      jsonb_build_object('__bundle_labels',jsonb_build_object(a.field_id,a.bundle_name));
    IF OLD.payment_provider IS NOT NULL AND
      (NEW.submission_data - '__bundle_labels') IS DISTINCT FROM (OLD.submission_data - '__bundle_labels') THEN
      RAISE EXCEPTION 'Bundle checkout answers are immutable' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER form_bundle_submission_immutable
  BEFORE UPDATE ON public.form_submission
  FOR EACH ROW EXECUTE FUNCTION public.guard_form_bundle_submission();

-- Administrative compare-and-swap. Version zero means no configuration yet.
-- Allocations also increment this version; stale open editors cannot restore
-- stock that a respondent has just reserved or consumed.
CREATE FUNCTION public.set_form_bundle_stock(
  p_tenant_id uuid, p_bundle_id uuid, p_expected_version bigint,
  p_remaining integer, p_actor_id text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE s public.form_bundle_stock; before_value jsonb;
BEGIN
  IF p_remaining < 0 OR p_expected_version IS NULL OR p_expected_version < 0
    OR p_actor_id IS NULL OR length(btrim(p_actor_id)) = 0 THEN
    RAISE EXCEPTION 'Invalid bundle stock edit' USING ERRCODE = '22023';
  END IF;
  -- Catalogue lock orders lazy creation consistently with reservation.
  PERFORM 1 FROM public.sales_catalogue_bundle
    WHERE tenant_id = p_tenant_id AND id = p_bundle_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Bundle not found' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO s FROM public.form_bundle_stock
    WHERE tenant_id = p_tenant_id AND bundle_id = p_bundle_id FOR UPDATE;
  before_value := to_jsonb(s);
  IF NOT FOUND THEN
    IF p_expected_version <> 0 THEN
      RAISE EXCEPTION 'Bundle stock changed; reload and retry' USING ERRCODE = '40001';
    END IF;
    INSERT INTO public.form_bundle_stock(tenant_id,bundle_id,remaining)
      VALUES(p_tenant_id,p_bundle_id,p_remaining) RETURNING * INTO s;
  ELSE
    IF s.version <> p_expected_version THEN
      RAISE EXCEPTION 'Bundle stock changed; reload and retry' USING ERRCODE = '40001';
    END IF;
    IF s.reserved > 0 AND (s.remaining IS NULL) <> (p_remaining IS NULL) THEN
      RAISE EXCEPTION 'Resolve existing holds before changing Unlimited mode' USING ERRCODE = '22023';
    END IF;
    UPDATE public.form_bundle_stock SET remaining = p_remaining,
      version = version + 1, updated_at = now()
      WHERE tenant_id = p_tenant_id AND bundle_id = p_bundle_id RETURNING * INTO s;
  END IF;
  INSERT INTO public.sales_audit_event(tenant_id,actor_id,actor_type,action,entity_type,entity_id,before_data,after_data)
    VALUES(p_tenant_id,p_actor_id,'tenant_user','bundle.stock_updated','sales_catalogue_bundle',
      p_bundle_id::text,before_value,to_jsonb(s));
  RETURN to_jsonb(s);
END;
$$;

-- Call in the same transaction as successful submission persistence.
-- Caller must already enforce form access, allowlist, visibility and pricing
-- mode. This function independently enforces tenant, current eligibility,
-- persisted selection identity and the catalogue's price snapshot.
CREATE FUNCTION public.reserve_form_bundle(
  p_tenant_id uuid, p_bundle_id uuid, p_submission_id uuid,
  p_field_id text, p_attempt_key text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE b public.sales_catalogue_bundle; s public.form_bundle_stock;
  a public.form_bundle_allocation; submission public.form_submission;
BEGIN
  SELECT * INTO submission FROM public.form_submission
    WHERE id = p_submission_id AND tenant_id = p_tenant_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Submission not found' USING ERRCODE = 'P0002';
  END IF;
  IF p_field_id IS NULL OR p_attempt_key IS NULL
    OR submission.submission_data->>p_field_id IS DISTINCT FROM p_bundle_id::text THEN
    RAISE EXCEPTION 'Bundle selection does not match submission' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO a FROM public.form_bundle_allocation
    WHERE tenant_id = p_tenant_id AND submission_id = p_submission_id;
  IF FOUND THEN
    IF a.bundle_id <> p_bundle_id OR a.field_id <> p_field_id OR a.attempt_key <> p_attempt_key THEN
      RAISE EXCEPTION 'Accepted bundle selection cannot change' USING ERRCODE = '22023';
    END IF;
    RETURN to_jsonb(a);
  END IF;
  SELECT * INTO b FROM public.sales_catalogue_bundle
    WHERE tenant_id = p_tenant_id AND id = p_bundle_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Bundle not found' USING ERRCODE = 'P0002';
  END IF;
  IF NOT b.is_active OR b.archived_at IS NOT NULL
    OR b.available_from > now() OR b.available_to < now() THEN
    RAISE EXCEPTION 'Bundle is unavailable' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.form_bundle_stock(tenant_id,bundle_id)
    VALUES(p_tenant_id,p_bundle_id) ON CONFLICT DO NOTHING;
  SELECT * INTO s FROM public.form_bundle_stock
    WHERE tenant_id = p_tenant_id AND bundle_id = p_bundle_id FOR UPDATE;
  IF s.remaining = 0 THEN
    RAISE EXCEPTION 'Bundle is sold out; choose another selection' USING ERRCODE = 'P0001';
  END IF;
  UPDATE public.form_bundle_stock SET remaining = remaining - 1,
    reserved = reserved + 1, version = version + 1, updated_at = now()
    WHERE tenant_id = p_tenant_id AND bundle_id = p_bundle_id;
  INSERT INTO public.form_bundle_allocation(
    tenant_id,bundle_id,submission_id,field_id,attempt_key,state,bundle_name,amount_minor,currency,finite
  ) VALUES(p_tenant_id,p_bundle_id,p_submission_id,p_field_id,p_attempt_key,'held',
    b.name,b.selling_price_minor,b.currency,s.remaining IS NOT NULL) RETURNING * INTO a;
  RETURN to_jsonb(a);
END;
$$;

-- Release evidence is supplied only by the trusted provider reconciliation
-- adapter after it has verified the attempt cannot take payment. A local
-- timeout or a browser cancellation is NOT evidence.
CREATE FUNCTION public.finalize_form_bundle(
  p_tenant_id uuid, p_submission_id uuid, p_state text, p_release_evidence jsonb DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp AS $$
DECLARE a public.form_bundle_allocation; submission public.form_submission;
BEGIN
  IF p_state IS NULL OR p_state NOT IN ('consumed','released') THEN
    RAISE EXCEPTION 'Invalid bundle finalization state' USING ERRCODE = '22023';
  END IF;
  -- Same lock order as reservation; provider success and cleanup serialize.
  SELECT * INTO submission FROM public.form_submission
    WHERE tenant_id = p_tenant_id AND id = p_submission_id FOR UPDATE;
  SELECT * INTO a FROM public.form_bundle_allocation
    WHERE tenant_id = p_tenant_id AND submission_id = p_submission_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Bundle allocation not found' USING ERRCODE = 'P0002';
  END IF;
  IF a.state = p_state THEN RETURN to_jsonb(a); END IF;
  IF a.state <> 'held' THEN
    RAISE EXCEPTION 'Bundle allocation already finalized; requires attention' USING ERRCODE = '23514';
  END IF;
  IF p_state = 'consumed' AND submission.payment_provider IS NOT NULL
    AND submission.payment_status IS DISTINCT FROM 'paid' THEN
    RAISE EXCEPTION 'Authoritative payment success required' USING ERRCODE = '22023';
  END IF;
  IF p_state = 'released' AND (
    p_release_evidence IS NULL OR jsonb_typeof(p_release_evidence) <> 'object'
    OR COALESCE(p_release_evidence->>'provider','') NOT IN ('stripe','gocardless')
    OR COALESCE(p_release_evidence->>'terminal_status','') NOT IN ('cancelled','expired')
    OR COALESCE(length(p_release_evidence->>'reference'),0) = 0
    OR COALESCE(length(p_release_evidence->>'verified_at'),0) = 0
    OR p_release_evidence->>'provider' IS DISTINCT FROM submission.payment_provider
    OR p_release_evidence->>'reference' IS DISTINCT FROM submission.payment_reference
    OR submission.payment_status = 'paid'
  ) THEN
    RAISE EXCEPTION 'Verified terminal provider evidence required' USING ERRCODE = '22023';
  END IF;
  UPDATE public.form_bundle_stock
    SET reserved = reserved - 1,
      remaining = CASE WHEN p_state = 'released' AND a.finite THEN remaining + 1 ELSE remaining END,
      version = version + 1, updated_at = now()
    WHERE tenant_id = p_tenant_id AND bundle_id = a.bundle_id;
  UPDATE public.form_bundle_allocation SET state = p_state, finalized_at = now(),
    release_evidence = CASE WHEN p_state = 'released' THEN p_release_evidence ELSE NULL END
    WHERE id = a.id RETURNING * INTO a;
  RETURN to_jsonb(a);
END;
$$;

ALTER TABLE public.form_bundle_stock ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.form_bundle_allocation ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.form_bundle_stock, public.form_bundle_allocation FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.form_bundle_stock, public.form_bundle_allocation TO service_role;
CREATE POLICY form_bundle_stock_service_read ON public.form_bundle_stock
  FOR SELECT TO service_role USING (true);
CREATE POLICY form_bundle_allocation_service_read ON public.form_bundle_allocation
  FOR SELECT TO service_role USING (true);
REVOKE ALL ON FUNCTION public.guard_form_bundle_allocation() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.guard_form_bundle_submission() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.set_form_bundle_stock(uuid,uuid,bigint,integer,text),
  public.reserve_form_bundle(uuid,uuid,uuid,text,text),
  public.finalize_form_bundle(uuid,uuid,text,jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_form_bundle_stock(uuid,uuid,bigint,integer,text),
  public.reserve_form_bundle(uuid,uuid,uuid,text,text),
  public.finalize_form_bundle(uuid,uuid,text,jsonb) TO service_role;

-- All existing public/entity/checkout INSERT writers share this transaction
-- boundary. No browser-supplied allocation metadata is trusted.
CREATE FUNCTION public.allocate_submission_bundle() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE f public.form; field jsonb; selected uuid; allocation jsonb; payment jsonb;
BEGIN
  SELECT * INTO f FROM public.form WHERE id = NEW.form_id AND tenant_id = NEW.tenant_id;
  IF NOT FOUND THEN RETURN NEW; END IF;
  SELECT value INTO field FROM jsonb_array_elements(COALESCE(f.fields,'[]'::jsonb))
    WHERE value->>'type' = 'sales_bundle';
  IF field IS NULL OR NEW.submission_data->>'__bundle_hidden' = field->>'id'
    OR NULLIF(NEW.submission_data->>(field->>'id'),'') IS NULL THEN RETURN NEW; END IF;
  IF f.form_type = 'survey' OR (SELECT count(*) FROM jsonb_array_elements(f.fields)
      WHERE value->>'type'='sales_bundle') <> 1 THEN
    RAISE EXCEPTION 'Unsupported bundle configuration' USING ERRCODE='22023';
  END IF;
  selected := (NEW.submission_data->>(field->>'id'))::uuid;
  IF NOT COALESCE(field->'allowed_bundle_ids' ? selected::text,false) THEN
    RAISE EXCEPTION 'Bundle is not allowed on this form' USING ERRCODE='22023';
  END IF;
  IF NEW.payment_provider IS NOT NULL AND NEW.payment_provider NOT IN ('stripe','gocardless') THEN
    RAISE EXCEPTION 'Bundles support one-off payment only' USING ERRCODE='22023';
  END IF;
  allocation := public.reserve_form_bundle(NEW.tenant_id,selected,NEW.id,field->>'id',NEW.id::text);
  SELECT value INTO payment FROM jsonb_array_elements(f.fields)
    WHERE value->>'type'='payment' AND value->>'price_field_id'=field->>'id';
  IF NEW.payment_provider IS NOT NULL AND payment IS NOT NULL AND
    (NEW.payment_amount IS DISTINCT FROM (allocation->>'amount_minor')::numeric/100
      OR upper(NEW.payment_currency) IS DISTINCT FROM allocation->>'currency') THEN
    RAISE EXCEPTION 'Bundle price changed; request a new quote' USING ERRCODE='40001';
  END IF;
  UPDATE public.form_submission SET submission_data =
    (submission_data - '__bundle_labels') || jsonb_build_object('__bundle_labels',
      jsonb_build_object(field->>'id',allocation->>'bundle_name'))
    WHERE id=NEW.id;
  IF NEW.payment_provider IS NULL THEN
    PERFORM public.finalize_form_bundle(NEW.tenant_id,NEW.id,'consumed');
  ELSIF NEW.payment_status = 'paid' THEN
    RAISE EXCEPTION 'Paid bundle submissions require an existing hold' USING ERRCODE='22023';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER allocate_submission_bundle
  AFTER INSERT ON public.form_submission FOR EACH ROW EXECUTE FUNCTION public.allocate_submission_bundle();

CREATE FUNCTION public.settle_submission_bundle() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE a public.form_bundle_allocation;
BEGIN
  SELECT * INTO a FROM public.form_bundle_allocation WHERE submission_id=NEW.id;
  IF NOT FOUND THEN RETURN NEW; END IF;
  IF NEW.payment_amount IS DISTINCT FROM OLD.payment_amount
    OR NEW.payment_currency IS DISTINCT FROM OLD.payment_currency
    OR NEW.payment_provider IS DISTINCT FROM OLD.payment_provider
    OR (OLD.payment_reference IS NOT NULL AND NEW.payment_reference IS DISTINCT FROM OLD.payment_reference) THEN
    RAISE EXCEPTION 'Bundle payment attempt is immutable' USING ERRCODE='23514';
  END IF;
  IF NEW.payment_status = 'paid' AND OLD.payment_status IS DISTINCT FROM 'paid' THEN
    PERFORM public.finalize_form_bundle(NEW.tenant_id,NEW.id,'consumed');
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER settle_submission_bundle
  AFTER UPDATE ON public.form_submission FOR EACH ROW EXECUTE FUNCTION public.settle_submission_bundle();
REVOKE ALL ON FUNCTION public.allocate_submission_bundle(),public.settle_submission_bundle()
  FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.defer_form_bundle_check(p_tenant_id uuid,p_submission_id uuid,p_error text)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path=public,pg_temp AS $$
  UPDATE public.form_bundle_allocation SET next_check_at=now()+interval '1 hour',
    last_error=left(p_error,500)
    WHERE tenant_id=p_tenant_id AND submission_id=p_submission_id AND state='held';
$$;
REVOKE ALL ON FUNCTION public.defer_form_bundle_check(uuid,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.defer_form_bundle_check(uuid,uuid,text) TO service_role;
COMMIT;
