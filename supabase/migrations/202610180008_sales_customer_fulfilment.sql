-- Future acceptance only: no historical INSERT/SELECT backfill.
CREATE TABLE public.sales_customer_fulfilment (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL,
 sale_id uuid NOT NULL,
 customer_email text,
 customer_name text NOT NULL DEFAULT '',
 token_hash text UNIQUE,
 expires_at timestamptz NOT NULL DEFAULT now()+interval '30 days',
 revoked_at timestamptz,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sending','sent','attention')),
 lease_token uuid,
 lease_until timestamptz,
 next_attempt_at timestamptz NOT NULL DEFAULT now(),
 attempts integer NOT NULL DEFAULT 0,
 last_error text,
 sent_at timestamptz,
 UNIQUE(tenant_id,sale_id),
 FOREIGN KEY(tenant_id,sale_id) REFERENCES public.sales_commercial_sale(tenant_id,id),
 CHECK(token_hash IS NULL OR token_hash ~ '^[a-f0-9]{64}$')
);
ALTER TABLE public.sales_customer_fulfilment ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.sales_customer_fulfilment FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE ON public.sales_customer_fulfilment TO service_role;
CREATE POLICY sales_customer_fulfilment_service ON public.sales_customer_fulfilment
 TO service_role USING(true) WITH CHECK(true);
CREATE FUNCTION public.guard_sales_customer_fulfilment() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF (NEW.tenant_id,NEW.sale_id,NEW.customer_email,NEW.customer_name,NEW.expires_at)
 IS DISTINCT FROM (OLD.tenant_id,OLD.sale_id,OLD.customer_email,OLD.customer_name,OLD.expires_at)
 OR (OLD.token_hash IS NOT NULL AND NEW.token_hash IS DISTINCT FROM OLD.token_hash) THEN
 RAISE EXCEPTION 'Accepted customer fulfilment identity is immutable' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER sales_customer_fulfilment_immutable BEFORE UPDATE ON public.sales_customer_fulfilment
 FOR EACH ROW EXECUTE FUNCTION public.guard_sales_customer_fulfilment();

CREATE FUNCTION public.enqueue_sales_customer_fulfilment() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 -- Deferred until the entire acceptance transaction (including every allocation)
 -- commits. The accepted version, never a mutable CRM contact, owns delivery.
 INSERT INTO public.sales_customer_fulfilment(tenant_id,sale_id,customer_email,customer_name)
 SELECT s.tenant_id,s.id,
   COALESCE(dt.recipient_email,v.customer_contact_snapshot->>'email',v.customer_contact_snapshot->>'email_address'),
   COALESCE(d.customer_name,v.customer_contact_snapshot->>'name',
     concat_ws(' ',COALESCE(v.customer_contact_snapshot->>'first_name',v.customer_contact_snapshot->>'firstName'),
       COALESCE(v.customer_contact_snapshot->>'last_name',v.customer_contact_snapshot->>'lastName')),'')
 FROM public.sales_commercial_sale s JOIN public.sales_quote_version v
 ON v.tenant_id=s.tenant_id AND v.id=s.quote_version_id
 LEFT JOIN public.sales_quote_customer_decision d ON d.tenant_id=v.tenant_id
 AND d.quote_version_id=v.id AND d.decision='accepted'
 LEFT JOIN public.sales_quote_delivery_token dt ON dt.tenant_id=d.tenant_id AND dt.id=d.token_id
 WHERE s.tenant_id=NEW.tenant_id AND s.id=NEW.sale_id
 ON CONFLICT(tenant_id,sale_id) DO NOTHING;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER sales_customer_fulfilment_enqueue
 AFTER INSERT ON public.sales_commercial_allocation DEFERRABLE INITIALLY DEFERRED
 FOR EACH ROW EXECUTE FUNCTION public.enqueue_sales_customer_fulfilment();

-- Staff acceptance of ticket proposals must allocate in the same transaction,
-- just as public/signing acceptance already does. Leave non-ticket legacy flows.
DO $migration$
DECLARE definition text; anchor text := 'IF p_status=''accepted'' AND v.billing_schedule IS NOT NULL THEN';
BEGIN
 SELECT pg_get_functiondef('public.transition_sales_quote(uuid,uuid,integer,text,text,text,text)'::regprocedure) INTO definition;
 IF position(anchor IN definition)=0 THEN RAISE EXCEPTION 'Unknown staff acceptance implementation'; END IF;
 EXECUTE replace(definition,anchor,$replacement$
 IF p_status='accepted' AND (v.billing_schedule IS NOT NULL OR EXISTS(
 SELECT 1 FROM public.sales_quote_line l
 LEFT JOIN public.sales_catalogue_product p ON p.tenant_id=l.tenant_id AND p.id=l.product_id
 LEFT JOIN public.sales_quote_bundle_component c ON c.tenant_id=l.tenant_id AND c.quote_line_id=l.id
 LEFT JOIN public.sales_catalogue_product cp ON cp.tenant_id=c.tenant_id AND cp.id=c.product_id
 WHERE l.tenant_id=p_tenant_id AND l.quote_version_id=v.id
 AND (NULLIF(l.catalogue_snapshot->>'event_id','') IS NOT NULL OR NULLIF(c.product_snapshot->>'event_id','') IS NOT NULL))) THEN
 $replacement$);
END $migration$;

CREATE FUNCTION public.claim_sales_customer_fulfilment(p_id uuid,p_hash text,p_lease uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r public.sales_customer_fulfilment%ROWTYPE;
BEGIN
 IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'service role required' USING ERRCODE='42501'; END IF;
 IF p_hash IS NULL OR p_hash !~ '^[a-f0-9]{64}$' OR p_lease IS NULL THEN
 RAISE EXCEPTION 'invalid claim' USING ERRCODE='22023'; END IF;
 -- An expired sending lease is uncertain, not safe to resend automatically.
 UPDATE public.sales_customer_fulfilment SET status='attention',last_error='Delivery outcome unknown'
 WHERE id=p_id AND status='sending' AND lease_until<now();
 UPDATE public.sales_customer_fulfilment SET status='sending',lease_token=p_lease,
 lease_until=now()+interval '5 minutes',attempts=attempts+1,token_hash=p_hash
 WHERE id=p_id AND status='pending' AND next_attempt_at<=now()
 AND revoked_at IS NULL AND expires_at>now() AND (token_hash IS NULL OR token_hash=p_hash)
 RETURNING * INTO r;
 IF NOT FOUND THEN RETURN NULL; END IF;
 RETURN to_jsonb(r);
END $$;

CREATE FUNCTION public.finish_sales_customer_fulfilment(p_id uuid,p_lease uuid,p_outcome text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'service role required' USING ERRCODE='42501'; END IF;
 IF p_outcome NOT IN ('sent','pending','attention') THEN RAISE EXCEPTION 'invalid outcome'; END IF;
 UPDATE public.sales_customer_fulfilment SET status=p_outcome,
 sent_at=CASE WHEN p_outcome='sent' THEN now() ELSE sent_at END,
 last_error=CASE WHEN p_outcome='sent' THEN NULL WHEN p_outcome='pending'
 THEN 'Delivery rejected; scheduled for retry' ELSE 'Delivery outcome unknown; review required' END,
 next_attempt_at=now()+interval '5 minutes',lease_until=NULL,lease_token=NULL
 WHERE id=p_id AND status='sending' AND lease_token=p_lease AND lease_until>now();
 RETURN FOUND;
END $$;

CREATE FUNCTION public.resolve_sales_customer_fulfilment(p_tenant uuid,p_hash text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r public.sales_customer_fulfilment%ROWTYPE;
BEGIN
 IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'service role required' USING ERRCODE='42501'; END IF;
 SELECT * INTO r FROM public.sales_customer_fulfilment
 WHERE tenant_id=p_tenant AND token_hash=p_hash AND status='sent' AND sent_at IS NOT NULL
 AND revoked_at IS NULL AND expires_at>now();
 IF NOT FOUND THEN RAISE EXCEPTION 'Registration link is unavailable or expired' USING ERRCODE='P0002'; END IF;
 RETURN to_jsonb(r);
END $$;

CREATE FUNCTION public.reserve_sales_customer_delegate(p_tenant uuid,p_hash text,p_allocation uuid,
 p_invite_hash text,p_email text,p_first text,p_last text,p_key text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r public.sales_customer_fulfilment%ROWTYPE; existing public.sales_commercial_allocation_invitation%ROWTYPE;
BEGIN
 IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'service role required' USING ERRCODE='42501'; END IF;
 SELECT * INTO r FROM public.sales_customer_fulfilment
 WHERE tenant_id=p_tenant AND token_hash=p_hash AND status='sent' AND sent_at IS NOT NULL
 AND revoked_at IS NULL AND expires_at>now() FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Registration link is unavailable or expired' USING ERRCODE='P0002'; END IF;
 PERFORM 1 FROM public.sales_commercial_allocation WHERE tenant_id=p_tenant
 AND sale_id=r.sale_id AND id=p_allocation;
 IF NOT FOUND THEN RAISE EXCEPTION 'Allocation not found' USING ERRCODE='P0002'; END IF;
 -- Serialize same-key commands before checking the immutable delegate binding.
 PERFORM pg_advisory_xact_lock(hashtextextended(r.id::text||':'||p_allocation::text||':'||p_key,0));
 SELECT * INTO existing FROM public.sales_commercial_allocation_invitation
 WHERE tenant_id=p_tenant AND allocation_id=p_allocation AND actor_kind='tenant_user'
 AND actor_id=r.id AND idempotency_key=p_key;
 IF FOUND AND (existing.token_hash IS DISTINCT FROM decode(p_invite_hash,'hex')
 OR existing.delegate_email IS DISTINCT FROM lower(btrim(p_email))
 OR existing.delegate_first_name IS DISTINCT FROM NULLIF(p_first,'')
 OR existing.delegate_last_name IS DISTINCT FROM NULLIF(p_last,'')) THEN
 RAISE EXCEPTION 'Idempotency key belongs to another delegate' USING ERRCODE='23514'; END IF;
 -- Internal service principal is the fulfilment record, never a supplied user.
 -- Reuse the established invitation capacity lock, expiry and replay guards.
 RETURN public.reserve_sales_allocation_invitation(p_tenant,p_allocation,p_invite_hash,
 lower(btrim(p_email)),NULLIF(p_first,''),NULLIF(p_last,''),LEAST(r.expires_at,now()+interval '29 days'),
 p_key,'tenant_user',r.id);
END $$;
REVOKE ALL ON FUNCTION public.enqueue_sales_customer_fulfilment() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.claim_sales_customer_fulfilment(uuid,text,uuid),
 public.finish_sales_customer_fulfilment(uuid,uuid,text),
 public.resolve_sales_customer_fulfilment(uuid,text),
 public.reserve_sales_customer_delegate(uuid,text,uuid,text,text,text,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.claim_sales_customer_fulfilment(uuid,text,uuid),
 public.finish_sales_customer_fulfilment(uuid,uuid,text),
 public.resolve_sales_customer_fulfilment(uuid,text),
 public.reserve_sales_customer_delegate(uuid,text,uuid,text,text,text,text,text) TO service_role;
