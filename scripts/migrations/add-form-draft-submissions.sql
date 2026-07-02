-- Form Draft Submissions - stores partial form submissions for "Save as you go" functionality
-- Run this migration to create the table in Supabase

CREATE TABLE IF NOT EXISTS form_draft_submission (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id VARCHAR NOT NULL,
  form_id VARCHAR NOT NULL,
  
  -- Security: store hash of resume token, not the raw token
  resume_token_hash TEXT NOT NULL UNIQUE,
  
  -- Draft data
  draft_data JSONB NOT NULL DEFAULT '{}',
  
  -- Metadata for schema drift detection
  form_updated_at TIMESTAMP,
  current_page_index INTEGER DEFAULT 0,
  
  -- Optional contact info for email reminders
  contact_email VARCHAR(255),
  
  -- Lifecycle
  expires_at TIMESTAMP NOT NULL,
  last_saved_at TIMESTAMP DEFAULT NOW(),
  created_at TIMESTAMP DEFAULT NOW()
);

-- Index for efficient tenant+form queries and cleanup jobs
CREATE INDEX IF NOT EXISTS idx_form_draft_tenant_form ON form_draft_submission(tenant_id, form_id);

-- Index for expired draft cleanup
CREATE INDEX IF NOT EXISTS idx_form_draft_expires ON form_draft_submission(expires_at);

-- Add RLS policies
ALTER TABLE form_draft_submission ENABLE ROW LEVEL SECURITY;

-- Allow service role full access
CREATE POLICY "Service role has full access to form_draft_submission" ON form_draft_submission
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
