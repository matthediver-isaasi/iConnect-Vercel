-- Versioned, immutable, tenant-scoped Sales quotations.
CREATE TABLE public.sales_quote (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenant(id) ON DELETE CASCADE,
  quote_number varchar(64), opportunity_id uuid, current_version integer NOT NULL DEFAULT 1,
  row_version integer NOT NULL DEFAULT 1, created_by text NOT NULL, updated_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sales_quote_tenant_id_unique UNIQUE (tenant_id,id),
  CONSTRAINT sales_quote_tenant_number_unique UNIQUE (tenant_id,quote_number),
  CONSTRAINT sales_quote_opportunity_fk FOREIGN KEY (tenant_id,opportunity_id) REFERENCES public.opportunity(tenant_id,id) ON DELETE RESTRICT,
  CHECK (current_version > 0 AND row_version > 0)
);

CREATE TABLE public.sales_quote_version (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, quote_id uuid NOT NULL,
  version_number integer NOT NULL, status varchar(30) NOT NULL DEFAULT 'draft',
  currency varchar(3) NOT NULL, organisation_snapshot jsonb, customer_contact_snapshot jsonb, billing_contact_snapshot jsonb,
  address_snapshot jsonb, event_snapshot jsonb, terms_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  salesperson_snapshot jsonb, issue_date date, valid_until timestamptz, purchase_order_reference text, customer_reference text, tax_treatment varchar(30), payment_terms text, notes text,
  net_minor bigint NOT NULL DEFAULT 0, tax_minor bigint NOT NULL DEFAULT 0, gross_minor bigint NOT NULL DEFAULT 0,
  issued_at timestamptz, created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sales_quote_version_tenant_id_unique UNIQUE (tenant_id,id),
  CONSTRAINT sales_quote_version_number_unique UNIQUE (tenant_id,quote_id,version_number),
  CONSTRAINT sales_quote_version_quote_fk FOREIGN KEY (tenant_id,quote_id) REFERENCES public.sales_quote(tenant_id,id) ON DELETE CASCADE,
  CHECK (version_number > 0),
  CHECK (status IN ('draft','issued','sent','accepted','declined','expired','superseded','converted')),
  CHECK (currency ~ '^[A-Z]{3}$' AND net_minor >= 0 AND tax_minor >= 0 AND gross_minor = net_minor + tax_minor),
  CHECK (jsonb_typeof(terms_snapshot) = 'object')
);

CREATE TABLE public.sales_quote_line (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, quote_version_id uuid NOT NULL,
  display_order integer NOT NULL, catalogue_kind varchar(20) NOT NULL, catalogue_id uuid,
  product_id uuid, bundle_id uuid,
  catalogue_snapshot jsonb, description text NOT NULL, quantity numeric(24,6) NOT NULL,
  standard_unit_price_minor bigint NOT NULL, quoted_unit_price_minor bigint NOT NULL,
  price_overridden boolean NOT NULL DEFAULT false, discount_bps integer NOT NULL DEFAULT 0, tax_rate_bps integer NOT NULL,
  net_minor bigint NOT NULL, tax_minor bigint NOT NULL, gross_minor bigint NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sales_quote_line_tenant_id_unique UNIQUE (tenant_id,id),
  CONSTRAINT sales_quote_line_order_unique UNIQUE (tenant_id,quote_version_id,display_order),
  CONSTRAINT sales_quote_line_version_fk FOREIGN KEY (tenant_id,quote_version_id) REFERENCES public.sales_quote_version(tenant_id,id) ON DELETE CASCADE,
  CONSTRAINT sales_quote_line_product_fk FOREIGN KEY (tenant_id,product_id) REFERENCES public.sales_catalogue_product(tenant_id,id) ON DELETE RESTRICT,
  CONSTRAINT sales_quote_line_bundle_fk FOREIGN KEY (tenant_id,bundle_id) REFERENCES public.sales_catalogue_bundle(tenant_id,id) ON DELETE RESTRICT,
  CHECK (display_order >= 0 AND quantity > 0 AND
    ((catalogue_kind='product' AND product_id=catalogue_id AND bundle_id IS NULL) OR
     (catalogue_kind='bundle' AND bundle_id=catalogue_id AND product_id IS NULL) OR
     (catalogue_kind='free_text' AND catalogue_id IS NULL AND product_id IS NULL AND bundle_id IS NULL))),
  CHECK (catalogue_snapshot IS NULL OR jsonb_typeof(catalogue_snapshot) = 'object'),
  CHECK (standard_unit_price_minor >= 0 AND quoted_unit_price_minor >= 0 AND price_overridden = (standard_unit_price_minor <> quoted_unit_price_minor)),
  CHECK (discount_bps BETWEEN 0 AND 10000 AND tax_rate_bps BETWEEN 0 AND 100000 AND net_minor >= 0 AND tax_minor >= 0 AND gross_minor = net_minor + tax_minor)
);

CREATE TABLE public.sales_quote_bundle_component (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, quote_line_id uuid NOT NULL,
  display_order integer NOT NULL, product_id uuid NOT NULL, quantity integer NOT NULL, product_snapshot jsonb NOT NULL,
  CONSTRAINT sales_quote_bundle_component_order_unique UNIQUE (tenant_id,quote_line_id,display_order),
  CONSTRAINT sales_quote_bundle_component_line_fk FOREIGN KEY (tenant_id,quote_line_id) REFERENCES public.sales_quote_line(tenant_id,id) ON DELETE CASCADE,
  CONSTRAINT sales_quote_bundle_component_product_fk FOREIGN KEY (tenant_id,product_id) REFERENCES public.sales_catalogue_product(tenant_id,id) ON DELETE RESTRICT,
  CHECK (display_order >= 0 AND quantity > 0 AND jsonb_typeof(product_snapshot) = 'object')
);

CREATE TABLE public.sales_quote_status_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL, quote_id uuid NOT NULL,
  quote_version_id uuid NOT NULL, from_status varchar(30), to_status varchar(30) NOT NULL,
  actor_id text NOT NULL, actor_type varchar(30) NOT NULL, note text, created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sales_quote_history_quote_fk FOREIGN KEY (tenant_id,quote_id) REFERENCES public.sales_quote(tenant_id,id) ON DELETE CASCADE,
  CONSTRAINT sales_quote_history_version_fk FOREIGN KEY (tenant_id,quote_version_id) REFERENCES public.sales_quote_version(tenant_id,id) ON DELETE CASCADE,
  CHECK (actor_type IN ('tenant_user','member','system')),
  CHECK (to_status IN ('draft','issued','sent','accepted','declined','expired','superseded','converted'))
);

CREATE INDEX idx_sales_quote_tenant_updated ON public.sales_quote(tenant_id,updated_at DESC);
CREATE INDEX idx_sales_quote_version_quote ON public.sales_quote_version(tenant_id,quote_id,version_number DESC);
CREATE INDEX idx_sales_quote_history ON public.sales_quote_status_history(tenant_id,quote_id,created_at);

CREATE OR REPLACE FUNCTION public.guard_issued_quote_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path=public AS $$
BEGIN
  IF TG_OP = 'DELETE' OR (OLD.status <> 'draft' AND
    (to_jsonb(NEW)-'status'-'updated_at') <> (to_jsonb(OLD)-'status'-'updated_at')) THEN
    RAISE EXCEPTION 'Issued quote versions are immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER sales_quote_version_immutable BEFORE UPDATE OR DELETE ON public.sales_quote_version
  FOR EACH ROW EXECUTE FUNCTION public.guard_issued_quote_immutable();

CREATE OR REPLACE FUNCTION public.guard_quote_child_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path=public AS $$
DECLARE v_status text;
BEGIN
  IF TG_OP IN ('UPDATE','DELETE') THEN
    SELECT status INTO v_status FROM public.sales_quote_version
      WHERE tenant_id=OLD.tenant_id AND id=OLD.quote_version_id;
    IF v_status <> 'draft' THEN RAISE EXCEPTION 'Issued quote lines are immutable' USING ERRCODE='23514'; END IF;
  END IF;
  IF TG_OP IN ('INSERT','UPDATE') THEN
    SELECT status INTO v_status FROM public.sales_quote_version
      WHERE tenant_id=NEW.tenant_id AND id=NEW.quote_version_id;
    IF v_status <> 'draft' THEN RAISE EXCEPTION 'Issued quote lines are immutable' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER sales_quote_line_immutable BEFORE INSERT OR UPDATE OR DELETE ON public.sales_quote_line
  FOR EACH ROW EXECUTE FUNCTION public.guard_quote_child_immutable();

CREATE OR REPLACE FUNCTION public.guard_quote_component_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path=public AS $$
DECLARE s text;
BEGIN
 IF TG_OP IN ('UPDATE','DELETE') THEN
   SELECT v.status INTO s FROM public.sales_quote_line l JOIN public.sales_quote_version v
     ON v.tenant_id=l.tenant_id AND v.id=l.quote_version_id
   WHERE l.tenant_id=OLD.tenant_id AND l.id=OLD.quote_line_id;
   IF s <> 'draft' THEN RAISE EXCEPTION 'Issued bundle snapshots are immutable' USING ERRCODE='23514'; END IF;
 END IF;
 IF TG_OP IN ('INSERT','UPDATE') THEN
   SELECT v.status INTO s FROM public.sales_quote_line l JOIN public.sales_quote_version v
     ON v.tenant_id=l.tenant_id AND v.id=l.quote_version_id
   WHERE l.tenant_id=NEW.tenant_id AND l.id=NEW.quote_line_id;
   IF s <> 'draft' THEN RAISE EXCEPTION 'Issued bundle snapshots are immutable' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER sales_quote_component_immutable BEFORE INSERT OR UPDATE OR DELETE ON public.sales_quote_bundle_component
  FOR EACH ROW EXECUTE FUNCTION public.guard_quote_component_immutable();

CREATE OR REPLACE FUNCTION public.guard_quote_history_append_only() RETURNS trigger
LANGUAGE plpgsql SET search_path=public AS $$
BEGIN RAISE EXCEPTION 'Quote status history is append-only' USING ERRCODE='23514'; END $$;
CREATE TRIGGER sales_quote_history_immutable BEFORE UPDATE OR DELETE ON public.sales_quote_status_history
  FOR EACH ROW EXECUTE FUNCTION public.guard_quote_history_append_only();

CREATE OR REPLACE FUNCTION public.save_sales_quote_draft(
 p_tenant_id uuid,p_quote_id uuid,p_expected_version integer,p_payload jsonb,p_actor_id text,p_actor_type text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE q public.sales_quote%ROWTYPE; v public.sales_quote_version%ROWTYPE; item jsonb; component jsonb; line_id uuid; i integer:=0; j integer;
DECLARE calc_net bigint:=0; calc_tax bigint:=0; calc_gross bigint:=0; line_net bigint; line_tax bigint; qty numeric; unit bigint; rate integer;
BEGIN
 IF auth.role()<>'service_role' THEN RAISE EXCEPTION 'service role required' USING ERRCODE='42501'; END IF;
 IF p_tenant_id IS NULL OR p_actor_id IS NULL OR p_actor_type NOT IN ('tenant_user','member','system')
    OR jsonb_typeof(p_payload)<>'object' OR jsonb_typeof(p_payload->'lines')<>'array' OR jsonb_array_length(p_payload->'lines')=0
 THEN RAISE EXCEPTION 'invalid quote draft' USING ERRCODE='22023'; END IF;
 IF p_quote_id IS NULL THEN
   INSERT INTO public.sales_quote(tenant_id,opportunity_id,created_by,updated_by)
   VALUES(p_tenant_id,(p_payload->>'opportunityId')::uuid,p_actor_id,p_actor_id) RETURNING * INTO q;
   INSERT INTO public.sales_quote_version(tenant_id,quote_id,version_number,currency,organisation_snapshot,customer_contact_snapshot,billing_contact_snapshot,address_snapshot,event_snapshot,terms_snapshot,salesperson_snapshot,issue_date,valid_until,purchase_order_reference,customer_reference,tax_treatment,payment_terms,notes,created_by)
   VALUES(p_tenant_id,q.id,1,p_payload->>'currency',p_payload->'organisationSnapshot',p_payload->'customerContactSnapshot',p_payload->'billingContactSnapshot',p_payload->'addressSnapshot',p_payload->'eventSnapshot',p_payload->'termsSnapshot',p_payload->'salespersonSnapshot',(p_payload->>'issueDate')::date,(p_payload->>'validUntil')::timestamptz,p_payload->>'purchaseOrderReference',p_payload->>'customerReference',p_payload->>'taxTreatment',p_payload->>'paymentTerms',p_payload->>'notes',p_actor_id) RETURNING * INTO v;
   INSERT INTO public.sales_quote_status_history(tenant_id,quote_id,quote_version_id,to_status,actor_id,actor_type) VALUES(p_tenant_id,q.id,v.id,'draft',p_actor_id,p_actor_type);
 ELSE
   SELECT * INTO q FROM public.sales_quote WHERE tenant_id=p_tenant_id AND id=p_quote_id FOR UPDATE;
   IF NOT FOUND THEN RAISE EXCEPTION 'quote not found' USING ERRCODE='P0002'; END IF;
   IF q.row_version<>p_expected_version THEN RAISE EXCEPTION 'quote version conflict' USING ERRCODE='40001'; END IF;
   SELECT * INTO v FROM public.sales_quote_version WHERE tenant_id=p_tenant_id AND quote_id=q.id AND version_number=q.current_version FOR UPDATE;
   IF v.status<>'draft' THEN RAISE EXCEPTION 'only a draft can be edited' USING ERRCODE='23514'; END IF;
   UPDATE public.sales_quote SET opportunity_id=(p_payload->>'opportunityId')::uuid,row_version=row_version+1,updated_by=p_actor_id,updated_at=now() WHERE id=q.id RETURNING * INTO q;
   UPDATE public.sales_quote_version SET currency=p_payload->>'currency',organisation_snapshot=p_payload->'organisationSnapshot',customer_contact_snapshot=p_payload->'customerContactSnapshot',billing_contact_snapshot=p_payload->'billingContactSnapshot',address_snapshot=p_payload->'addressSnapshot',event_snapshot=p_payload->'eventSnapshot',terms_snapshot=p_payload->'termsSnapshot',salesperson_snapshot=p_payload->'salespersonSnapshot',issue_date=(p_payload->>'issueDate')::date,notes=p_payload->>'notes',valid_until=(p_payload->>'validUntil')::timestamptz,purchase_order_reference=p_payload->>'purchaseOrderReference',customer_reference=p_payload->>'customerReference',tax_treatment=p_payload->>'taxTreatment',payment_terms=p_payload->>'paymentTerms',updated_at=now() WHERE id=v.id;
   DELETE FROM public.sales_quote_line WHERE tenant_id=p_tenant_id AND quote_version_id=v.id;
 END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(p_payload->'lines') LOOP
   qty:=(item->>'quantity')::numeric; unit:=round((item->>'quotedUnitPriceMinor')::numeric*(10000-(item->>'discountBps')::integer)/10000); rate:=(item->>'taxRateBps')::integer;
   line_net:=round(qty*unit); line_tax:=round(line_net*rate/10000.0); calc_net:=calc_net+line_net; calc_tax:=calc_tax+line_tax; calc_gross:=calc_gross+line_net+line_tax;
   IF line_net<>(item->>'netMinor')::bigint OR line_tax<>(item->>'taxMinor')::bigint OR line_net+line_tax<>(item->>'grossMinor')::bigint THEN RAISE EXCEPTION 'invalid server calculation' USING ERRCODE='22023'; END IF;
   INSERT INTO public.sales_quote_line(tenant_id,quote_version_id,display_order,catalogue_kind,catalogue_id,product_id,bundle_id,catalogue_snapshot,description,quantity,standard_unit_price_minor,quoted_unit_price_minor,price_overridden,discount_bps,tax_rate_bps,net_minor,tax_minor,gross_minor)
   VALUES(p_tenant_id,v.id,i,item->>'kind',NULLIF(item->>'catalogueId','')::uuid,CASE WHEN item->>'kind'='product' THEN (item->>'catalogueId')::uuid END,CASE WHEN item->>'kind'='bundle' THEN (item->>'catalogueId')::uuid END,item->'catalogueSnapshot',item->>'description',qty,(item->>'standardUnitPriceMinor')::bigint,(item->>'quotedUnitPriceMinor')::bigint,(item->>'priceOverridden')::boolean,(item->>'discountBps')::integer,rate,line_net,line_tax,line_net+line_tax) RETURNING id INTO line_id;
   j:=0; FOR component IN SELECT value FROM jsonb_array_elements(COALESCE(item->'components','[]'::jsonb)) LOOP
     INSERT INTO public.sales_quote_bundle_component(tenant_id,quote_line_id,display_order,product_id,quantity,product_snapshot)
     VALUES(p_tenant_id,line_id,j,(component->>'productId')::uuid,(component->>'quantity')::integer,component->'productSnapshot'); j:=j+1;
   END LOOP; i:=i+1;
 END LOOP;
 IF calc_net<>(p_payload->'totals'->>'netMinor')::bigint OR calc_tax<>(p_payload->'totals'->>'taxMinor')::bigint THEN RAISE EXCEPTION 'invalid quote totals' USING ERRCODE='22023'; END IF;
 UPDATE public.sales_quote_version SET net_minor=calc_net,tax_minor=calc_tax,gross_minor=calc_gross WHERE id=v.id;
 RETURN (SELECT to_jsonb(x) FROM (SELECT q.id,q.quote_number,q.current_version,q.row_version,v.id AS version_id,'draft'::text AS status,calc_net AS net_minor,calc_tax AS tax_minor,calc_gross AS gross_minor) x);
END $$;

CREATE OR REPLACE FUNCTION public.issue_sales_quote(p_tenant_id uuid,p_quote_id uuid,p_expected_version integer,p_actor_id text,p_actor_type text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE q public.sales_quote%ROWTYPE; v public.sales_quote_version%ROWTYPE; seq bigint; ident text; settings public.sales_settings%ROWTYPE;
BEGIN
 IF auth.role()<>'service_role' THEN RAISE EXCEPTION 'service role required' USING ERRCODE='42501'; END IF;
 SELECT * INTO q FROM public.sales_quote WHERE tenant_id=p_tenant_id AND id=p_quote_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'quote not found' USING ERRCODE='P0002'; END IF;
 IF q.row_version<>p_expected_version THEN RAISE EXCEPTION 'quote version conflict' USING ERRCODE='40001'; END IF;
 SELECT * INTO v FROM public.sales_quote_version WHERE tenant_id=p_tenant_id AND quote_id=q.id AND version_number=q.current_version FOR UPDATE;
 IF v.status<>'draft' THEN RAISE EXCEPTION 'only drafts can be issued' USING ERRCODE='23514'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.sales_quote_line WHERE tenant_id=p_tenant_id AND quote_version_id=v.id) THEN RAISE EXCEPTION 'quote has no lines' USING ERRCODE='23514'; END IF;
 INSERT INTO public.sales_settings(tenant_id) VALUES(p_tenant_id) ON CONFLICT DO NOTHING;
 SELECT * INTO settings FROM public.sales_settings WHERE tenant_id=p_tenant_id;
 IF q.quote_number IS NULL THEN
   INSERT INTO public.sales_number_sequence(tenant_id,kind,last_value) VALUES(p_tenant_id,'quote',1)
   ON CONFLICT(tenant_id,kind) DO UPDATE SET last_value=sales_number_sequence.last_value+1,updated_at=now() RETURNING last_value INTO seq;
   ident:=settings.quote_prefix||lpad(seq::text,settings.quote_number_padding,'0');
 ELSE ident:=q.quote_number; END IF;
 UPDATE public.sales_quote_version SET status='issued',issued_at=now(),updated_at=now() WHERE id=v.id;
 UPDATE public.sales_quote SET quote_number=ident,row_version=row_version+1,updated_by=p_actor_id,updated_at=now() WHERE id=q.id RETURNING * INTO q;
 INSERT INTO public.sales_quote_status_history(tenant_id,quote_id,quote_version_id,from_status,to_status,actor_id,actor_type) VALUES(p_tenant_id,q.id,v.id,'draft','issued',p_actor_id,p_actor_type);
 RETURN jsonb_build_object('id',q.id,'quote_number',ident,'current_version',q.current_version,'row_version',q.row_version,'status','issued');
END $$;

CREATE OR REPLACE FUNCTION public.transition_sales_quote(p_tenant_id uuid,p_quote_id uuid,p_expected_version integer,p_status text,p_note text,p_actor_id text,p_actor_type text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE q public.sales_quote%ROWTYPE; v public.sales_quote_version%ROWTYPE;
BEGIN
 IF auth.role()<>'service_role' THEN RAISE EXCEPTION 'service role required' USING ERRCODE='42501'; END IF;
 SELECT * INTO q FROM public.sales_quote WHERE tenant_id=p_tenant_id AND id=p_quote_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'quote not found' USING ERRCODE='P0002'; END IF;
 IF q.row_version<>p_expected_version THEN RAISE EXCEPTION 'quote version conflict' USING ERRCODE='40001'; END IF;
 SELECT * INTO v FROM public.sales_quote_version WHERE tenant_id=p_tenant_id AND quote_id=q.id AND version_number=q.current_version FOR UPDATE;
 IF NOT ((v.status IN ('issued','sent') AND p_status IN ('sent','accepted','declined','expired')) OR (v.status='accepted' AND p_status='converted')) THEN RAISE EXCEPTION 'invalid quote status transition' USING ERRCODE='23514'; END IF;
 UPDATE public.sales_quote_version SET status=p_status,updated_at=now() WHERE id=v.id;
 UPDATE public.sales_quote SET row_version=row_version+1,updated_by=p_actor_id,updated_at=now() WHERE id=q.id RETURNING * INTO q;
 INSERT INTO public.sales_quote_status_history(tenant_id,quote_id,quote_version_id,from_status,to_status,actor_id,actor_type,note) VALUES(p_tenant_id,q.id,v.id,v.status,p_status,p_actor_id,p_actor_type,p_note);
 RETURN jsonb_build_object('id',q.id,'row_version',q.row_version,'status',p_status);
END $$;

CREATE OR REPLACE FUNCTION public.amend_sales_quote(p_tenant_id uuid,p_quote_id uuid,p_expected_version integer,p_actor_id text,p_actor_type text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE q public.sales_quote%ROWTYPE; old public.sales_quote_version%ROWTYPE; fresh public.sales_quote_version%ROWTYPE;
BEGIN
 IF auth.role()<>'service_role' THEN RAISE EXCEPTION 'service role required' USING ERRCODE='42501'; END IF;
 SELECT * INTO q FROM public.sales_quote WHERE tenant_id=p_tenant_id AND id=p_quote_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'quote not found' USING ERRCODE='P0002'; END IF;
 IF q.row_version<>p_expected_version THEN RAISE EXCEPTION 'quote version conflict' USING ERRCODE='40001'; END IF;
 SELECT * INTO old FROM public.sales_quote_version WHERE tenant_id=p_tenant_id AND quote_id=q.id AND version_number=q.current_version FOR UPDATE;
 IF old.status NOT IN ('issued','sent','accepted','declined','expired') THEN RAISE EXCEPTION 'quote cannot be amended' USING ERRCODE='23514'; END IF;
 UPDATE public.sales_quote_version SET status='superseded',updated_at=now() WHERE id=old.id;
 INSERT INTO public.sales_quote_version(tenant_id,quote_id,version_number,status,currency,organisation_snapshot,customer_contact_snapshot,billing_contact_snapshot,address_snapshot,event_snapshot,terms_snapshot,salesperson_snapshot,issue_date,valid_until,purchase_order_reference,customer_reference,tax_treatment,payment_terms,notes,net_minor,tax_minor,gross_minor,created_by)
 SELECT tenant_id,quote_id,version_number+1,'draft',currency,organisation_snapshot,customer_contact_snapshot,billing_contact_snapshot,address_snapshot,event_snapshot,terms_snapshot,salesperson_snapshot,issue_date,valid_until,purchase_order_reference,customer_reference,tax_treatment,payment_terms,notes,net_minor,tax_minor,gross_minor,p_actor_id FROM public.sales_quote_version WHERE id=old.id RETURNING * INTO fresh;
 INSERT INTO public.sales_quote_line(tenant_id,quote_version_id,display_order,catalogue_kind,catalogue_id,product_id,bundle_id,catalogue_snapshot,description,quantity,standard_unit_price_minor,quoted_unit_price_minor,price_overridden,discount_bps,tax_rate_bps,net_minor,tax_minor,gross_minor)
 SELECT tenant_id,fresh.id,display_order,catalogue_kind,catalogue_id,product_id,bundle_id,catalogue_snapshot,description,quantity,standard_unit_price_minor,quoted_unit_price_minor,price_overridden,discount_bps,tax_rate_bps,net_minor,tax_minor,gross_minor FROM public.sales_quote_line WHERE tenant_id=p_tenant_id AND quote_version_id=old.id;
 INSERT INTO public.sales_quote_bundle_component(tenant_id,quote_line_id,display_order,product_id,quantity,product_snapshot)
 SELECT c.tenant_id,n.id,c.display_order,c.product_id,c.quantity,c.product_snapshot FROM public.sales_quote_bundle_component c JOIN public.sales_quote_line o ON o.id=c.quote_line_id JOIN public.sales_quote_line n ON n.quote_version_id=fresh.id AND n.display_order=o.display_order WHERE o.quote_version_id=old.id;
 UPDATE public.sales_quote SET current_version=fresh.version_number,row_version=row_version+1,updated_by=p_actor_id,updated_at=now() WHERE id=q.id RETURNING * INTO q;
 INSERT INTO public.sales_quote_status_history(tenant_id,quote_id,quote_version_id,from_status,to_status,actor_id,actor_type,note) VALUES(p_tenant_id,q.id,old.id,old.status,'superseded',p_actor_id,p_actor_type,'Amended');
 INSERT INTO public.sales_quote_status_history(tenant_id,quote_id,quote_version_id,to_status,actor_id,actor_type,note) VALUES(p_tenant_id,q.id,fresh.id,'draft',p_actor_id,p_actor_type,'Amendment draft');
 RETURN jsonb_build_object('id',q.id,'current_version',q.current_version,'row_version',q.row_version,'status','draft');
END $$;

ALTER TABLE public.sales_quote ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sales_quote_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sales_quote_line ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sales_quote_bundle_component ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sales_quote_status_history ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.sales_quote,public.sales_quote_version,public.sales_quote_line,public.sales_quote_bundle_component,public.sales_quote_status_history FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.sales_quote,public.sales_quote_version,public.sales_quote_line,public.sales_quote_bundle_component,public.sales_quote_status_history TO service_role;
CREATE POLICY sales_quote_service_select ON public.sales_quote FOR SELECT TO service_role USING(true);
CREATE POLICY sales_quote_version_service_select ON public.sales_quote_version FOR SELECT TO service_role USING(true);
CREATE POLICY sales_quote_line_service_select ON public.sales_quote_line FOR SELECT TO service_role USING(true);
CREATE POLICY sales_quote_component_service_select ON public.sales_quote_bundle_component FOR SELECT TO service_role USING(true);
CREATE POLICY sales_quote_history_service_select ON public.sales_quote_status_history FOR SELECT TO service_role USING(true);
REVOKE ALL ON FUNCTION public.save_sales_quote_draft(uuid,uuid,integer,jsonb,text,text),public.issue_sales_quote(uuid,uuid,integer,text,text),public.transition_sales_quote(uuid,uuid,integer,text,text,text,text),public.amend_sales_quote(uuid,uuid,integer,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.save_sales_quote_draft(uuid,uuid,integer,jsonb,text,text),public.issue_sales_quote(uuid,uuid,integer,text,text),public.transition_sales_quote(uuid,uuid,integer,text,text,text,text),public.amend_sales_quote(uuid,uuid,integer,text,text) TO service_role;