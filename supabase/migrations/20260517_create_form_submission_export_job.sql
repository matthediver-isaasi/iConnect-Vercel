-- Form Submissions Word Export Jobs (Task #907)
-- Asynchronous, background-job pipeline for large Word exports that would
-- otherwise hit the 60-second serverless invocation limit. Jobs are created
-- by the admin UI, processed by a long-running worker invocation
-- (maxDuration extended), and downloaded once the .docx has been uploaded
-- to Supabase storage.

CREATE TABLE IF NOT EXISTS form_submission_export_job (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  requested_by_member_id UUID,
  status TEXT NOT NULL DEFAULT 'queued',
  phase TEXT NOT NULL DEFAULT 'queued',
  processed INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL DEFAULT 0,
  submission_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  selected_options JSONB NOT NULL DEFAULT '[]'::jsonb,
  scope TEXT,
  document_title TEXT,
  file_name TEXT,
  storage_bucket TEXT,
  storage_path TEXT,
  file_size_bytes BIGINT,
  worker_token UUID NOT NULL DEFAULT gen_random_uuid(),
  prepared_sections JSONB NOT NULL DEFAULT '[]'::jsonb,
  tenant_snapshot JSONB,
  error_message TEXT,
  started_at TIMESTAMP WITH TIME ZONE,
  completed_at TIMESTAMP WITH TIME ZONE,
  heartbeat_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_form_submission_export_job_tenant
  ON form_submission_export_job(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_form_submission_export_job_status
  ON form_submission_export_job(status, created_at);

COMMENT ON TABLE form_submission_export_job IS
  'Background-job pipeline for large form-submission Word exports. The worker '
  'invocation produces a .docx in Supabase storage so exports of 1000+ '
  'submissions can complete past the 60-second per-request platform timeout.';
