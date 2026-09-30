ALTER TABLE member_note
  ALTER COLUMN author_member_id DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS form_submission_id varchar,
  ADD COLUMN IF NOT EXISTS form_mapping_id varchar;

ALTER TABLE organization_note
  ALTER COLUMN member_id DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS form_submission_id varchar,
  ADD COLUMN IF NOT EXISTS form_mapping_id varchar;

ALTER TABLE form_submission
  ADD COLUMN IF NOT EXISTS entity_processing_completed_at timestamptz;

CREATE UNIQUE INDEX IF NOT EXISTS member_note_form_mapping_once
  ON member_note (form_submission_id, form_mapping_id)
  WHERE form_submission_id IS NOT NULL AND form_mapping_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS organization_note_form_mapping_once
  ON organization_note (form_submission_id, form_mapping_id)
  WHERE form_submission_id IS NOT NULL AND form_mapping_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS form_submission_pipeline_entity (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id varchar NOT NULL,
  form_submission_id varchar NOT NULL,
  pipeline_id varchar NOT NULL,
  entity_type varchar NOT NULL CHECK (entity_type IN ('member', 'organization')),
  entity_id varchar NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, form_submission_id, entity_type, pipeline_id)
);

CREATE INDEX IF NOT EXISTS form_submission_pipeline_entity_tenant_submission_idx
  ON form_submission_pipeline_entity (tenant_id, form_submission_id);

REVOKE ALL ON TABLE form_submission_pipeline_entity FROM PUBLIC, anon, authenticated;