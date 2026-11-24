BEGIN;
ALTER TABLE public.sales_catalogue_bundle_item ALTER COLUMN product_id DROP NOT NULL;
ALTER TABLE public.sales_catalogue_bundle_item
  ADD COLUMN component_kind text NOT NULL DEFAULT 'product',
  ADD COLUMN event_reference_kind text,
  ADD COLUMN event_id uuid,
  ADD COLUMN ticket_type_id text,
  ADD CONSTRAINT sales_bundle_component_identity CHECK (
    (component_kind='product' AND product_id IS NOT NULL AND event_reference_kind IS NULL AND event_id IS NULL AND ticket_type_id IS NULL)
    OR (component_kind='ticket' AND product_id IS NULL AND event_reference_kind IN ('simple','complex')
      AND event_reference_kind IS NOT NULL AND event_id IS NOT NULL AND length(ticket_type_id)>0 AND ticket_type_id IS NOT NULL));
CREATE UNIQUE INDEX sales_bundle_ticket_unique ON public.sales_catalogue_bundle_item
  (tenant_id,bundle_id,event_reference_kind,event_id,ticket_type_id) WHERE component_kind='ticket';
ALTER TABLE public.sales_quote_bundle_component ALTER COLUMN product_id DROP NOT NULL;
ALTER TABLE public.sales_quote_bundle_component ADD CONSTRAINT sales_quote_ticket_component_identity CHECK (
  product_id IS NOT NULL OR (
    COALESCE(product_snapshot->>'component_kind','')='ticket'
    AND COALESCE(product_snapshot->>'event_reference_kind','') IN ('simple','complex')
    AND COALESCE(product_snapshot->>'event_id','')<>''
    AND COALESCE(product_snapshot->>'ticket_type_id','')<>''));

CREATE OR REPLACE FUNCTION public.replace_sales_catalogue_bundle_items(p_tenant_id uuid,p_bundle_id uuid,p_items jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $fn$
DECLARE item jsonb; n integer:=0; options jsonb; reference jsonb;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'service role required' USING ERRCODE='42501'; END IF;
  IF jsonb_typeof(p_items) IS DISTINCT FROM 'array' OR jsonb_array_length(p_items)=0 THEN
    RAISE EXCEPTION 'Bundle requires included items' USING ERRCODE='22023';
  END IF;
  PERFORM 1 FROM public.sales_catalogue_bundle WHERE tenant_id=p_tenant_id AND id=p_bundle_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Unknown tenant bundle' USING ERRCODE='22023'; END IF;
  DELETE FROM public.sales_catalogue_bundle_item WHERE tenant_id=p_tenant_id AND bundle_id=p_bundle_id;
  FOR item IN SELECT value FROM jsonb_array_elements(p_items) LOOP
    IF COALESCE(item->>'quantity','') !~ '^[1-9][0-9]{0,5}$' OR (item->>'quantity')::integer>100000 THEN
      RAISE EXCEPTION 'Included quantities must be positive whole numbers' USING ERRCODE='22023';
    END IF;
    IF COALESCE(item->>'kind','product')='ticket' THEN
      reference:=item->'eventReference';
      options:=public.sales_ticket_event_options(p_tenant_id,'',1,(reference->>'eventId')::uuid,reference->>'kind')->'items'->0;
      IF NOT COALESCE((options->>'eligible')::boolean,false) OR NOT EXISTS(
        SELECT 1 FROM jsonb_array_elements(options->'ticketOptions') t WHERE t->>'id'=reference->>'ticketTypeId'
      ) THEN RAISE EXCEPTION 'Ticket event is no longer eligible; choose a future event and ticket type' USING ERRCODE='22023'; END IF;
      INSERT INTO public.sales_catalogue_bundle_item(id,tenant_id,bundle_id,component_kind,event_reference_kind,event_id,ticket_type_id,quantity,display_order)
      VALUES((item->>'componentId')::uuid,p_tenant_id,p_bundle_id,'ticket',reference->>'kind',(reference->>'eventId')::uuid,
        reference->>'ticketTypeId',(item->>'quantity')::integer,n);
    ELSIF COALESCE(item->>'kind','product')='product' THEN
      PERFORM 1 FROM public.sales_catalogue_product WHERE tenant_id=p_tenant_id AND id=(item->>'productId')::uuid AND is_active FOR SHARE;
      IF NOT FOUND THEN RAISE EXCEPTION 'Choose an active tenant product' USING ERRCODE='22023'; END IF;
      INSERT INTO public.sales_catalogue_bundle_item(tenant_id,bundle_id,product_id,quantity,display_order)
      VALUES(p_tenant_id,p_bundle_id,(item->>'productId')::uuid,(item->>'quantity')::integer,n);
    ELSE RAISE EXCEPTION 'Unknown component kind' USING ERRCODE='22023';
    END IF;
    n:=n+1;
  END LOOP;
END $fn$;

-- Preserve the current parent/audit/billing implementation, replacing only the
-- composition writer. Anchors fail closed rather than installing a partial patch.
DO $migration$
DECLARE def text; patched text; signature text; old_insert text; replacement text;
BEGIN
  FOREACH signature IN ARRAY ARRAY[
    'public.create_sales_catalogue_record(uuid,text,jsonb,jsonb,text,text)',
    'public.update_sales_catalogue_bundle(uuid,uuid,timestamptz,jsonb,jsonb,text,text)'
  ] LOOP
    SELECT pg_get_functiondef(signature::regprocedure) INTO def;
    patched:=replace(def,'v_count <> jsonb_array_length(p_items)',
      'v_count <> (SELECT count(*) FROM jsonb_array_elements(p_items) x WHERE COALESCE(x->>''kind'',''product'')=''product'')');
    patched:=replace(patched,'count_products<>jsonb_array_length(p_items)',
      'count_products<>(SELECT count(*) FROM jsonb_array_elements(p_items) x WHERE COALESCE(x->>''kind'',''product'')=''product'')');
    IF signature LIKE '%create_sales%' THEN
      old_insert:=$old$INSERT INTO public.sales_catalogue_bundle_item (
      tenant_id, bundle_id, product_id, quantity, display_order
    ) SELECT p_tenant_id, v_id, (item.value->>'productId')::uuid,
        (item.value->>'quantity')::integer, item.ordinality - 1
      FROM jsonb_array_elements(p_items) WITH ORDINALITY item(value, ordinality);$old$;
      replacement:='PERFORM public.replace_sales_catalogue_bundle_items(p_tenant_id,v_id,p_items);';
    ELSE
      old_insert:=$old$INSERT INTO public.sales_catalogue_bundle_item(tenant_id,bundle_id,product_id,quantity,display_order)
  SELECT p_tenant_id,p_bundle_id,(i.value->>'productId')::uuid,(i.value->>'quantity')::integer,i.ordinality-1
  FROM jsonb_array_elements(p_items) WITH ORDINALITY i(value,ordinality);$old$;
      replacement:='PERFORM public.replace_sales_catalogue_bundle_items(p_tenant_id,p_bundle_id,p_items);';
    END IF;
    IF position(old_insert IN patched)=0 THEN RAISE EXCEPTION 'Unknown bundle writer contract: %',signature; END IF;
    patched:=replace(patched,old_insert,replacement);
    -- Immediate mutation responses must retain typed items, not drop ticket refs.
    patched:=replace(patched,'''productId'', product_id,', '''productId'', product_id, ''kind'',component_kind,''componentId'',id,''eventReference'',CASE WHEN component_kind=''ticket'' THEN jsonb_build_object(''kind'',event_reference_kind,''eventId'',event_id,''ticketTypeId'',ticket_type_id) END,');
    patched:=replace(patched,'''productId'',product_id,', '''productId'',product_id,''kind'',component_kind,''componentId'',id,''eventReference'',CASE WHEN component_kind=''ticket'' THEN jsonb_build_object(''kind'',event_reference_kind,''eventId'',event_id,''ticketTypeId'',ticket_type_id) END,');
    EXECUTE patched;
  END LOOP;
END $migration$;
DO $billing$
DECLARE def text; patched text;
BEGIN
  SELECT pg_get_functiondef('public.sales_validate_bundle_billing(uuid,jsonb,jsonb,bigint,jsonb)'::regprocedure) INTO def;
  patched:=replace(def,'i->>''productId''','COALESCE(i->>''productId'',i->>''componentId'')');
  IF patched=def THEN RAISE EXCEPTION 'Unknown bundle billing membership contract'; END IF;
  EXECUTE patched;
  SELECT pg_get_functiondef('public.sales_bundle_billing_integrity()'::regprocedure) INTO def;
  patched:=replace(def,'''productId'',product_id','''productId'',product_id,''componentId'',CASE WHEN component_kind=''ticket'' THEN id END');
  IF patched=def THEN RAISE EXCEPTION 'Unknown bundle billing integrity contract'; END IF;
  EXECUTE patched;
END $billing$;
CREATE FUNCTION public.reject_form_ticket_bundle() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $fn$
BEGIN
  IF EXISTS(SELECT 1 FROM public.sales_catalogue_bundle_item
    WHERE tenant_id=NEW.tenant_id AND bundle_id=NEW.bundle_id AND component_kind='ticket') THEN
    RAISE EXCEPTION 'Form checkout cannot fulfil ticket-bearing bundles; use a Sales proposal' USING ERRCODE='22023';
  END IF;
  RETURN NEW;
END $fn$;
REVOKE ALL ON FUNCTION public.reject_form_ticket_bundle() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER reject_form_ticket_bundle BEFORE INSERT ON public.form_bundle_allocation
  FOR EACH ROW EXECUTE FUNCTION public.reject_form_ticket_bundle();
CREATE TRIGGER reject_form_ticket_bundle BEFORE INSERT ON public.form_bundle_selection
  FOR EACH ROW EXECUTE FUNCTION public.reject_form_ticket_bundle();
REVOKE ALL ON FUNCTION public.replace_sales_catalogue_bundle_items(uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.replace_sales_catalogue_bundle_items(uuid,uuid,jsonb) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
