-- Task #939: Make TypographyStyle.is_default uniqueness per-tenant.
--
-- The existing partial unique indexes `idx_typography_style_default` and
-- `idx_typography_style_default_per_type` were both defined as
--   UNIQUE (style_type) WHERE is_default = true
-- which is a multi-tenancy bug: it means only ONE tenant in the entire
-- platform can have a default per style_type. With more than one tenant
-- needing typography defaults, every other tenant fails to insert a
-- default row with a unique-violation on style_type.
--
-- This migration drops both legacy indexes and replaces them with a single
-- partial unique index keyed on (tenant_id, style_type) WHERE is_default = true
-- so each tenant can independently mark one default per style_type.

BEGIN;

DROP INDEX IF EXISTS idx_typography_style_default;
DROP INDEX IF EXISTS idx_typography_style_default_per_type;

CREATE UNIQUE INDEX IF NOT EXISTS idx_typography_style_default_per_tenant_type
  ON public.typography_style (tenant_id, style_type)
  WHERE is_default = true;

COMMIT;
