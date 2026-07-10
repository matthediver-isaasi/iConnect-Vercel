-- Task #2549: Per-tenant installable Google fonts.
--
-- Creates the `installed_font` table (tenant-scoped) and seeds every existing
-- tenant with the current 16 curated fonts so behaviour is unchanged. A
-- one-time backfill cohort guards re-runs so fonts a tenant later removes are
-- never re-added. Idempotent — safe to re-run.

BEGIN;

CREATE TABLE IF NOT EXISTS public.installed_font (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenant(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  font_stack TEXT NOT NULL,
  google_family TEXT,
  source TEXT NOT NULL DEFAULT 'google',
  is_base BOOLEAN NOT NULL DEFAULT FALSE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_installed_font_tenant_stack
  ON public.installed_font (tenant_id, font_stack);

CREATE INDEX IF NOT EXISTS idx_installed_font_tenant
  ON public.installed_font (tenant_id);

-- One-time backfill cohort: capture the tenants existing at first run so a
-- re-run of this migration never re-adds fonts a tenant has since removed.
CREATE TABLE IF NOT EXISTS installed_font_backfill_state (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  first_run_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS installed_font_backfill_cohort (
  tenant_id UUID PRIMARY KEY,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO installed_font_backfill_cohort (tenant_id)
SELECT id FROM tenant
WHERE NOT EXISTS (SELECT 1 FROM installed_font_backfill_state)
ON CONFLICT (tenant_id) DO NOTHING;

INSERT INTO installed_font_backfill_state (singleton) VALUES (TRUE)
ON CONFLICT (singleton) DO NOTHING;

-- Seed the curated 16 for the captured cohort. Poppins + Degular Medium are
-- flagged is_base (always-on, never removable).
INSERT INTO public.installed_font (tenant_id, label, font_stack, google_family, source, is_base)
SELECT c.tenant_id, f.label, f.font_stack, f.google_family, f.source, f.is_base
FROM installed_font_backfill_cohort c
CROSS JOIN (
  VALUES
    ('Arial', 'Arial, sans-serif', NULL, 'system', FALSE),
    ('Degular Medium', '''Degular Medium'', ''Poppins'', sans-serif', NULL, 'system', TRUE),
    ('Georgia', 'Georgia, serif', NULL, 'system', FALSE),
    ('Lato', 'Lato, sans-serif', 'Lato', 'google', FALSE),
    ('Merriweather', '''Merriweather'', serif', 'Merriweather', 'google', FALSE),
    ('Montserrat', 'Montserrat, sans-serif', 'Montserrat', 'google', FALSE),
    ('Open Sans', '''Open Sans'', sans-serif', 'Open+Sans', 'google', FALSE),
    ('Oswald', 'Oswald, sans-serif', 'Oswald', 'google', FALSE),
    ('Playfair Display', '''Playfair Display'', serif', 'Playfair+Display', 'google', FALSE),
    ('Poppins', 'Poppins, sans-serif', 'Poppins', 'google', TRUE),
    ('Raleway', 'Raleway, sans-serif', 'Raleway', 'google', FALSE),
    ('Roboto', 'Roboto, sans-serif', 'Roboto', 'google', FALSE),
    ('Source Sans Pro', '''Source Sans Pro'', sans-serif', 'Source+Sans+Pro', 'google', FALSE),
    ('Times New Roman', '''Times New Roman'', serif', NULL, 'system', FALSE),
    ('Urbanist', 'Urbanist, sans-serif', 'Urbanist', 'google', FALSE),
    ('Verdana', 'Verdana, sans-serif', NULL, 'system', FALSE)
) AS f(label, font_stack, google_family, source, is_base)
ON CONFLICT (tenant_id, font_stack) DO NOTHING;

COMMIT;
