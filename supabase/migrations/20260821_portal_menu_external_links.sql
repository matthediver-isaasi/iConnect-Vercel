ALTER TABLE public.portal_menu
  ADD COLUMN IF NOT EXISTS link_type TEXT NOT NULL DEFAULT 'internal',
  ADD COLUMN IF NOT EXISTS open_in_new_tab BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE public.portal_menu
  DROP CONSTRAINT IF EXISTS portal_menu_link_type_check,
  ADD CONSTRAINT portal_menu_link_type_check
    CHECK (link_type IN ('internal', 'external'));

ALTER TABLE public.portal_menu
  DROP CONSTRAINT IF EXISTS portal_menu_external_url_check,
  ADD CONSTRAINT portal_menu_external_url_check
    CHECK (
      link_type <> 'external'
      OR (
        url IS NOT NULL
        AND url ~* '^https?://[^/?#[:space:]]+([/?#][^[:space:]]*)?$'
      )
    );

ALTER TABLE public.portal_menu
  DROP CONSTRAINT IF EXISTS portal_menu_new_tab_external_only_check,
  ADD CONSTRAINT portal_menu_new_tab_external_only_check
    CHECK (open_in_new_tab = FALSE OR link_type = 'external');

CREATE OR REPLACE FUNCTION public.enforce_portal_menu_external_leaf()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.link_type = 'external' AND EXISTS (
    SELECT 1
    FROM public.portal_menu child
    WHERE child.parent_id = NEW.id::text
  ) THEN
    RAISE EXCEPTION 'External portal menu links cannot have sub-items'
      USING ERRCODE = '23514', CONSTRAINT = 'portal_menu_external_leaf';
  END IF;

  IF NULLIF(NEW.parent_id, '') IS NOT NULL AND EXISTS (
    SELECT 1
    FROM public.portal_menu parent
    WHERE parent.id::text = NEW.parent_id
      AND parent.link_type = 'external'
  ) THEN
    RAISE EXCEPTION 'External portal menu links cannot be parent items'
      USING ERRCODE = '23514', CONSTRAINT = 'portal_menu_external_leaf';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS portal_menu_external_leaf_trigger ON public.portal_menu;
CREATE TRIGGER portal_menu_external_leaf_trigger
  BEFORE INSERT OR UPDATE OF link_type, parent_id
  ON public.portal_menu
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_portal_menu_external_leaf();