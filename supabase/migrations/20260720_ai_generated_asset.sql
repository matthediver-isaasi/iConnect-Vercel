-- AI Design Studio Phase 3 — generated image/illustration asset metadata (Task #2851).
-- Idempotent. Spec §19: generated imagery lives in the tenant media library
-- (file_repository); this table carries the generation metadata that
-- file_repository has no columns for (prompt, model, aspect, placement,
-- alt text, usage, parent asset, cost).

CREATE TABLE IF NOT EXISTS ai_generated_asset (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  file_repository_id uuid NOT NULL,
  composition_id uuid,
  element_id text,
  created_by uuid,
  prompt text,
  model text,
  provider text,
  aspect_ratio text,
  placement text,
  alt_text text,
  usage_status text NOT NULL DEFAULT 'in_use',   -- in_use | replaced | alternative | orphaned
  parent_asset_id uuid,                          -- ai_generated_asset row this was edited from
  generation_cost numeric,
  brief jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_generated_asset_tenant
  ON ai_generated_asset (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_generated_asset_file
  ON ai_generated_asset (file_repository_id);
CREATE INDEX IF NOT EXISTS idx_ai_generated_asset_comp
  ON ai_generated_asset (composition_id);
