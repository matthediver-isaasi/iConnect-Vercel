-- Catalogue visibility only; preserve all existing role exclusions.
BEGIN;
LOCK TABLE public.role_access_item IN SHARE ROW EXCLUSIVE MODE;
DO $$
DECLARE
  commerce_id uuid;
  page_id uuid;
  matching_count integer;
BEGIN
  SELECT count(*) INTO matching_count FROM public.role_access_item
    WHERE item_key='commerce' AND item_type='module' AND is_active;
  IF matching_count <> 1 THEN
    RAISE EXCEPTION 'Expected one active Commerce module';
  END IF;
  SELECT id INTO commerce_id FROM public.role_access_item
    WHERE item_key='commerce' AND item_type='module' AND is_active;
  SELECT count(*) INTO matching_count FROM public.role_access_item
    WHERE item_key='commerce.stripe-payout-report';
  IF matching_count > 1 THEN RAISE EXCEPTION 'Duplicate payout permission entries'; END IF;
  SELECT id INTO page_id FROM public.role_access_item
    WHERE item_key='commerce.stripe-payout-report';
  IF page_id IS NULL THEN
    INSERT INTO public.role_access_item(item_type,item_key,label,parent_id,display_order,is_active)
    SELECT 'page','commerce.stripe-payout-report','Stripe Payout Reconciliation',commerce_id,
      coalesce(max(display_order),-1)+1,true
    FROM public.role_access_item WHERE parent_id=commerce_id;
  ELSE
    UPDATE public.role_access_item SET item_type='page',
      label='Stripe Payout Reconciliation',parent_id=commerce_id,is_active=true
    WHERE id=page_id;
  END IF;
END $$;
COMMIT;
