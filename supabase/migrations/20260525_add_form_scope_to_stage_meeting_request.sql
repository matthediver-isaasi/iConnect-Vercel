-- Migration: Add form_id and form_due_diligence_config_id to stage_meeting_request
-- Brings stage_meeting_request in line with the other stage action tables so
-- meeting requests can be safely scoped per form (instead of relying on
-- stage-id collisions across forms).

ALTER TABLE stage_meeting_request
  ADD COLUMN IF NOT EXISTS form_id UUID REFERENCES form(id) ON DELETE CASCADE;

ALTER TABLE stage_meeting_request
  ADD COLUMN IF NOT EXISTS form_due_diligence_config_id UUID
    REFERENCES form_due_diligence_config(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_stage_meeting_request_form
  ON stage_meeting_request(form_id);

CREATE INDEX IF NOT EXISTS idx_stage_meeting_request_stage_form
  ON stage_meeting_request(due_diligence_stage_id, form_id);

-- Best-effort backfill: for any existing meeting request whose stage id
-- matches exactly one form's workflow_stages JSON within its tenant,
-- attach that form_id / config_id. Rows whose stage id appears in zero or
-- multiple forms' workflow_stages are left NULL and continue to behave as
-- before (matched only by stage id), which is the legacy behavior.
WITH stage_form_map AS (
  SELECT
    cfg.tenant_id,
    cfg.form_id,
    cfg.id AS config_id,
    stage_elem ->> 'id' AS stage_id
  FROM form_due_diligence_config cfg
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE
      WHEN jsonb_typeof(cfg.workflow_stages) = 'array' THEN cfg.workflow_stages
      ELSE '[]'::jsonb
    END
  ) AS stage_elem
  WHERE stage_elem ? 'id'
),
unique_map AS (
  SELECT tenant_id, stage_id,
         MIN(form_id) AS form_id,
         MIN(config_id) AS config_id,
         COUNT(*) AS hit_count
  FROM stage_form_map
  GROUP BY tenant_id, stage_id
)
UPDATE stage_meeting_request mr
SET form_id = um.form_id,
    form_due_diligence_config_id = um.config_id
FROM unique_map um
WHERE mr.tenant_id = um.tenant_id
  AND mr.due_diligence_stage_id = um.stage_id
  AND um.hit_count = 1
  AND (mr.form_id IS NULL OR mr.form_due_diligence_config_id IS NULL);
