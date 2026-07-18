-- AI Design Studio Phase 4 — governance (Task #2852).
-- Idempotent. Org-level configuration + usage metering for the AI Composition
-- system (spec §27/§28).

-- Per-tenant AI Design Studio configuration. One row per tenant; settings is
-- a sanitized jsonb blob (defaults live in api/_lib/aiDesignStudioSettings.js).
CREATE TABLE IF NOT EXISTS ai_design_studio_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL UNIQUE,
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Usage/audit event per billable AI operation (generation, edit proposal,
-- image generation/edit, visual review). Cost is an ESTIMATE in USD.
CREATE TABLE IF NOT EXISTS ai_usage_event (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  member_id uuid,
  page_id uuid,
  composition_id uuid,
  section_id text,
  operation text NOT NULL,          -- generation | section_generation | edit | redesign | image_generation | image_edit | visual_review
  model text,
  units jsonb NOT NULL DEFAULT '{}'::jsonb,  -- { textCalls, images, reviewCycles, promptChars }
  estimated_cost numeric(10,5) NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'succeeded',  -- succeeded | failed | blocked
  dedupe_hash text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_usage_event_tenant_time
  ON ai_usage_event (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_usage_event_tenant_member_time
  ON ai_usage_event (tenant_id, member_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_usage_event_dedupe
  ON ai_usage_event (tenant_id, dedupe_hash, created_at DESC);
