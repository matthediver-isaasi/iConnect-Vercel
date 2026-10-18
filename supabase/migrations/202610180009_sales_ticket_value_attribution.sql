-- New allocations only: never reconstruct historical commercial value.
ALTER TABLE public.sales_commercial_allocation ADD COLUMN proposal_value_snapshot jsonb;

CREATE OR REPLACE FUNCTION public.freeze_sales_allocation_value()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE l public.sales_quote_line%ROWTYPE; v public.sales_quote_version%ROWTYPE;
DECLARE c record; weight numeric; total_weight numeric:=0; preceding_weight numeric:=0;
DECLARE own_weight numeric; n bigint; t bigint;
BEGIN
 SELECT * INTO STRICT l FROM public.sales_quote_line WHERE tenant_id=NEW.tenant_id AND id=NEW.quote_line_id;
 SELECT * INTO STRICT v FROM public.sales_quote_version WHERE tenant_id=NEW.tenant_id AND id=l.quote_version_id;
 IF v.status NOT IN ('accepted','converted') THEN
  RAISE EXCEPTION 'Allocation value requires an accepted proposal' USING ERRCODE='23514';
 END IF;
 n:=l.net_minor; t:=l.tax_minor;
 IF NEW.bundle_component_id IS NOT NULL THEN
  -- Include NON-ticket components in the denominator. Prices are the agreed
  -- component catalogue snapshots, never today's mutable product prices.
  FOR c IN SELECT * FROM public.sales_quote_bundle_component
    WHERE tenant_id=NEW.tenant_id AND quote_line_id=l.id ORDER BY display_order,id
  LOOP
   IF COALESCE(c.product_snapshot->>'standard_price_minor','') !~ '^[0-9]+$' THEN
    RAISE EXCEPTION 'Bundle attribution requires frozen component price weights' USING ERRCODE='23514';
   END IF;
   weight:=(c.product_snapshot->>'standard_price_minor')::numeric*c.quantity;
   IF c.id=NEW.bundle_component_id THEN own_weight:=weight; preceding_weight:=total_weight; END IF;
   total_weight:=total_weight+weight;
  END LOOP;
  IF own_weight IS NULL OR total_weight<=0 THEN
   RAISE EXCEPTION 'Bundle attribution has ambiguous component price weights' USING ERRCODE='23514';
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
CREATE TRIGGER freeze_sales_allocation_value BEFORE INSERT ON public.sales_commercial_allocation
 FOR EACH ROW EXECUTE FUNCTION public.freeze_sales_allocation_value();

CREATE TABLE public.sales_allocation_ticket_value (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL,
 allocation_id uuid NOT NULL,
 invitation_id uuid NOT NULL UNIQUE,
 booking_kind text NOT NULL CHECK (booking_kind IN ('simple','complex')),
 booking_id uuid NOT NULL,
 place_index integer NOT NULL CHECK(place_index>0),
 currency text NOT NULL,
 net_minor bigint NOT NULL CHECK(net_minor>=0),
 tax_minor bigint NOT NULL CHECK(tax_minor>=0),
 gross_minor bigint NOT NULL CHECK(gross_minor=net_minor+tax_minor),
 source_snapshot jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,booking_kind,booking_id),
 UNIQUE(tenant_id,allocation_id,place_index),
 FOREIGN KEY(tenant_id,allocation_id) REFERENCES public.sales_commercial_allocation(tenant_id,id)
);
CREATE TRIGGER sales_allocation_ticket_value_immutable BEFORE UPDATE OR DELETE
 ON public.sales_allocation_ticket_value FOR EACH ROW EXECUTE FUNCTION public.guard_sales_commercial_append_only();

CREATE OR REPLACE FUNCTION public.attribute_sales_invitation_value()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE a public.sales_commercial_allocation%ROWTYPE; s jsonb; k integer; places integer; n bigint; t bigint;
DECLARE gross_total numeric; gross_before numeric; gross_after numeric;
BEGIN
 IF OLD.claimed_at IS NOT NULL OR NEW.claimed_at IS NULL THEN RETURN NEW; END IF;
 SELECT * INTO STRICT a FROM public.sales_commercial_allocation WHERE tenant_id=NEW.tenant_id AND id=NEW.allocation_id;
 s:=a.proposal_value_snapshot;
 -- Historical allocations deliberately remain unknown, not zero or guessed.
 IF s IS NULL THEN RETURN NEW; END IF;
 -- The claim has already locked booking then ticket; do not reverse that order.
 -- Serialize only attribution after those locks, including different invitations.
 PERFORM pg_advisory_xact_lock(hashtextextended('sales-value:'||a.id::text,0));
 SELECT COALESCE(max(place_index),0)+1 INTO k FROM public.sales_allocation_ticket_value
  WHERE tenant_id=NEW.tenant_id AND allocation_id=a.id;
 places:=(s->>'places')::integer;
 IF k>places THEN RAISE EXCEPTION 'Proposal attribution places exhausted' USING ERRCODE='23514'; END IF;
 gross_total:=(s->>'grossMinor')::numeric;
 gross_before:=floor(gross_total*(k-1)/places); gross_after:=floor(gross_total*k/places);
 n:=CASE WHEN gross_total=0 THEN 0 ELSE
   floor((s->>'netMinor')::numeric*gross_after/gross_total)
   -floor((s->>'netMinor')::numeric*gross_before/gross_total) END;
 t:=gross_after-gross_before-n;
 INSERT INTO public.sales_allocation_ticket_value(tenant_id,allocation_id,invitation_id,booking_kind,booking_id,
  place_index,currency,net_minor,tax_minor,gross_minor,source_snapshot)
 VALUES(NEW.tenant_id,a.id,NEW.id,NEW.booking_kind,NEW.booking_id,k,s->>'currency',n,t,n+t,s);
 RETURN NEW;
END $$;
CREATE TRIGGER attribute_sales_invitation_value AFTER UPDATE OF claimed_at ON public.sales_commercial_allocation_invitation
 FOR EACH ROW EXECUTE FUNCTION public.attribute_sales_invitation_value();
ALTER TABLE public.sales_allocation_ticket_value ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.sales_allocation_ticket_value FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.sales_allocation_ticket_value TO service_role;
REVOKE ALL ON FUNCTION public.freeze_sales_allocation_value(),public.attribute_sales_invitation_value() FROM PUBLIC,anon,authenticated;
