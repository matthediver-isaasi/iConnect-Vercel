-- Add visual-builder support to email_template.
--
-- `design_json` holds the block-based visual builder design (same shape as
-- email_campaign.design_json). When present, the template was authored in the
-- visual builder and `body` holds the builder-rendered HTML. Legacy templates
-- have design_json IS NULL and continue to open in the ReactQuill HTML editor.
--
-- `editor_type` records which editor authored the template ('html' for legacy
-- ReactQuill, 'visual' for the block builder). Defaults to 'html' so existing
-- rows keep their behaviour.
--
-- Idempotent.

ALTER TABLE email_template
  ADD COLUMN IF NOT EXISTS design_json JSONB;

ALTER TABLE email_template
  ADD COLUMN IF NOT EXISTS editor_type TEXT NOT NULL DEFAULT 'html';
