-- AI Design Studio V2 Phase 0 (Task #2904): renderer_version discriminator.
-- renderer_version 1 = legacy V1 scene-graph documents (read-only from now on)
-- renderer_version 2 = native HTML/CSS/SVG code packages (schemaVersion "2.0")
-- Idempotent.

ALTER TABLE ai_composition
  ADD COLUMN IF NOT EXISTS renderer_version integer NOT NULL DEFAULT 1;

COMMENT ON COLUMN ai_composition.renderer_version IS
  '1 = V1 scene-graph (read-only legacy), 2 = V2 native HTML/CSS/SVG package';
