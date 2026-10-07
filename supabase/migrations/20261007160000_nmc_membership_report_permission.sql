-- Register the existing report permission in the database-backed role editor.
-- Deliberately does not modify roles, member exclusions, or report eligibility.
LOCK TABLE public.role_access_item IN SHARE ROW EXCLUSIVE MODE;

DO $$
DECLARE
  parent uuid;
  existing_count integer;
BEGIN
  IF (SELECT count(*) FROM public.role_access_item
      WHERE item_key = 'membership' AND item_type = 'module' AND is_active = true) <> 1
     OR (SELECT count(*) FROM public.role_access_item WHERE item_key = 'membership') <> 1 THEN
    RAISE EXCEPTION 'Expected one active Membership & Directory module';
  END IF;
  SELECT id INTO parent FROM public.role_access_item WHERE item_key = 'membership';
  SELECT count(*) INTO existing_count FROM public.role_access_item
    WHERE item_key = 'membership.nmc-membership-report';
  IF existing_count > 1 THEN
    RAISE EXCEPTION 'Duplicate NMC report permissions require review';
  ELSIF existing_count = 1 THEN
    IF NOT EXISTS (SELECT 1 FROM public.role_access_item
        WHERE item_key = 'membership.nmc-membership-report'
          AND item_type = 'page' AND parent_id = parent AND is_active = true
          AND label = 'NMC Membership Report (BNMS)') THEN
      RAISE EXCEPTION 'Existing NMC report permission differs; preserve and review';
    END IF;
  ELSE
    INSERT INTO public.role_access_item
      (item_type, item_key, label, parent_id, display_order, is_active)
    SELECT 'page', 'membership.nmc-membership-report',
      'NMC Membership Report (BNMS)', parent, coalesce(max(display_order), -1) + 1, true
    FROM public.role_access_item WHERE parent_id = parent;
  END IF;
END $$;
