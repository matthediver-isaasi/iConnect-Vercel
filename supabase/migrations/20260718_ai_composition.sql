-- AI Design Studio Phase 1 — AI Composition storage & versioning (Task #2849).
-- Idempotent. Design: guides/ai-design-studio-architecture.md §8.

CREATE TABLE IF NOT EXISTS ai_composition (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  page_id uuid,
  name text NOT NULL DEFAULT 'AI Composition',
  composition_type text NOT NULL DEFAULT 'section',
  status text NOT NULL DEFAULT 'draft',
  current_version_id uuid,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_composition_tenant ON ai_composition (tenant_id);
CREATE INDEX IF NOT EXISTS idx_ai_composition_page ON ai_composition (page_id);

CREATE TABLE IF NOT EXISTS ai_composition_version (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  composition_id uuid NOT NULL REFERENCES ai_composition (id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL,
  parent_version_id uuid,
  document jsonb NOT NULL,
  change_summary text,
  operation_type text NOT NULL DEFAULT 'generation',
  validation_result jsonb,
  generation_metadata jsonb,
  is_alternative boolean NOT NULL DEFAULT false,
  locked boolean NOT NULL DEFAULT false,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_composition_version_comp
  ON ai_composition_version (composition_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_composition_version_tenant
  ON ai_composition_version (tenant_id);

-- Generation jobs: one row per generation run; resumable stage-by-stage so
-- each serverless invocation advances one stage (context → plan → copy →
-- document). State holds intermediate stage outputs for the next invocation.
CREATE TABLE IF NOT EXISTS ai_composition_job (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  page_id uuid,
  composition_id uuid,
  brief text NOT NULL,
  options jsonb NOT NULL DEFAULT '{}'::jsonb,
  stage text NOT NULL DEFAULT 'context',
  status text NOT NULL DEFAULT 'running',
  state jsonb NOT NULL DEFAULT '{}'::jsonb,
  error text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_composition_job_tenant
  ON ai_composition_job (tenant_id, created_at DESC);
