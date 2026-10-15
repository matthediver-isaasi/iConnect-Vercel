BEGIN;
LOCK TABLE public.role IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.role_access_item IN SHARE ROW EXCLUSIVE MODE;
DO $$
DECLARE parent uuid;
BEGIN
 SELECT id INTO STRICT parent FROM public.role_access_item WHERE item_key='events' AND item_type='module' AND is_active;
 IF NOT EXISTS(SELECT 1 FROM public.role_access_item WHERE item_key='events.public-invoice-po-report') THEN
   INSERT INTO public.role_access_item(item_type,item_key,label,parent_id,display_order,is_active)
   VALUES('page','events.public-invoice-po-report','Public Invoice / PO Registrations',parent,100,true);
 END IF;
END $$;
-- Absence means allowed: initialise only this new leaf without changing siblings.
UPDATE public.role SET excluded_features =
 CASE WHEN regexp_replace(lower(name),'[ _-]','','g')='superadmin'
 THEN array_remove(coalesce(excluded_features,ARRAY[]::text[]),'events.public-invoice-po-report')
 ELSE array_append(coalesce(excluded_features,ARRAY[]::text[]),'events.public-invoice-po-report') END
WHERE regexp_replace(lower(name),'[ _-]','','g')='superadmin'
 OR NOT ('events.public-invoice-po-report'=ANY(coalesce(excluded_features,ARRAY[]::text[])));
CREATE OR REPLACE FUNCTION public.default_public_invoice_po_report_permission() RETURNS trigger
LANGUAGE plpgsql SET search_path=public AS $$
BEGIN
 IF regexp_replace(lower(coalesce(NEW.name,'')),'[ _-]','','g')<>'superadmin'
 AND NOT ('events.public-invoice-po-report'=ANY(coalesce(NEW.excluded_features,ARRAY[]::text[]))) THEN
   NEW.excluded_features:=array_append(coalesce(NEW.excluded_features,ARRAY[]::text[]),'events.public-invoice-po-report');
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS default_public_invoice_po_report_permission ON public.role;
CREATE TRIGGER default_public_invoice_po_report_permission BEFORE INSERT ON public.role
FOR EACH ROW EXECUTE FUNCTION public.default_public_invoice_po_report_permission();
COMMIT;
