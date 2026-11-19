-- Display-only amendments. Original cart receipts, allocation and invoice
-- authority remain immutable. Only an explicitly approved operator writes.
BEGIN;
CREATE TABLE public.form_cart_display_amendment (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL,
 submission_id uuid NOT NULL,
 original_item_id uuid NOT NULL,
 replacement_item_id uuid NOT NULL,
 original_name text NOT NULL,
 replacement_name text NOT NULL,
 reason text NOT NULL CHECK(length(trim(reason))>0),
 approved_by text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,submission_id,original_item_id),
 CHECK(original_item_id<>replacement_item_id)
);
ALTER TABLE public.form_cart_display_amendment ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.form_cart_display_amendment FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.form_cart_display_amendment TO service_role;

CREATE FUNCTION public.project_form_cart_display_amendments() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE receipt jsonb; lines jsonb; a public.form_cart_display_amendment;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.form_cart_display_amendment
   WHERE tenant_id=NEW.tenant_id AND submission_id=NEW.id) THEN RETURN NEW; END IF;
 SELECT terms INTO STRICT receipt FROM public.form_cart_receipt
   WHERE tenant_id=NEW.tenant_id AND submission_id=NEW.id;
 FOR a IN SELECT * FROM public.form_cart_display_amendment
   WHERE tenant_id=NEW.tenant_id AND submission_id=NEW.id ORDER BY created_at,id LOOP
   IF (SELECT count(*) FROM jsonb_array_elements(receipt->'lines') l
     WHERE l->>'id'=a.original_item_id::text AND l->>'kind'='bundle'
       AND l->>'name'=a.original_name)<>1 THEN
     RAISE EXCEPTION 'Cart amendment original evidence mismatch';
   END IF;
   SELECT jsonb_agg(CASE WHEN l->>'id'=a.original_item_id::text AND l->>'kind'='bundle'
     THEN l||jsonb_build_object('id',a.replacement_item_id,'name',a.replacement_name,
       'amendment',jsonb_build_object('id',a.id,'originalItemId',a.original_item_id,
         'originalName',a.original_name,'reason',a.reason,'createdAt',a.created_at))
     ELSE l END ORDER BY n) INTO lines
     FROM jsonb_array_elements(receipt->'lines') WITH ORDINALITY x(l,n);
   receipt:=jsonb_set(receipt,'{lines}',lines);
 END LOOP;
 NEW.submission_data:=jsonb_set(NEW.submission_data,'{__cart_receipt}',receipt);
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.project_form_cart_display_amendments() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER zzzz_form_cart_display_amendments BEFORE UPDATE ON public.form_submission
 FOR EACH ROW EXECUTE FUNCTION public.project_form_cart_display_amendments();
COMMIT;
