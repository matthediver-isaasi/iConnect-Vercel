BEGIN;
ALTER TABLE public.sales_catalogue_product ADD COLUMN membership_schedule_id uuid
  REFERENCES public.membership_tier_config(id);
ALTER TABLE public.sales_catalogue_product ADD CONSTRAINT sales_product_membership_exclusive
  CHECK (membership_schedule_id IS NULL OR (event_reference_kind IS NULL AND space_requirement_id IS NULL));

CREATE FUNCTION public.guard_sales_membership_schedule() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF NEW.membership_schedule_id IS NOT NULL THEN
    PERFORM 1 FROM membership_tier_config WHERE id=NEW.membership_schedule_id
      AND tenant_id=NEW.tenant_id AND COALESCE(structure_scope_type,'organization')='organization'
      AND is_active IS DISTINCT FROM false FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Select an active organisational membership schedule in this tenant' USING ERRCODE='22023'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER sales_membership_schedule_guard BEFORE INSERT OR UPDATE OF membership_schedule_id,tenant_id
  ON public.sales_catalogue_product FOR EACH ROW EXECUTE FUNCTION public.guard_sales_membership_schedule();
REVOKE ALL ON FUNCTION public.guard_sales_membership_schedule() FROM PUBLIC,anon,authenticated;

DO $patch$
DECLARE definition text;
BEGIN
  SELECT pg_get_functiondef('public.create_sales_catalogue_record(uuid,text,jsonb,jsonb,text,text)'::regprocedure) INTO definition;
  IF position('ticket_type_id, create_task_on_acceptance,' IN definition)=0
    OR position('COALESCE(v_product.create_task_on_acceptance, false),' IN definition)=0 THEN
    RAISE EXCEPTION 'Catalogue creation contract changed; review membership column insertion';
  END IF;
  definition := replace(definition,'ticket_type_id, create_task_on_acceptance,',
    'ticket_type_id, create_task_on_acceptance, membership_schedule_id,');
  definition := replace(definition,'COALESCE(v_product.create_task_on_acceptance, false),',
    'COALESCE(v_product.create_task_on_acceptance, false), v_product.membership_schedule_id,');
  EXECUTE definition;
END $patch$;
COMMIT;
