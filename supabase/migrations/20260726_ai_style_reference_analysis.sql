-- Task #2879: structured reference Design DNA persistence.
-- Stores each captured + analysed style reference so analyses can be
-- cached (by tenant + normalised URL + capture/analyser versions),
-- refreshed, reused and inspected in the admin debug view.
-- Idempotent.

CREATE TABLE IF NOT EXISTS ai_style_reference_analysis (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  source_url TEXT,
  normalized_url TEXT,
  final_url TEXT,
  source_type TEXT NOT NULL DEFAULT 'url',
  status TEXT NOT NULL DEFAULT 'capturing',
  capture_version TEXT,
  analyser_version TEXT,
  schema_version TEXT,
  screenshots JSONB NOT NULL DEFAULT '[]'::jsonb,
  extracted_metrics JSONB,
  design_dna JSONB,
  quality_score NUMERIC,
  quality_warnings JSONB,
  model TEXT,
  token_usage JSONB,
  estimated_cost NUMERIC,
  debug JSONB,
  content_hash TEXT,
  error TEXT,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_ai_style_ref_analysis_tenant
  ON ai_style_reference_analysis (tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ai_style_ref_analysis_cache
  ON ai_style_reference_analysis (tenant_id, normalized_url, capture_version, analyser_version)
  WHERE status = 'complete';
