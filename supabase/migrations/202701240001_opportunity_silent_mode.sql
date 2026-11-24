-- Forward-only policy. No historical delivery replay or financial writes.
BEGIN;
ALTER TABLE public.opportunity
  ADD COLUMN silent_mode boolean NOT NULL DEFAULT false,
  ADD COLUMN automatic_communications text[] NOT NULL DEFAULT '{}',
  ADD CONSTRAINT opportunity_automatic_communications_check CHECK (
    array_position(automatic_communications,NULL) IS NULL
    AND automatic_communications <@ ARRAY['agreement_sender','agreement_customer','invoice','customer_fulfilment']::text[]
    AND cardinality(automatic_communications)<=4
  );

ALTER TABLE public.sales_agreement_completion_notice
  DROP CONSTRAINT sales_agreement_completion_notice_status_check,
  ADD CONSTRAINT sales_agreement_completion_notice_status_check
    CHECK(status IN ('pending','sending','sent','failed','suppressed')),
  ADD COLUMN suppressed_at timestamptz;
ALTER TABLE public.sales_invoice_schedule
  DROP CONSTRAINT sales_invoice_schedule_delivery_status_check,
  ADD CONSTRAINT sales_invoice_schedule_delivery_status_check
    CHECK(delivery_status IN ('pending','sending','sent','rejected','attention','suppressed')),
  ADD COLUMN suppressed_at timestamptz;
ALTER TABLE public.sales_customer_fulfilment
  DROP CONSTRAINT sales_customer_fulfilment_status_check,
  ADD CONSTRAINT sales_customer_fulfilment_status_check
    CHECK(status IN ('pending','sending','sent','attention','suppressed')),
  ADD COLUMN suppressed_at timestamptz;

CREATE FUNCTION public.set_opportunity_silent_mode(
  p_tenant uuid,p_opportunity uuid,p_version integer,p_enabled boolean,p_allowed text[],
  p_actor_kind text,p_actor_id uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE o public.opportunity%ROWTYPE; previous jsonb;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE='42501';
  END IF;
  IF p_enabled IS NULL OR p_allowed IS NULL OR array_position(p_allowed,NULL) IS NOT NULL
    OR NOT p_allowed <@ ARRAY['agreement_sender','agreement_customer','invoice','customer_fulfilment']::text[]
    OR cardinality(p_allowed)<>(SELECT count(DISTINCT value) FROM unnest(p_allowed) value)
    OR p_actor_kind IS NULL OR p_actor_kind NOT IN ('member','tenant_user') OR p_actor_id IS NULL THEN
    RAISE EXCEPTION 'Invalid communication policy' USING ERRCODE='22023';
  END IF;
  SELECT * INTO o FROM public.opportunity WHERE tenant_id=p_tenant AND id=p_opportunity FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Opportunity not found' USING ERRCODE='P0002'; END IF;
  IF p_version IS NULL OR o.version<>p_version THEN
    RAISE EXCEPTION 'Opportunity was updated by another user' USING ERRCODE='PT409';
  END IF;
  previous=jsonb_build_object('silentMode',o.silent_mode,'automaticCommunications',o.automatic_communications);
  UPDATE public.opportunity SET silent_mode=p_enabled,automatic_communications=p_allowed,
    version=version+1,updated_at=now()
    WHERE tenant_id=p_tenant AND id=p_opportunity RETURNING * INTO o;
  INSERT INTO public.opportunity_activity
    (tenant_id,opportunity_id,organization_id,actor_kind,actor_id,action,summary,metadata)
    VALUES(p_tenant,o.id,o.organization_id,p_actor_kind,p_actor_id,
      'opportunity.silent_mode.updated','Automatic communication settings updated',
      jsonb_build_object('before',previous,'after',
        jsonb_build_object('silentMode',o.silent_mode,'automaticCommunications',o.automatic_communications)));
  RETURN to_jsonb(o);
END $$;
REVOKE ALL ON FUNCTION public.set_opportunity_silent_mode(uuid,uuid,integer,boolean,text[],text,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.set_opportunity_silent_mode(uuid,uuid,integer,boolean,text[],text,uuid) TO service_role;

-- Call only with the existing delivery lease immediately before the provider.
-- Locks serialize policy decisions with edits; dispatch already begun cannot be recalled.
-- Suppression updates the original occurrence and activity in one transaction.
CREATE FUNCTION public.check_sales_automatic_delivery(p_tenant uuid,p_category text,p_id uuid,p_claim text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE opportunity_id uuid; o public.opportunity%ROWTYPE; party_name text;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE='42501';
  END IF;
  IF p_category IN ('agreement_sender','agreement_customer') THEN
    party_name=CASE WHEN p_category='agreement_sender' THEN 'sender' ELSE 'customer' END;
    SELECT q.opportunity_id INTO opportunity_id
      FROM public.sales_agreement_completion_notice n
      JOIN public.sales_agreement_envelope e ON e.id=n.envelope_id
      JOIN public.sales_quote q ON q.id=e.quote_id AND q.tenant_id=e.tenant_id
      WHERE e.tenant_id=p_tenant AND e.id=p_id AND n.party=party_name
        AND n.status='sending' AND n.attempts::text=p_claim AND n.lease_until>now()
      FOR UPDATE OF n;
  ELSIF p_category='invoice' THEN
    SELECT s.opportunity_id INTO opportunity_id
      FROM public.sales_invoice_schedule d
      JOIN public.sales_commercial_sale s ON s.id=d.sale_id AND s.tenant_id=d.tenant_id
      WHERE d.tenant_id=p_tenant AND d.id=p_id AND d.status='invoiced'
        AND d.delivery_status='sending' AND d.delivery_claim_token::text=p_claim
        AND d.delivery_claimed_at>now()-interval '15 minutes'
      FOR UPDATE OF d;
  ELSIF p_category='customer_fulfilment' THEN
    SELECT s.opportunity_id INTO opportunity_id
      FROM public.sales_customer_fulfilment d
      JOIN public.sales_commercial_sale s ON s.id=d.sale_id AND s.tenant_id=d.tenant_id
      WHERE d.tenant_id=p_tenant AND d.id=p_id AND d.status='sending'
        AND d.lease_token::text=p_claim AND d.lease_until>now()
        AND d.revoked_at IS NULL AND d.expires_at>now()
      FOR UPDATE OF d;
  ELSE
    RAISE EXCEPTION 'Unknown automatic communication' USING ERRCODE='22023';
  END IF;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Delivery linkage or lease unavailable' USING ERRCODE='PT409';
  END IF;
  -- Standalone quotes/sales are valid and have no opportunity policy.
  IF opportunity_id IS NULL THEN RETURN 'permitted'; END IF;
  SELECT * INTO o FROM public.opportunity
    WHERE tenant_id=p_tenant AND id=opportunity_id FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Opportunity policy unavailable' USING ERRCODE='P0002'; END IF;
  IF NOT o.silent_mode OR p_category=ANY(o.automatic_communications) THEN RETURN 'permitted'; END IF;
  IF p_category IN ('agreement_sender','agreement_customer') THEN
    UPDATE public.sales_agreement_completion_notice
      SET status='suppressed',suppressed_at=now(),lease_until=NULL,last_error=NULL
      WHERE envelope_id=p_id AND party=party_name;
  ELSIF p_category='invoice' THEN
    UPDATE public.sales_invoice_schedule
      SET delivery_status='suppressed',suppressed_at=now(),delivery_claim_token=NULL,
        delivery_claimed_at=NULL,last_error=NULL,updated_at=now()
      WHERE tenant_id=p_tenant AND id=p_id;
  ELSE
    UPDATE public.sales_customer_fulfilment
      SET status='suppressed',suppressed_at=now(),lease_token=NULL,lease_until=NULL,last_error=NULL
      WHERE tenant_id=p_tenant AND id=p_id;
  END IF;
  INSERT INTO public.opportunity_activity
    (tenant_id,opportunity_id,organization_id,actor_kind,actor_id,action,summary,metadata)
    VALUES(p_tenant,o.id,o.organization_id,'system',o.id,'sales.communication.suppressed',
      'Automatic communication suppressed by Silent mode',
      jsonb_build_object('category',p_category,'occurrenceId',p_id,'policyVersion',o.version));
  RETURN 'suppressed';
END $$;
REVOKE ALL ON FUNCTION public.check_sales_automatic_delivery(uuid,text,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.check_sales_automatic_delivery(uuid,text,uuid,text) TO service_role;

CREATE OR REPLACE FUNCTION public.claim_sales_agreement_completion_notice(p_envelope_id uuid,p_party text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE e public.sales_agreement_envelope%ROWTYPE; n public.sales_agreement_completion_notice%ROWTYPE;
BEGIN
 IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'service role required' USING ERRCODE='42501'; END IF;
 IF p_party IS NULL OR p_party NOT IN ('sender','customer') THEN RAISE EXCEPTION 'Invalid party' USING ERRCODE='22023'; END IF;
 SELECT * INTO e FROM public.sales_agreement_envelope WHERE id=p_envelope_id;
 IF e.id IS NULL OR e.finalization_status<>'complete' THEN RETURN NULL; END IF;
 INSERT INTO public.sales_agreement_completion_notice(envelope_id,party,recipient_email)
 VALUES(e.id,p_party,CASE WHEN p_party='sender' THEN e.sender->>'email' ELSE e.customer->>'email' END)
 ON CONFLICT(envelope_id,party) DO NOTHING;
 SELECT * INTO n FROM public.sales_agreement_completion_notice WHERE envelope_id=e.id AND party=p_party FOR UPDATE;
 IF n.status IN ('sent','suppressed') OR n.lease_until>now() THEN RETURN NULL; END IF;
 UPDATE public.sales_agreement_completion_notice SET status='sending',attempts=attempts+1,lease_until=now()+interval '2 minutes',last_error=NULL
 WHERE envelope_id=e.id AND party=p_party RETURNING * INTO n;
 RETURN to_jsonb(n);
END $$;
REVOKE ALL ON FUNCTION public.claim_sales_agreement_completion_notice(uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.claim_sales_agreement_completion_notice(uuid,text) TO service_role;
COMMIT;
