BEGIN;
ALTER TABLE public.sales_catalogue_bundle ADD COLUMN IF NOT EXISTS category_id uuid;
DO $migration$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.sales_catalogue_bundle'::regclass AND conname='sales_bundle_category_tenant_fk') THEN
  ALTER TABLE public.sales_catalogue_bundle ADD CONSTRAINT sales_bundle_category_tenant_fk
   FOREIGN KEY(tenant_id,category_id) REFERENCES public.sales_catalogue_category(tenant_id,id) ON DELETE RESTRICT;
 END IF;
END $migration$;
CREATE INDEX IF NOT EXISTS sales_bundle_category_idx ON public.sales_catalogue_bundle(tenant_id,category_id);

-- Existing assignments survive category archival; new assignments must be active.
-- SHARE serializes assignment against category status updates.
CREATE OR REPLACE FUNCTION public.guard_sales_bundle_category() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF TG_OP='UPDATE' THEN
  IF NEW.category_id IS NOT DISTINCT FROM OLD.category_id AND NEW.tenant_id=OLD.tenant_id THEN RETURN NEW; END IF;
 END IF;
 IF NEW.category_id IS NOT NULL THEN
  PERFORM 1 FROM public.sales_catalogue_category WHERE tenant_id=NEW.tenant_id AND id=NEW.category_id AND is_active AND archived_at IS NULL FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Select an active category belonging to this tenant' USING ERRCODE='22023'; END IF;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_sales_bundle_category() FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS sales_bundle_category_guard ON public.sales_catalogue_bundle;
CREATE TRIGGER sales_bundle_category_guard BEFORE INSERT OR UPDATE OF category_id,tenant_id ON public.sales_catalogue_bundle
 FOR EACH ROW EXECUTE FUNCTION public.guard_sales_bundle_category();

-- Extend the installed atomic RPCs rather than replacing newer billing/exhibition
-- protections. Fail closed if their reviewed anchors no longer match.
DO $migration$
DECLARE definition text; anchor text;
BEGIN
 SELECT pg_get_functiondef('public.create_sales_catalogue_record(uuid,text,jsonb,jsonb,text,text)'::regprocedure) INTO definition;
 IF position('v_bundle.category_id' IN definition)=0 THEN
  anchor:='display_order, created_by, updated_by, billing_groups';
  IF position(anchor IN definition)=0 THEN RAISE EXCEPTION 'Unknown bundle create columns'; END IF;
  definition:=replace(definition,anchor,anchor||', category_id');
  anchor:='v_bundle.available_to, COALESCE(v_bundle.display_order, 0), p_actor_id, p_actor_id, coalesce(v_bundle.billing_groups,''[]''::jsonb)';
  IF position(anchor IN definition)=0 THEN RAISE EXCEPTION 'Unknown bundle create values'; END IF;
  EXECUTE replace(definition,anchor,anchor||', v_bundle.category_id');
 END IF;
 SELECT pg_get_functiondef('public.update_sales_catalogue_bundle(uuid,uuid,timestamptz,jsonb,jsonb,text,text)'::regprocedure) INTO definition;
 IF position('category_id=CASE' IN definition)=0 THEN
  anchor:='UPDATE public.sales_catalogue_bundle SET code=v.code';
  IF position(anchor IN definition)=0 THEN RAISE EXCEPTION 'Unknown bundle update contract'; END IF;
  -- Old deployments omit this new field: preserve rather than erase assignments.
  EXECUTE replace(definition,anchor,'UPDATE public.sales_catalogue_bundle SET category_id=CASE WHEN p_record ? ''category_id'' THEN v.category_id ELSE old_row.category_id END, code=v.code');
 END IF;
END $migration$;
COMMIT;
