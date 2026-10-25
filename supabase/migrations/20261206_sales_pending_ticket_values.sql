BEGIN;
-- Preserve accepted evidence and immutable per-place ordinals. A later,
-- separately audited attribution never rewrites the agreement or payments.
CREATE TABLE public.sales_allocation_value_resolution (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL,
 allocation_id uuid NOT NULL UNIQUE,
 actor_id uuid NOT NULL,
 reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 2000),
 idempotency_key uuid NOT NULL,
 snapshot jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,idempotency_key),
 FOREIGN KEY(tenant_id,allocation_id) REFERENCES public.sales_commercial_allocation(tenant_id,id)
);
ALTER TABLE public.sales_allocation_value_resolution ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.sales_allocation_value_resolution FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.sales_allocation_value_resolution TO service_role;
CREATE TRIGGER sales_allocation_value_resolution_immutable BEFORE UPDATE OR DELETE
 ON public.sales_allocation_value_resolution FOR EACH ROW EXECUTE FUNCTION public.guard_sales_commercial_append_only();

ALTER TABLE public.sales_allocation_ticket_value ALTER COLUMN net_minor DROP NOT NULL,
 ALTER COLUMN tax_minor DROP NOT NULL, ALTER COLUMN gross_minor DROP NOT NULL;
ALTER TABLE public.sales_allocation_ticket_value ADD CONSTRAINT sales_ticket_value_known_or_pending CHECK(
 (net_minor IS NOT NULL AND tax_minor IS NOT NULL AND gross_minor IS NOT NULL)
 OR (net_minor IS NULL AND tax_minor IS NULL AND gross_minor IS NULL AND COALESCE(source_snapshot->>'status'='pending',false)));

CREATE OR REPLACE FUNCTION public.freeze_sales_allocation_value()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE l public.sales_quote_line%ROWTYPE; v public.sales_quote_version%ROWTYPE;
 c record; weight numeric; total_weight numeric:=0; preceding_weight numeric:=0;
 own_weight numeric; n bigint; t bigint; missing_weight boolean:=false; component_found boolean:=false;
BEGIN
 SELECT * INTO STRICT l FROM public.sales_quote_line WHERE tenant_id=NEW.tenant_id AND id=NEW.quote_line_id;
 SELECT * INTO STRICT v FROM public.sales_quote_version WHERE tenant_id=NEW.tenant_id AND id=l.quote_version_id;
 IF v.status NOT IN ('accepted','converted') THEN
  RAISE EXCEPTION 'Allocation value requires an accepted proposal' USING ERRCODE='23514';
 END IF;
 n:=l.net_minor; t:=l.tax_minor;
 IF NEW.bundle_component_id IS NOT NULL THEN
  FOR c IN SELECT * FROM public.sales_quote_bundle_component
   WHERE tenant_id=NEW.tenant_id AND quote_line_id=l.id ORDER BY display_order,id
  LOOP
   IF COALESCE(c.product_snapshot->>'standard_price_minor','') !~ '^[0-9]+$' THEN
    missing_weight:=true; weight:=0;
   ELSE weight:=(c.product_snapshot->>'standard_price_minor')::numeric*c.quantity;
   END IF;
   IF c.id=NEW.bundle_component_id THEN
    component_found:=true; own_weight:=weight; preceding_weight:=total_weight;
   END IF;
   total_weight:=total_weight+weight;
  END LOOP;
  IF NOT component_found THEN
   RAISE EXCEPTION 'Allocation component does not belong to proposal line' USING ERRCODE='23514';
  END IF;
  IF missing_weight OR total_weight<=0 THEN
   NEW.proposal_value_snapshot:=jsonb_build_object('version',2,'status','pending',
    'quoteVersionId',v.id,'quoteLineId',l.id,'componentId',NEW.bundle_component_id,
    'currency',v.currency,'places',NEW.allocated_places,'netMinor',NULL,'taxMinor',NULL,'grossMinor',NULL,
    'basis','pending_admin_allocation','lineNetMinor',l.net_minor,'lineTaxMinor',l.tax_minor);
   RETURN NEW;
  END IF;
  n:=floor(l.net_minor::numeric*(preceding_weight+own_weight)/total_weight)
    -floor(l.net_minor::numeric*preceding_weight/total_weight);
  t:=floor(l.tax_minor::numeric*(preceding_weight+own_weight)/total_weight)
    -floor(l.tax_minor::numeric*preceding_weight/total_weight);
 END IF;
 NEW.proposal_value_snapshot:=jsonb_build_object('version',1,'quoteVersionId',v.id,
  'quoteLineId',l.id,'componentId',NEW.bundle_component_id,'currency',v.currency,
  'places',NEW.allocated_places,'netMinor',n,'taxMinor',t,'grossMinor',n+t,
  'basis','accepted_line_after_discount','componentWeight',own_weight,'totalComponentWeight',total_weight);
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.attribute_sales_invitation_value()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE a public.sales_commercial_allocation%ROWTYPE; s jsonb; k integer; places integer; n bigint; t bigint;
 gross_total numeric; gross_before numeric; gross_after numeric;
BEGIN
 IF OLD.claimed_at IS NOT NULL OR NEW.claimed_at IS NULL THEN RETURN NEW; END IF;
 SELECT * INTO STRICT a FROM public.sales_commercial_allocation WHERE tenant_id=NEW.tenant_id AND id=NEW.allocation_id;
 s:=a.proposal_value_snapshot;
 IF s IS NULL THEN RETURN NEW; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('sales-value:'||a.id::text,0));
 SELECT COALESCE(max(place_index),0)+1 INTO k FROM public.sales_allocation_ticket_value
  WHERE tenant_id=NEW.tenant_id AND allocation_id=a.id;
 places:=(s->>'places')::integer;
 IF k>places THEN RAISE EXCEPTION 'Proposal attribution places exhausted' USING ERRCODE='23514'; END IF;
 -- Pending amounts remain NULL, including after resolution: reporting uses
 -- the append-only resolution plus this immutable place ordinal.
 IF s->>'status' IS DISTINCT FROM 'pending' THEN
  gross_total:=(s->>'grossMinor')::numeric;
  gross_before:=floor(gross_total*(k-1)/places); gross_after:=floor(gross_total*k/places);
  n:=CASE WHEN gross_total=0 THEN 0 ELSE
   floor((s->>'netMinor')::numeric*gross_after/gross_total)
   -floor((s->>'netMinor')::numeric*gross_before/gross_total) END;
  t:=gross_after-gross_before-n;
 END IF;
 INSERT INTO public.sales_allocation_ticket_value(tenant_id,allocation_id,invitation_id,booking_kind,booking_id,
  place_index,currency,net_minor,tax_minor,gross_minor,source_snapshot)
 VALUES(NEW.tenant_id,a.id,NEW.id,NEW.booking_kind,NEW.booking_id,k,s->>'currency',n,t,n+t,s);
 RETURN NEW;
END $$;

CREATE FUNCTION public.resolve_sales_allocation_value(p_tenant_id uuid,p_allocation_id uuid,
 p_actor_id uuid,p_net_minor bigint,p_reason text,p_idempotency_key uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE a public.sales_commercial_allocation%ROWTYPE; l public.sales_quote_line%ROWTYPE;
 existing public.sales_allocation_value_resolution%ROWTYPE; s jsonb; tax bigint; used numeric;
BEGIN
 IF p_actor_id IS NULL OR p_idempotency_key IS NULL OR p_net_minor IS NULL OR p_net_minor<0
  OR p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 1 AND 2000 THEN
  RAISE EXCEPTION 'A valid amount, reason and actor are required' USING ERRCODE='22023';
 END IF;
 SELECT * INTO STRICT a FROM public.sales_commercial_allocation WHERE tenant_id=p_tenant_id AND id=p_allocation_id;
 -- Serialize the shared line budget across all its ticket allocations.
 SELECT * INTO STRICT l FROM public.sales_quote_line WHERE tenant_id=p_tenant_id AND id=a.quote_line_id FOR UPDATE;
 SELECT * INTO existing FROM public.sales_allocation_value_resolution WHERE tenant_id=p_tenant_id AND allocation_id=a.id;
 IF FOUND THEN
  IF existing.idempotency_key=p_idempotency_key AND (existing.snapshot->>'netMinor')::bigint=p_net_minor
   AND existing.reason=btrim(p_reason) AND existing.actor_id=p_actor_id THEN RETURN existing.snapshot; END IF;
  RAISE EXCEPTION 'Ticket value has already been allocated' USING ERRCODE='23514';
 END IF;
 IF a.proposal_value_snapshot->>'status' IS DISTINCT FROM 'pending' THEN
  RAISE EXCEPTION 'Only pending ticket values can be allocated' USING ERRCODE='23514';
 END IF;
 SELECT COALESCE(sum(COALESCE(r.snapshot->>'netMinor',x.proposal_value_snapshot->>'netMinor')::numeric),0)
 INTO used FROM public.sales_commercial_allocation x
 LEFT JOIN public.sales_allocation_value_resolution r ON r.tenant_id=x.tenant_id AND r.allocation_id=x.id
 WHERE x.tenant_id=p_tenant_id AND x.quote_line_id=l.id;
 IF used+p_net_minor>l.net_minor THEN
  RAISE EXCEPTION 'Ticket values exceed the accepted bundle price' USING ERRCODE='23514';
 END IF;
 tax:=CASE WHEN l.net_minor=0 THEN 0 ELSE floor(l.tax_minor::numeric*p_net_minor/l.net_minor) END;
 s:=a.proposal_value_snapshot||jsonb_build_object('status','allocated','basis','admin_allocation',
  'netMinor',p_net_minor,'taxMinor',tax,'grossMinor',p_net_minor+tax);
 INSERT INTO public.sales_allocation_value_resolution(tenant_id,allocation_id,actor_id,reason,idempotency_key,snapshot)
 VALUES(p_tenant_id,a.id,p_actor_id,btrim(p_reason),p_idempotency_key,s);
 RETURN s;
END $$;
REVOKE ALL ON FUNCTION public.resolve_sales_allocation_value(uuid,uuid,uuid,bigint,text,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_sales_allocation_value(uuid,uuid,uuid,bigint,text,uuid) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
