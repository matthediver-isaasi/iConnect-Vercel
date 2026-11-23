-- Dedicated aggregate invoice journal. Never relax legacy single-charge ownership.
BEGIN;
CREATE TABLE public.event_funnel_invoice_work (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  order_id uuid NOT NULL,
  allocation_key text NOT NULL,
  provider text NOT NULL,
  snapshot jsonb,
  status text NOT NULL CHECK(status IN ('pending','processing','retry','complete','needs_review','not_applicable')),
  connection_id text,
  xero_tenant_id text,
  next_attempt_at timestamptz DEFAULT now(),
  attempts integer NOT NULL DEFAULT 0,
  lease_token uuid,
  lease_expires_at timestamptz,
  invoice_id text,
  invoice_number text,
  payment_id text,
  invoice_write_started_at timestamptz,
  payment_write_started_at timestamptz,
  resolved_snapshot jsonb,
  reason_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,allocation_key),
  FOREIGN KEY(tenant_id,order_id) REFERENCES public.event_funnel_order(tenant_id,id)
);
CREATE TABLE public.event_funnel_invoice_booking (
  invoice_work_id uuid NOT NULL REFERENCES public.event_funnel_invoice_work(id),
  tenant_id uuid NOT NULL,
  booking_source text NOT NULL,
  booking_id uuid NOT NULL,
  amount_minor bigint NOT NULL CHECK(amount_minor>=0),
  PRIMARY KEY(tenant_id,booking_source,booking_id),
  FOREIGN KEY(tenant_id,booking_source,booking_id)
    REFERENCES public.event_funnel_order_booking(tenant_id,booking_source,booking_id)
);
ALTER TABLE public.event_funnel_invoice_work ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.event_funnel_invoice_booking ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.event_funnel_invoice_work,public.event_funnel_invoice_booking FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.event_funnel_invoice_enqueue(p_tenant uuid,p_order uuid,p_token uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE prepared jsonb; j jsonb; provider_name text; connection text; company text;
BEGIN
  PERFORM 1 FROM public.event_funnel_delivery WHERE tenant_id=p_tenant AND order_id=p_order AND kind='invoices' FOR UPDATE;
  PERFORM public.event_funnel_invoice_input(p_tenant,p_order,p_token);
  SELECT p.prepared INTO prepared FROM public.event_funnel_invoice_preparation p WHERE tenant_id=p_tenant AND order_id=p_order;
  IF prepared IS NULL THEN RAISE EXCEPTION 'Invoice instructions unavailable' USING ERRCODE='PT409'; END IF;
  FOR j IN SELECT value FROM jsonb_array_elements(prepared) LOOP
    provider_name:=coalesce(j->>'provider','unavailable');
    connection:=j#>>'{snapshot,provider,connectionId}';company:=j#>>'{snapshot,provider,xeroTenantId}';
    IF provider_name='xero' AND j->>'status'='pending' THEN
      IF connection IS NULL OR company IS NULL THEN RAISE EXCEPTION 'Original invoice company unavailable'; END IF;
      -- Share the existing accounting connection lease and rate-limit cooldown
      -- with ordinary event invoicing, rather than creating a competing writer.
      INSERT INTO public.event_invoice_recovery_connection(connection_id,tenant_id,xero_tenant_id)
        VALUES(connection,p_tenant,company) ON CONFLICT(connection_id) DO NOTHING;
      IF NOT EXISTS(SELECT 1 FROM public.event_invoice_recovery_connection WHERE connection_id=connection
        AND tenant_id=p_tenant AND xero_tenant_id=company) THEN RAISE EXCEPTION 'Accounting connection scope changed'; END IF;
    END IF;
    INSERT INTO public.event_funnel_invoice_work(tenant_id,order_id,allocation_key,provider,snapshot,status,connection_id,xero_tenant_id)
      VALUES(p_tenant,p_order,j->>'key',provider_name,j->'snapshot',j->>'status',connection,company)
      ON CONFLICT(tenant_id,allocation_key) DO NOTHING;
  END LOOP;
  RETURN (SELECT jsonb_agg(jsonb_build_object('key',allocation_key,'status',status,'provider',provider) ORDER BY allocation_key)
    FROM public.event_funnel_invoice_work WHERE tenant_id=p_tenant AND order_id=p_order);
END $$;

CREATE FUNCTION public.event_funnel_invoice_operation(p_action text,p_args jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE r public.event_funnel_invoice_work; c public.event_invoice_recovery_connection;
  token uuid; valid boolean; resolved jsonb; new_status text; prepared jsonb; e jsonb; booking_value jsonb; a record;
BEGIN
  IF p_action='claim' THEN
    IF p_args->>'p_tenant_id' IS NULL OR p_args->>'p_group' IS NULL
      OR p_args->>'p_source' IS DISTINCT FROM 'event_funnel' THEN RAISE EXCEPTION 'Explicit invoice scope required'; END IF;
    SELECT cc.* INTO c FROM public.event_invoice_recovery_connection cc
      JOIN public.event_funnel_invoice_work w ON w.connection_id=cc.connection_id AND w.tenant_id=cc.tenant_id
      WHERE w.tenant_id=(p_args->>'p_tenant_id')::uuid AND w.allocation_key=p_args->>'p_group'
        AND w.provider='xero'
        AND ((w.status IN ('pending','retry') AND w.next_attempt_at<=clock_timestamp())
          OR (w.status='processing' AND w.lease_expires_at<=clock_timestamp()))
        AND coalesce(cc.cooldown_until,'-infinity')<=clock_timestamp()
        AND coalesce(cc.lease_expires_at,'-infinity')<=clock_timestamp()
      FOR UPDATE OF cc SKIP LOCKED;
    IF NOT FOUND THEN RETURN NULL; END IF;
    SELECT * INTO r FROM public.event_funnel_invoice_work
      WHERE tenant_id=(p_args->>'p_tenant_id')::uuid AND allocation_key=p_args->>'p_group' FOR UPDATE;
    token:=gen_random_uuid();
    UPDATE public.event_invoice_recovery_connection SET lease_token=token,lease_expires_at=clock_timestamp()+interval '120 seconds',
      last_claimed_at=clock_timestamp() WHERE connection_id=c.connection_id;
    UPDATE public.event_funnel_invoice_work SET status='processing',lease_token=token,
      lease_expires_at=clock_timestamp()+interval '120 seconds',attempts=attempts+1 WHERE id=r.id RETURNING * INTO r;
    RETURN to_jsonb(r)||jsonb_build_object('source','event_funnel','booking_group_reference',r.allocation_key);
  END IF;
  -- Always acquire connection before work row, matching ordinary invoice claims.
  SELECT cc.* INTO c FROM public.event_invoice_recovery_connection cc
    JOIN public.event_funnel_invoice_work w ON w.connection_id=cc.connection_id AND w.tenant_id=cc.tenant_id
    WHERE w.id=(p_args->>'p_id')::uuid FOR UPDATE OF cc;
  SELECT * INTO r FROM public.event_funnel_invoice_work WHERE id=(p_args->>'p_id')::uuid FOR UPDATE;
  valid:=r.id IS NOT NULL AND r.status='processing' AND r.lease_token=(p_args->>'p_token')::uuid
    AND r.lease_expires_at>clock_timestamp() AND c.lease_token=r.lease_token AND c.lease_expires_at>clock_timestamp()
    AND EXISTS(SELECT 1 FROM public.event_funnel_order WHERE tenant_id=r.tenant_id AND id=r.order_id AND state='confirmed');
  IF valid IS DISTINCT FROM true THEN RETURN 'false'::jsonb; END IF;
  IF p_action='guard' THEN RETURN 'true'::jsonb; END IF;
  IF p_action='tax_authority' THEN
    IF p_args->'p_resolved' IS NULL OR p_args->'p_resolved'='null'::jsonb THEN RETURN r.resolved_snapshot; END IF;
    resolved:=p_args->'p_resolved';
    IF r.resolved_snapshot IS NOT NULL THEN
      IF r.resolved_snapshot IS DISTINCT FROM resolved THEN RAISE EXCEPTION 'Original tax instructions differ'; END IF;
      RETURN r.resolved_snapshot;
    END IF;
    IF r.snapshot#>>'{taxResolution,kind}' IS DISTINCT FROM 'future_checkout_provider_tax'
      OR r.invoice_write_started_at IS NOT NULL OR r.invoice_id IS NOT NULL OR r.payment_write_started_at IS NOT NULL
      OR resolved-'invoice'-'resolvedTaxEvidence' IS DISTINCT FROM r.snapshot-'invoice'-'resolvedTaxEvidence'
      OR (resolved->'invoice')-'LineItems' IS DISTINCT FROM (r.snapshot->'invoice')-'LineItems'
      OR jsonb_array_length(resolved#>'{invoice,LineItems}') IS DISTINCT FROM jsonb_array_length(r.snapshot#>'{invoice,LineItems}')
      OR EXISTS(SELECT 1 FROM jsonb_array_elements(resolved#>'{invoice,LineItems}') WITH ORDINALITY x(line,n)
        WHERE x.line-'TaxType'-'TaxAmount' IS DISTINCT FROM (r.snapshot#>'{invoice,LineItems}'->(x.n::integer-1))-'TaxType'-'TaxAmount') THEN
      RAISE EXCEPTION 'Tax resolution changed original invoice authority';
    END IF;
    UPDATE public.event_funnel_invoice_work SET resolved_snapshot=resolved WHERE id=r.id;
    RETURN resolved;
  ELSIF p_action='start_write' THEN
    IF p_args->>'p_kind'='invoice' AND r.invoice_write_started_at IS NULL AND r.invoice_id IS NULL THEN
      UPDATE public.event_funnel_invoice_work SET invoice_write_started_at=clock_timestamp() WHERE id=r.id;
    ELSIF p_args->>'p_kind'='payment' AND r.payment_write_started_at IS NULL AND r.payment_id IS NULL AND r.invoice_id IS NOT NULL THEN
      UPDATE public.event_funnel_invoice_work SET payment_write_started_at=clock_timestamp() WHERE id=r.id;
    ELSE RETURN 'false'::jsonb; END IF;
    RETURN 'true'::jsonb;
  ELSIF p_action='record_invoice' THEN
    IF coalesce(p_args->>'p_invoice_id','')='' OR (r.invoice_id IS NOT NULL AND r.invoice_id<>p_args->>'p_invoice_id') THEN RETURN 'false'::jsonb; END IF;
    UPDATE public.event_funnel_invoice_work SET invoice_id=p_args->>'p_invoice_id',invoice_number=p_args->>'p_invoice_number' WHERE id=r.id;
    RETURN 'true'::jsonb;
  ELSIF p_action='finish' THEN
    new_status:=p_args->>'p_status';
    IF new_status IS NULL OR new_status NOT IN ('complete','retry','needs_review') THEN RAISE EXCEPTION 'Invalid invoice outcome'; END IF;
    IF p_args->>'p_invoice_id' IS NOT NULL AND r.invoice_id IS NOT NULL AND r.invoice_id<>p_args->>'p_invoice_id' THEN
      RAISE EXCEPTION 'Original invoice changed';
    END IF;
    IF new_status='complete' THEN
      IF r.invoice_id IS NULL OR r.invoice_id IS DISTINCT FROM p_args->>'p_invoice_id'
        OR (r.snapshot->>'paymentMethod'='stripe' AND coalesce(p_args->>'p_payment_id','')='') THEN
        RAISE EXCEPTION 'Invoice completion evidence missing';
      END IF;
      SELECT j INTO prepared FROM public.event_funnel_invoice_preparation p CROSS JOIN LATERAL jsonb_array_elements(p.prepared) j
        WHERE p.tenant_id=r.tenant_id AND p.order_id=r.order_id AND j->>'key'=r.allocation_key;
      IF prepared IS NULL THEN RAISE EXCEPTION 'Original invoice links unavailable'; END IF;
      FOR e IN SELECT value FROM jsonb_array_elements(prepared->'events') LOOP
        FOR booking_value IN SELECT value FROM jsonb_array_elements(e->'bookingIds') LOOP
          SELECT * INTO STRICT a FROM public.event_funnel_order_booking WHERE tenant_id=r.tenant_id AND order_id=r.order_id
            AND booking_source=e->>'bookingSource' AND booking_id=(booking_value#>>'{}')::uuid;
          INSERT INTO public.event_funnel_invoice_booking(invoice_work_id,tenant_id,booking_source,booking_id,amount_minor)
            VALUES(r.id,r.tenant_id,a.booking_source,a.booking_id,a.payable_minor);
        END LOOP;
      END LOOP;
    END IF;
    UPDATE public.event_funnel_invoice_work SET status=new_status,invoice_id=coalesce(invoice_id,p_args->>'p_invoice_id'),
      invoice_number=coalesce(invoice_number,p_args->>'p_invoice_number'),payment_id=coalesce(payment_id,p_args->>'p_payment_id'),
      next_attempt_at=CASE WHEN new_status='retry' THEN coalesce((p_args->>'p_next')::timestamptz,clock_timestamp()+interval '5 minutes') END,
      reason_code=p_args->>'p_reason',
      invoice_write_started_at=CASE WHEN p_args->>'p_rejected_write'='invoice' AND p_args->>'p_reason'='provider_rate_limited'
        AND invoice_id IS NULL THEN NULL ELSE invoice_write_started_at END,
      payment_write_started_at=CASE WHEN p_args->>'p_rejected_write'='payment' AND p_args->>'p_reason'='provider_rate_limited'
        AND payment_id IS NULL THEN NULL ELSE payment_write_started_at END,
      lease_token=NULL,lease_expires_at=NULL WHERE id=r.id;
    UPDATE public.event_invoice_recovery_connection SET lease_token=NULL,lease_expires_at=NULL,
      cooldown_until=CASE WHEN p_args->>'p_cooldown' IS NULL THEN cooldown_until
        ELSE greatest(cooldown_until,(p_args->>'p_cooldown')::timestamptz) END WHERE connection_id=c.connection_id;
    RETURN 'true'::jsonb;
  END IF;
  RAISE EXCEPTION 'Unsupported invoice operation';
END $$;

-- Legacy consumers must not cancel/refund/re-parent a shared-charge booking
-- before the allocation-aware reversal operation authorizes that exact row.
CREATE FUNCTION public.event_funnel_booking_financial_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE fields text[]:=ARRAY['tenant_id','id','event_id','ticket_class_id','status','payment_method',
  'stripe_payment_intent_id','xero_invoice_id','quickbooks_invoice_id','total_cost','total_paid',
  'ticket_price','voucher_amount','training_fund_amount','account_amount','account_balance_amount'];
  k text;
BEGIN
  IF EXISTS(SELECT 1 FROM public.event_funnel_order_booking WHERE tenant_id=OLD.tenant_id
    AND booking_source=TG_TABLE_NAME AND booking_id=OLD.id) THEN
    IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Shared checkout requires allocation-aware cancellation' USING ERRCODE='PT409'; END IF;
    FOREACH k IN ARRAY fields LOOP
      IF to_jsonb(OLD)->k IS DISTINCT FROM to_jsonb(NEW)->k THEN
        RAISE EXCEPTION 'Shared checkout requires allocation-aware financial changes' USING ERRCODE='PT409';
      END IF;
    END LOOP;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER event_funnel_financial_guard BEFORE UPDATE OR DELETE ON public.booking
  FOR EACH ROW EXECUTE FUNCTION public.event_funnel_booking_financial_guard();
CREATE TRIGGER event_funnel_financial_guard BEFORE UPDATE OR DELETE ON public.complex_event_booking
  FOR EACH ROW EXECUTE FUNCTION public.event_funnel_booking_financial_guard();
CREATE FUNCTION public.event_funnel_legacy_reversal_allowed(p_tenant uuid,p_source text,p_ids uuid[])
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF p_tenant IS NULL OR p_source IS NULL OR p_source NOT IN ('booking','complex_event_booking')
    OR p_ids IS NULL OR cardinality(p_ids)<1 OR cardinality(p_ids)>1000 OR array_position(p_ids,NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'Invalid booking scope' USING ERRCODE='22023';
  END IF;
  RETURN NOT EXISTS(SELECT 1 FROM public.event_funnel_order_booking WHERE tenant_id=p_tenant
    AND booking_source=p_source AND booking_id=ANY(p_ids));
END $$;
REVOKE ALL ON FUNCTION public.event_funnel_invoice_enqueue(uuid,uuid,uuid),
  public.event_funnel_invoice_operation(text,jsonb),public.event_funnel_booking_financial_guard(),
  public.event_funnel_legacy_reversal_allowed(uuid,text,uuid[]) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.event_funnel_invoice_enqueue(uuid,uuid,uuid),
  public.event_funnel_invoice_operation(text,jsonb),public.event_funnel_legacy_reversal_allowed(uuid,text,uuid[]) TO service_role;
COMMIT;
