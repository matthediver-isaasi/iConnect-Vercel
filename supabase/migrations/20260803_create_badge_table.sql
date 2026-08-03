-- Task #3282: Badge library table for the Badge Management admin page.
-- Tenant-scoped library of badges (name, description, image, active flag)
-- managed via /BadgeManagement, gated by RBAC key admin.badges.
-- Idempotent: safe to run repeatedly.

CREATE TABLE IF NOT EXISTS public.badge (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  image_url TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_date TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_date TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_badge_tenant ON public.badge (tenant_id);
