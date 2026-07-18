-- AI Design Studio Phase 2 — prompt-led editing conversation history (Task #2850).
-- Idempotent. Spec §14–§17: per-composition conversation with instruction,
-- explicit scope, interpretation, proposed change, accept/reject and the
-- resulting version.

CREATE TABLE IF NOT EXISTS ai_composition_conversation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  composition_id uuid NOT NULL REFERENCES ai_composition (id) ON DELETE CASCADE,
  base_version_id uuid,
  instruction text NOT NULL,
  target jsonb NOT NULL DEFAULT '{}'::jsonb,
  breakpoint text NOT NULL DEFAULT 'all',
  kind text,                     -- patch | section_redesign | composition_redesign | link_request
  summary text,                  -- AI interpretation of the change
  proposal jsonb,                -- { ops? , document? } — server-stored, re-applied on accept
  warnings jsonb,                -- protected-value violations requiring confirmation
  status text NOT NULL DEFAULT 'proposed',  -- proposed | accepted | rejected | superseded
  version_id uuid,               -- version created on accept
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_aic_conversation_comp
  ON ai_composition_conversation (composition_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_aic_conversation_tenant
  ON ai_composition_conversation (tenant_id);
