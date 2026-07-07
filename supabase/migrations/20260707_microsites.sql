-- Task #2426: Tenant microsites with path-prefix chrome.
-- Groups of public pages under /{prefix}/{slug} with their own header/footer/nav.
-- Idempotent: safe to re-run.

CREATE TABLE IF NOT EXISTS microsite (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  name text NOT NULL,
  path_prefix text NOT NULL,
  description text,
  is_active boolean NOT NULL DEFAULT true,
  logo_url text,
  header_config jsonb NOT NULL DEFAULT '{}'::jsonb,
  footer_config jsonb NOT NULL DEFAULT '{}'::jsonb,
  home_page_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- One prefix per tenant.
CREATE UNIQUE INDEX IF NOT EXISTS microsite_tenant_prefix_uidx
  ON microsite (tenant_id, path_prefix);

CREATE INDEX IF NOT EXISTS microsite_tenant_idx ON microsite (tenant_id);

-- Nullable scoping columns: NULL = default tenant site (existing behaviour).
ALTER TABLE navigation_item ADD COLUMN IF NOT EXISTS microsite_id uuid;
ALTER TABLE i_edit_page ADD COLUMN IF NOT EXISTS microsite_id uuid;

CREATE INDEX IF NOT EXISTS navigation_item_microsite_idx
  ON navigation_item (microsite_id) WHERE microsite_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS i_edit_page_microsite_idx
  ON i_edit_page (microsite_id) WHERE microsite_id IS NOT NULL;
