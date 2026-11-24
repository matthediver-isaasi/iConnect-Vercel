BEGIN;
ALTER TABLE public.sales_invoice_schedule ADD COLUMN manual_invoice_number text;

-- Manual documentary evidence, not a provider-verified invoice or payment.
CREATE TABLE public.sales_stage_historical_invoice (
  tenant_id uuid NOT NULL,
  quote_version_id uuid NOT NULL,
  group_id uuid NOT NULL,
  invoice_number text NOT NULL CHECK (length(btrim(invoice_number)) BETWEEN 1 AND 100),
  group_snapshot jsonb NOT NULL,
  recorded_by text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, quote_version_id, group_id),
  FOREIGN KEY (tenant_id, quote_version_id) REFERENCES public.sales_quote_version(tenant_id,id)
);
ALTER TABLE public.sales_stage_historical_invoice ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.sales_stage_historical_invoice FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.sales_stage_historical_invoice TO service_role;
CREATE POLICY historical_invoice_read ON public.sales_stage_historical_invoice
  FOR SELECT TO service_role USING (true);

-- Existing terminal state is deliberately reused: no new invoice is required.
-- A trigger enforces it even against legacy dispatch callers and direct writes.
CREATE FUNCTION public.guard_sales_stage_historical_invoice() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE reference text;
BEGIN
  SELECT invoice_number INTO reference FROM sales_stage_historical_invoice
    WHERE tenant_id=NEW.tenant_id AND quote_version_id=NEW.quote_version_id AND group_id=NEW.group_id;
  IF reference IS NOT NULL THEN
    IF NEW.accounting_request_id IS NOT NULL OR NEW.dispatch_claim_token IS NOT NULL
      OR NEW.status NOT IN ('pending','blocked','no_invoice_required') THEN
      RAISE EXCEPTION 'An existing invoice is recorded for this stage; new issuance is prohibited' USING ERRCODE='PT409';
    END IF;
    NEW.status := 'no_invoice_required';
    NEW.last_error := NULL;
    NEW.manual_invoice_number := reference;
  ELSIF NEW.manual_invoice_number IS NOT NULL THEN
    RAISE EXCEPTION 'Existing invoice numbers must be recorded through the audited operation' USING ERRCODE='PT409';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER sales_stage_historical_invoice_guard BEFORE INSERT OR UPDATE ON public.sales_invoice_schedule
  FOR EACH ROW EXECUTE FUNCTION public.guard_sales_stage_historical_invoice();

-- Do not let an ordinary draft edit remove/re-price a stage already invoiced.
CREATE FUNCTION public.guard_sales_historical_quote_edit() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r record;
BEGIN
  FOR r IN SELECT * FROM sales_stage_historical_invoice
    WHERE tenant_id=OLD.tenant_id AND quote_version_id=OLD.id LOOP
    IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(NEW.billing_schedule->'groups') g
      WHERE g->>'id'=r.group_id::text AND g=r.group_snapshot) THEN
      RAISE EXCEPTION 'A stage with a recorded existing invoice cannot be removed or changed' USING ERRCODE='PT409';
    END IF;
  END LOOP;
  RETURN NEW;
END $$;
CREATE TRIGGER sales_historical_quote_edit BEFORE UPDATE ON public.sales_quote_version
  FOR EACH ROW EXECUTE FUNCTION public.guard_sales_historical_quote_edit();

-- New versions must not silently lose historical completion evidence.
CREATE FUNCTION public.copy_sales_historical_quote_invoices() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r record;
BEGIN
  FOR r IN SELECT DISTINCT ON (h.group_id) h.*
    FROM sales_stage_historical_invoice h JOIN sales_quote_version v
      ON v.tenant_id=h.tenant_id AND v.id=h.quote_version_id
    WHERE v.tenant_id=NEW.tenant_id AND v.quote_id=NEW.quote_id AND v.version_number<NEW.version_number
    ORDER BY h.group_id,v.version_number DESC LOOP
    IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(NEW.billing_schedule->'groups') g
      WHERE g->>'id'=r.group_id::text AND g=r.group_snapshot) THEN
      RAISE EXCEPTION 'An amendment must preserve stages with recorded existing invoices' USING ERRCODE='PT409';
    END IF;
    INSERT INTO sales_stage_historical_invoice
      VALUES(NEW.tenant_id,NEW.id,r.group_id,r.invoice_number,r.group_snapshot,r.recorded_by,r.recorded_at);
  END LOOP;
  RETURN NEW;
END $$;
CREATE TRIGGER sales_historical_quote_copy AFTER INSERT ON public.sales_quote_version
  FOR EACH ROW EXECUTE FUNCTION public.copy_sales_historical_quote_invoices();

CREATE FUNCTION public.record_sales_stage_historical_invoice(
  p_tenant uuid,p_quote uuid,p_version uuid,p_group uuid,p_number text,p_actor text,p_actor_type text,p_expected_group jsonb
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v sales_quote_version; s sales_invoice_schedule; g jsonb; existing text;
BEGIN
  IF p_number IS NULL OR length(btrim(p_number)) NOT BETWEEN 1 AND 100
    OR p_number ~ '[[:cntrl:]]' OR NULLIF(btrim(p_actor),'') IS NULL THEN
    RAISE EXCEPTION 'A valid invoice number and actor are required' USING ERRCODE='23514';
  END IF;
  -- Same quote/version lock order as editing and acceptance, then the dispatch row.
  PERFORM 1 FROM sales_quote WHERE tenant_id=p_tenant AND id=p_quote FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Reload the current proposal before recording an invoice' USING ERRCODE='PT409';
  END IF;
  SELECT * INTO v FROM sales_quote_version
    WHERE tenant_id=p_tenant AND quote_id=p_quote AND id=p_version FOR UPDATE;
  IF NOT FOUND OR v.status NOT IN ('draft','issued','sent','accepted','converted')
    OR EXISTS (SELECT 1 FROM sales_quote_version WHERE tenant_id=p_tenant
      AND quote_id=p_quote AND version_number>v.version_number) THEN
    RAISE EXCEPTION 'Reload the current proposal before recording an invoice' USING ERRCODE='PT409';
  END IF;
  SELECT value INTO g FROM jsonb_array_elements(v.billing_schedule->'groups') WHERE value->>'id'=p_group::text;
  IF g IS NULL OR (g->>'grossMinor')::bigint<=0 THEN
    RAISE EXCEPTION 'Select a saved billing stage with a positive amount' USING ERRCODE='PT409';
  END IF;
  IF g IS DISTINCT FROM p_expected_group THEN
    RAISE EXCEPTION 'This billing stage changed; reload it before recording the invoice' USING ERRCODE='PT409';
  END IF;
  SELECT invoice_number INTO existing FROM sales_stage_historical_invoice
    WHERE tenant_id=p_tenant AND quote_version_id=p_version AND group_id=p_group;
  IF existing IS NOT NULL THEN
    IF existing=btrim(p_number) THEN RETURN; END IF;
    RAISE EXCEPTION 'An existing invoice has already been recorded for this stage' USING ERRCODE='PT409';
  END IF;
  SELECT * INTO s FROM sales_invoice_schedule
    WHERE tenant_id=p_tenant AND quote_version_id=p_version AND group_id=p_group FOR UPDATE;
  IF FOUND AND (s.status NOT IN ('pending','blocked') OR s.accounting_request_id IS NOT NULL
    OR s.dispatch_claim_token IS NOT NULL OR EXISTS(SELECT 1 FROM sales_accounting_invoice_link
      WHERE tenant_id=p_tenant AND schedule_id=s.id)) THEN
    RAISE EXCEPTION 'This stage is already issued or being processed; reconcile it before recording an invoice' USING ERRCODE='PT409';
  END IF;
  INSERT INTO sales_stage_historical_invoice(tenant_id,quote_version_id,group_id,invoice_number,group_snapshot,recorded_by)
    VALUES(p_tenant,p_version,p_group,btrim(p_number),g,p_actor);
  UPDATE sales_invoice_schedule SET status='no_invoice_required',last_error=NULL,updated_at=now()
    WHERE tenant_id=p_tenant AND quote_version_id=p_version AND group_id=p_group;
  INSERT INTO sales_audit_event(tenant_id,actor_id,actor_type,action,entity_type,entity_id,after_data)
    VALUES(p_tenant,p_actor,p_actor_type,'invoice_stage.historical_invoice_recorded','sales_quote_version',p_version::text,
      jsonb_build_object('groupId',p_group,'invoiceNumber',btrim(p_number),'paymentVerified',false));
END $$;
REVOKE ALL ON FUNCTION public.record_sales_stage_historical_invoice(uuid,uuid,uuid,uuid,text,text,text,jsonb),
  public.guard_sales_stage_historical_invoice(), public.guard_sales_historical_quote_edit(),
  public.copy_sales_historical_quote_invoices() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.record_sales_stage_historical_invoice(uuid,uuid,uuid,uuid,text,text,text,jsonb) TO service_role;
COMMIT;
