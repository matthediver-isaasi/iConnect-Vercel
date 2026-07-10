-- Task #2572: Microsite-scoped typography styles.
--
-- Each typography_style belongs to exactly ONE scope: the main tenant site
-- (microsite_id IS NULL) or a single microsite (microsite_id = <microsite.id>).
-- NULL everywhere means "main site" so all existing styles keep behaving as
-- main-site styles with zero change. Deleting a microsite cascades its styles.
-- Idempotent — safe to re-run.

BEGIN;

ALTER TABLE public.typography_style
  ADD COLUMN IF NOT EXISTS microsite_id UUID
    REFERENCES public.microsite(id) ON DELETE CASCADE;

-- Lookups by microsite (public scope resolution) and by (tenant, scope, type)
-- (admin scope switcher + default resolution per style type).
CREATE INDEX IF NOT EXISTS idx_typography_style_microsite
  ON public.typography_style (microsite_id);

CREATE INDEX IF NOT EXISTS idx_typography_style_tenant_microsite_type
  ON public.typography_style (tenant_id, microsite_id, style_type);

COMMIT;
