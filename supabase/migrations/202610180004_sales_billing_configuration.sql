-- Apply only through an explicitly approved destination-only rollout.
-- No historical quote/sale changes, scheduler activation or provider effects.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
ALTER TABLE public.sales_settings ADD COLUMN IF NOT EXISTS billing_presets jsonb NOT NULL DEFAULT '{"issueDelays":[],"paymentTerms":[]}';
ALTER TABLE public.sales_catalogue_bundle ADD COLUMN IF NOT EXISTS billing_groups jsonb NOT NULL DEFAULT '[]';

CREATE OR REPLACE FUNCTION public.sales_validate_billing_presets(p_value jsonb)
RETURNS void LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE k text; v jsonb;
BEGIN
 IF jsonb_typeof(p_value) IS DISTINCT FROM 'object'
  OR p_value - 'issueDelays' - 'paymentTerms' <> '{}'::jsonb THEN
  RAISE EXCEPTION 'Invalid billing presets' USING ERRCODE='22023';
 END IF;
 FOREACH k IN ARRAY ARRAY['issueDelays','paymentTerms'] LOOP
  IF jsonb_typeof(p_value->k) IS DISTINCT FROM 'array' THEN
   RAISE EXCEPTION 'Separate issue-delay and payment-term lists required' USING ERRCODE='22023';
  END IF;
  IF jsonb_array_length(p_value->k)>100 THEN RAISE EXCEPTION 'Too many billing presets' USING ERRCODE='22023'; END IF;
  FOR v IN SELECT value FROM jsonb_array_elements(p_value->k) LOOP
   IF jsonb_typeof(v) IS DISTINCT FROM 'object'
    OR v - 'id' - 'name' - 'days' - 'isActive' - 'isDefault' <> '{}'::jsonb
    OR (v->>'id') IS NULL OR (v->>'id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    OR jsonb_typeof(v->'name') IS DISTINCT FROM 'string'
    OR char_length(btrim(v->>'name')) NOT BETWEEN 1 AND 100
    OR jsonb_typeof(v->'days') IS DISTINCT FROM 'number'
    OR (v->>'days') !~ '^[0-9]+$'
    OR (v->>'days')::numeric NOT BETWEEN 0 AND 36500
    OR jsonb_typeof(v->'isActive') IS DISTINCT FROM 'boolean'
    OR jsonb_typeof(v->'isDefault') IS DISTINCT FROM 'boolean'
    OR (v->>'isDefault')::boolean AND NOT (v->>'isActive')::boolean THEN
    RAISE EXCEPTION 'Invalid billing preset: use a named active/default selection and whole calendar days' USING ERRCODE='22023';
   END IF;
  END LOOP;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_value->k) entry GROUP BY entry->>'id' HAVING count(*)>1)
    OR (SELECT count(*) FROM jsonb_array_elements(p_value->k) entry WHERE (entry->>'isDefault')::boolean)>1 THEN
   RAISE EXCEPTION 'Duplicate preset identity or multiple defaults' USING ERRCODE='22023';
  END IF;
 END LOOP;
END $$;
REVOKE ALL ON FUNCTION public.sales_validate_billing_presets(jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.sales_validate_billing_presets(jsonb) TO service_role;

-- Extend, rather than replace, the latest versioned settings writer. Preserve
-- naming, visibility, task lists, first-save serialization and audit semantics.
DO $migration$
DECLARE definition text;
BEGIN
 SELECT pg_get_functiondef('public.patch_sales_settings(uuid,integer,jsonb,text,text)'::regprocedure) INTO definition;
 IF position('billing_presets_v1' IN definition)=0 THEN
  IF position('quote_naming_v1' IN definition)=0 OR position('FOR UPDATE' IN definition)=0
   OR position('ON CONFLICT' IN definition)=0 OR position('40001' IN definition)=0
   OR position('INSERT INTO public.sales_settings(tenant_id)' IN definition)=0
   OR position('UPDATE public.sales_settings SET' IN definition)=0 THEN
   RAISE EXCEPTION 'Review latest Sales settings contract before extending billing presets';
  END IF;
  definition := replace(definition,'INSERT INTO public.sales_settings(tenant_id)', $v$
  -- billing_presets_v1
  IF p_patch ? 'billingPresets' THEN PERFORM public.sales_validate_billing_presets(p_patch->'billingPresets'); END IF;
  INSERT INTO public.sales_settings(tenant_id)$v$);
  definition := replace(definition,'UPDATE public.sales_settings SET', $v$
  UPDATE public.sales_settings SET
   billing_presets=CASE WHEN p_patch ? 'billingPresets' THEN p_patch->'billingPresets' ELSE billing_presets END,$v$);
  EXECUTE definition;
 END IF;
END $migration$;
REVOKE ALL ON FUNCTION public.patch_sales_settings(uuid,integer,jsonb,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.patch_sales_settings(uuid,integer,jsonb,text,text) TO service_role;

CREATE OR REPLACE FUNCTION public.sales_validate_bundle_billing(
 p_tenant_id uuid,p_groups jsonb,p_items jsonb,p_selling bigint,p_previous jsonb DEFAULT '[]'
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE g jsonb; old_group jsonb; term jsonb; kind text; selection jsonb;
 presets jsonb; n integer:=0; total numeric:=0; fixed date;
BEGIN
 IF jsonb_typeof(p_groups) IS DISTINCT FROM 'array' OR jsonb_array_length(p_groups)>100 THEN
  RAISE EXCEPTION 'Invalid billing groups' USING ERRCODE='22023';
 END IF;
 IF jsonb_array_length(p_groups)=0 THEN RETURN; END IF;
 SELECT billing_presets INTO presets FROM public.sales_settings WHERE tenant_id=p_tenant_id FOR SHARE;
 FOR g IN SELECT value FROM jsonb_array_elements(p_groups) LOOP
  IF jsonb_typeof(g) IS DISTINCT FROM 'object'
   OR (g->>'id') IS NULL OR (g->>'id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
   OR jsonb_typeof(g->'name') IS DISTINCT FROM 'string' OR char_length(btrim(g->>'name')) NOT BETWEEN 1 AND 100
   OR jsonb_typeof(g->'position') IS DISTINCT FROM 'number' OR (g->>'position')::numeric<>n
   OR jsonb_typeof(g->'allocatedMinor') IS DISTINCT FROM 'number' OR (g->>'allocatedMinor') !~ '^[0-9]+$'
   OR (g->>'allocatedMinor')::numeric>9007199254740991
   OR jsonb_typeof(g->'productIds') IS DISTINCT FROM 'array' THEN
   RAISE EXCEPTION 'Invalid group identity, name, order, allocation or membership' USING ERRCODE='22023';
  END IF;
  total:=total+(g->>'allocatedMinor')::numeric; n:=n+1;
  IF g#>>'{timing,kind}'='acceptance' THEN
   IF jsonb_typeof(g#>'{timing,days}') IS DISTINCT FROM 'number' OR g#>>'{timing,days}' !~ '^[0-9]+$'
    OR (g#>>'{timing,days}')::numeric NOT BETWEEN 0 AND 36500 THEN
    RAISE EXCEPTION 'Issue delay must be whole calendar days' USING ERRCODE='22023';
   END IF;
  ELSIF g#>>'{timing,kind}'='fixed' THEN
   IF coalesce(g#>>'{timing,date}','') !~ '^[1-9][0-9]{3}-[0-9]{2}-[0-9]{2}$' THEN
    RAISE EXCEPTION 'Invalid fixed invoice date' USING ERRCODE='22023';
   END IF;
   BEGIN fixed:=(g#>>'{timing,date}')::date;
   EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'Invalid fixed invoice date' USING ERRCODE='22023'; END;
  ELSE RAISE EXCEPTION 'Select invoice timing separately from payment terms' USING ERRCODE='22023';
  END IF;
  SELECT value INTO old_group FROM jsonb_array_elements(coalesce(p_previous,'[]')) WHERE value->>'id'=g->>'id';
  FOREACH kind IN ARRAY ARRAY['paymentTerms','issueDelayPreset'] LOOP
   selection:=g->kind;
   IF kind='issueDelayPreset' AND (selection IS NULL OR selection='null'::jsonb) THEN CONTINUE; END IF;
   IF jsonb_typeof(selection) IS DISTINCT FROM 'object' OR NOT(selection ?& ARRAY['id','name','days']) THEN
    RAISE EXCEPTION 'Select named payment terms or issue-delay preset' USING ERRCODE='22023';
   END IF;
   IF kind='issueDelayPreset' AND (g#>>'{timing,kind}'<>'acceptance' OR selection->'days' IS DISTINCT FROM g#>'{timing,days}') THEN
    RAISE EXCEPTION 'Issue-delay selection must match timing' USING ERRCODE='22023';
   END IF;
   -- Only identical persisted snapshots can retain deactivated/changed terms.
   IF old_group->kind IS NOT DISTINCT FROM selection THEN CONTINUE; END IF;
   SELECT value INTO term FROM jsonb_array_elements(coalesce(presets->CASE kind WHEN 'paymentTerms' THEN 'paymentTerms' ELSE 'issueDelays' END,'[]'))
    WHERE value->>'id'=selection->>'id' AND value->>'isActive'='true';
   IF term IS NULL OR jsonb_build_object('id',term->'id','name',btrim(term->>'name'),'days',term->'days') IS DISTINCT FROM selection THEN
    RAISE EXCEPTION 'Preset is unavailable or does not belong to this tenant; refresh billing selections' USING ERRCODE='22023';
   END IF;
  END LOOP;
 END LOOP;
 IF total<>p_selling THEN RAISE EXCEPTION 'Billing allocations must equal the bundle selling price exactly' USING ERRCODE='22023'; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_groups) entry GROUP BY entry->>'id' HAVING count(*)>1) THEN
  RAISE EXCEPTION 'Duplicate billing group identity' USING ERRCODE='22023';
 END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_groups) entry CROSS JOIN LATERAL jsonb_array_elements_text(entry->'productIds') p
   GROUP BY p HAVING count(*)<>1)
  OR (SELECT coalesce(array_agg(p ORDER BY p),ARRAY[]::text[]) FROM jsonb_array_elements(p_groups) entry CROSS JOIN LATERAL jsonb_array_elements_text(entry->'productIds') p)
    IS DISTINCT FROM (SELECT coalesce(array_agg(i->>'productId' ORDER BY i->>'productId'),ARRAY[]::text[]) FROM jsonb_array_elements(p_items) i) THEN
  RAISE EXCEPTION 'Assign every bundle product exactly once; explicitly reassign before removing a nonempty group' USING ERRCODE='22023';
 END IF;
END $$;
REVOKE ALL ON FUNCTION public.sales_validate_bundle_billing(uuid,jsonb,jsonb,bigint,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.sales_validate_bundle_billing(uuid,jsonb,jsonb,bigint,jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.sales_bundle_copy_billing_baseline(p_tenant uuid,p_source uuid,p_groups jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE source_groups jsonb; g jsonb; saved jsonb; baseline jsonb:='[]';
BEGIN
 IF p_source IS NULL THEN RETURN baseline; END IF;
 SELECT billing_groups INTO source_groups FROM public.sales_catalogue_bundle WHERE tenant_id=p_tenant AND id=p_source FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Bundle copy source is unavailable' USING ERRCODE='22023'; END IF;
 FOR g IN SELECT value FROM jsonb_array_elements(p_groups) LOOP
  IF NOT(g ? 'sourceGroupId') THEN CONTINUE; END IF;
  SELECT value INTO saved FROM jsonb_array_elements(source_groups) WHERE value->>'id'=g->>'sourceGroupId';
  IF saved IS NULL OR saved->>'id'=g->>'id' THEN
   RAISE EXCEPTION 'Copied groups require tenant-owned sources and fresh identities' USING ERRCODE='22023';
  END IF;
  baseline:=baseline||jsonb_build_array(saved||jsonb_build_object('id',g->'id'));
 END LOOP;
 RETURN baseline;
END $$;
REVOKE ALL ON FUNCTION public.sales_bundle_copy_billing_baseline(uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.sales_bundle_copy_billing_baseline(uuid,uuid,jsonb) TO service_role;

-- Preserve the product creation and duplicate-code retry contracts.
DO $migration$
DECLARE definition text;
BEGIN
 SELECT pg_get_functiondef('public.create_sales_catalogue_record(uuid,text,jsonb,jsonb,text,text)'::regprocedure) INTO definition;
 IF position('bundle_billing_v1' IN definition)=0 THEN
  IF position('v_bundle := jsonb_populate_record' IN definition)=0
   OR position('display_order, created_by, updated_by' IN definition)=0
   OR position('v_bundle.available_to, COALESCE(v_bundle.display_order, 0), p_actor_id, p_actor_id' IN definition)=0 THEN
   RAISE EXCEPTION 'Review catalogue atomic-create contract before extending billing';
  END IF;
  definition:=replace(definition,'v_bundle := jsonb_populate_record(NULL::public.sales_catalogue_bundle, p_record);',$v$
   -- bundle_billing_v1
   v_bundle := jsonb_populate_record(NULL::public.sales_catalogue_bundle, p_record);
   PERFORM public.sales_validate_bundle_billing(p_tenant_id,coalesce(v_bundle.billing_groups,'[]'),p_items,v_bundle.selling_price_minor,
     public.sales_bundle_copy_billing_baseline(p_tenant_id,(p_record->>'copy_source_id')::uuid,coalesce(v_bundle.billing_groups,'[]')));
   SELECT coalesce(jsonb_agg(value-'sourceGroupId'),'[]') INTO v_bundle.billing_groups
     FROM jsonb_array_elements(coalesce(v_bundle.billing_groups,'[]'));
  $v$);
  -- This anchor appears only in the bundle branch (product has event columns).
  definition:=replace(definition,'display_order, created_by, updated_by','display_order, created_by, updated_by, billing_groups');
  definition:=replace(definition,'v_bundle.available_to, COALESCE(v_bundle.display_order, 0), p_actor_id, p_actor_id',
   'v_bundle.available_to, COALESCE(v_bundle.display_order, 0), p_actor_id, p_actor_id, coalesce(v_bundle.billing_groups,''[]''::jsonb)');
  EXECUTE definition;
 END IF;
END $migration$;

CREATE OR REPLACE FUNCTION public.update_sales_catalogue_bundle(
 p_tenant_id uuid,p_bundle_id uuid,p_expected_updated_at timestamptz,p_record jsonb,p_items jsonb,p_actor_id text,p_actor_type text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE old_row public.sales_catalogue_bundle%ROWTYPE; v public.sales_catalogue_bundle%ROWTYPE; after_row jsonb; before_row jsonb; count_products integer;
BEGIN
 IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'service role required' USING ERRCODE='42501'; END IF;
 IF p_actor_id IS NULL OR btrim(p_actor_id)='' OR p_actor_type IS NULL OR p_actor_type NOT IN ('member','tenant_user','system') THEN
  RAISE EXCEPTION 'Invalid actor' USING ERRCODE='22023';
 END IF;
 SELECT * INTO old_row FROM public.sales_catalogue_bundle WHERE tenant_id=p_tenant_id AND id=p_bundle_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Unknown tenant bundle' USING ERRCODE='22023'; END IF;
 IF old_row.updated_at IS DISTINCT FROM p_expected_updated_at THEN RAISE EXCEPTION 'Bundle changed elsewhere' USING ERRCODE='40001'; END IF;
 IF jsonb_typeof(p_items) IS DISTINCT FROM 'array' OR jsonb_array_length(p_items)=0 THEN
  RAISE EXCEPTION 'Bundle requires products' USING ERRCODE='22023';
 END IF;
 PERFORM 1 FROM public.sales_catalogue_product WHERE tenant_id=p_tenant_id AND is_active
  AND id IN (SELECT (i->>'productId')::uuid FROM jsonb_array_elements(p_items) i) ORDER BY id FOR SHARE;
 GET DIAGNOSTICS count_products=ROW_COUNT;
 IF count_products<>jsonb_array_length(p_items) THEN RAISE EXCEPTION 'Bundle requires distinct active tenant products' USING ERRCODE='22023'; END IF;
 v:=jsonb_populate_record(NULL::public.sales_catalogue_bundle,p_record);
 PERFORM public.sales_validate_bundle_billing(p_tenant_id,coalesce(v.billing_groups,'[]'),p_items,v.selling_price_minor,old_row.billing_groups);
 SELECT to_jsonb(old_row)||jsonb_build_object('items',coalesce(jsonb_agg(to_jsonb(i) ORDER BY i.display_order),'[]')) INTO before_row
  FROM public.sales_catalogue_bundle_item i WHERE i.tenant_id=p_tenant_id AND i.bundle_id=p_bundle_id;
 UPDATE public.sales_catalogue_bundle SET code=v.code,name=v.name,description=v.description,currency=v.currency,
  selling_price_minor=v.selling_price_minor,minimum_price_minor=v.minimum_price_minor,presentation_mode=v.presentation_mode,
  available_from=v.available_from,available_to=v.available_to,display_order=v.display_order,billing_groups=coalesce(v.billing_groups,'[]'),
  updated_by=p_actor_id,updated_at=clock_timestamp() WHERE tenant_id=p_tenant_id AND id=p_bundle_id RETURNING to_jsonb(sales_catalogue_bundle.*) INTO after_row;
 DELETE FROM public.sales_catalogue_bundle_item WHERE tenant_id=p_tenant_id AND bundle_id=p_bundle_id;
 INSERT INTO public.sales_catalogue_bundle_item(tenant_id,bundle_id,product_id,quantity,display_order)
  SELECT p_tenant_id,p_bundle_id,(i.value->>'productId')::uuid,(i.value->>'quantity')::integer,i.ordinality-1
  FROM jsonb_array_elements(p_items) WITH ORDINALITY i(value,ordinality);
 SELECT after_row||jsonb_build_object('items',jsonb_agg(jsonb_build_object('id',id,'productId',product_id,'quantity',quantity,'displayOrder',display_order) ORDER BY display_order))
  INTO after_row FROM public.sales_catalogue_bundle_item WHERE tenant_id=p_tenant_id AND bundle_id=p_bundle_id;
 INSERT INTO public.sales_audit_event(tenant_id,actor_id,actor_type,action,entity_type,entity_id,before_data,after_data)
  VALUES(p_tenant_id,p_actor_id,p_actor_type,'bundle.updated','sales_catalogue_bundle',p_bundle_id,before_row,after_row);
 RETURN after_row;
END $$;
REVOKE ALL ON FUNCTION public.update_sales_catalogue_bundle(uuid,uuid,timestamptz,jsonb,jsonb,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.update_sales_catalogue_bundle(uuid,uuid,timestamptz,jsonb,jsonb,text,text) TO service_role;

-- Check final composition even for legacy RPCs or service-side writes; both
-- parents are checked when a component is moved. Deferred to permit atomic saves.
CREATE OR REPLACE FUNCTION public.sales_bundle_billing_integrity()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE parent_id uuid; tenant uuid; b public.sales_catalogue_bundle%ROWTYPE; items jsonb;
BEGIN
 FOR parent_id,tenant IN
  SELECT DISTINCT x.id,x.tid FROM (VALUES
   ((CASE WHEN TG_OP<>'INSERT' THEN to_jsonb(OLD)->>CASE WHEN TG_TABLE_NAME='sales_catalogue_bundle' THEN 'id' ELSE 'bundle_id' END END)::uuid,CASE WHEN TG_OP<>'INSERT' THEN OLD.tenant_id END),
   ((CASE WHEN TG_OP<>'DELETE' THEN to_jsonb(NEW)->>CASE WHEN TG_TABLE_NAME='sales_catalogue_bundle' THEN 'id' ELSE 'bundle_id' END END)::uuid,CASE WHEN TG_OP<>'DELETE' THEN NEW.tenant_id END)) x(id,tid) WHERE x.id IS NOT NULL
 LOOP
  SELECT * INTO b FROM public.sales_catalogue_bundle WHERE tenant_id=tenant AND id=parent_id;
  IF NOT FOUND THEN CONTINUE; END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object('productId',product_id)),'[]') INTO items
   FROM public.sales_catalogue_bundle_item WHERE tenant_id=tenant AND bundle_id=parent_id;
  PERFORM public.sales_validate_bundle_billing(tenant,b.billing_groups,items,b.selling_price_minor,b.billing_groups);
 END LOOP;
 RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS sales_bundle_billing_integrity ON public.sales_catalogue_bundle;
CREATE CONSTRAINT TRIGGER sales_bundle_billing_integrity AFTER INSERT OR UPDATE OR DELETE ON public.sales_catalogue_bundle DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.sales_bundle_billing_integrity();
DROP TRIGGER IF EXISTS sales_bundle_item_billing_integrity ON public.sales_catalogue_bundle_item;
CREATE CONSTRAINT TRIGGER sales_bundle_item_billing_integrity AFTER INSERT OR UPDATE OR DELETE ON public.sales_catalogue_bundle_item DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.sales_bundle_billing_integrity();
REVOKE ALL ON FUNCTION public.sales_bundle_billing_integrity() FROM PUBLIC,anon,authenticated;
NOTIFY pgrst,'reload schema';
COMMIT;
