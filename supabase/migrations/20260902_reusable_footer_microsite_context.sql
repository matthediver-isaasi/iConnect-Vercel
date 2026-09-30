-- Give reusable Canvas footers an authoring scope so the editor can offer the
-- same typography, button styles, and swatches as a microsite's Canvas pages.
-- This filename intentionally sorts after 20260902_canvas_reusable_footers.sql.

ALTER TABLE public.canvas_footer
  ADD COLUMN IF NOT EXISTS microsite_id uuid
    REFERENCES public.microsite(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_canvas_footer_tenant_microsite
  ON public.canvas_footer (tenant_id, microsite_id);

CREATE OR REPLACE FUNCTION public.assert_canvas_footer_context_tenant()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  context_tenant text;
BEGIN
  IF NEW.microsite_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT m.tenant_id::text
    INTO context_tenant
    FROM public.microsite m
   WHERE m.id = NEW.microsite_id;

  IF context_tenant IS NULL OR context_tenant <> NEW.tenant_id::text THEN
    RAISE EXCEPTION 'Canvas footer microsite belongs to a different tenant'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS canvas_footer_context_tenant_guard ON public.canvas_footer;
CREATE TRIGGER canvas_footer_context_tenant_guard
  BEFORE INSERT OR UPDATE OF tenant_id, microsite_id ON public.canvas_footer
  FOR EACH ROW EXECUTE FUNCTION public.assert_canvas_footer_context_tenant();

CREATE OR REPLACE FUNCTION public.create_canvas_footer_for_context(
  p_tenant_id text,
  p_name text,
  p_design jsonb,
  p_created_by text DEFAULT NULL,
  p_microsite_id uuid DEFAULT NULL,
  p_assign_to_microsite boolean DEFAULT false
)
RETURNS SETOF public.canvas_footer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  created public.canvas_footer%ROWTYPE;
BEGIN
  IF p_microsite_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
      FROM public.microsite m
     WHERE m.id = p_microsite_id
       AND m.tenant_id::text = p_tenant_id
       AND m.is_active IS NOT FALSE
  ) THEN
    RAISE EXCEPTION 'Microsite not found for tenant'
      USING ERRCODE = '23514';
  END IF;

  INSERT INTO public.canvas_footer (
    tenant_id, name, design, created_by, updated_by, microsite_id
  )
  VALUES (
    p_tenant_id, p_name, p_design, p_created_by, p_created_by, p_microsite_id
  )
  RETURNING * INTO created;

  IF p_assign_to_microsite AND p_microsite_id IS NOT NULL THEN
    UPDATE public.microsite
       SET footer_source = 'canvas',
           canvas_footer_id = created.id,
           updated_at = now()
     WHERE id = p_microsite_id
       AND tenant_id::text = p_tenant_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Microsite assignment failed'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEXT created;
END;
$$;

REVOKE ALL ON FUNCTION public.create_canvas_footer_for_context(
  text, text, jsonb, text, uuid, boolean
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_canvas_footer_for_context(
  text, text, jsonb, text, uuid, boolean
) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_canvas_footer_for_context(
  text, text, jsonb, text, uuid, boolean
) TO service_role;