-- Case Study Uploads: provider self-upload + team manual upload, versioned
-- Adds a versioned uploads table for case-study deliverables alongside the
-- existing case-study form workflow on article_brief.

CREATE TABLE IF NOT EXISTS article_brief_case_study_upload (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  article_brief_id UUID NOT NULL REFERENCES article_brief(id) ON DELETE CASCADE,
  version_number INTEGER NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('staff', 'provider')),
  uploaded_by_member UUID REFERENCES member(id) ON DELETE SET NULL,
  uploaded_by_provider_name TEXT,
  upload_date TIMESTAMPTZ DEFAULT NOW(),
  file_url TEXT NOT NULL,
  storage_path TEXT,
  file_name TEXT,
  file_size BIGINT,
  mime_type TEXT,
  note TEXT,
  tenant_id UUID NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(article_brief_id, version_number)
);

CREATE INDEX IF NOT EXISTS idx_article_brief_case_study_upload_brief
  ON article_brief_case_study_upload(article_brief_id);
CREATE INDEX IF NOT EXISTS idx_article_brief_case_study_upload_tenant
  ON article_brief_case_study_upload(tenant_id);

-- Monotonic counter for case study upload version numbers. Version numbers
-- are ALLOCATED from this counter and never reused, even if a row is later
-- deleted. The UNIQUE(article_brief_id, version_number) constraint above is
-- kept as a safety net.
ALTER TABLE article_brief
  ADD COLUMN IF NOT EXISTS case_study_upload_version_seq INTEGER NOT NULL DEFAULT 0;

-- Initialize the sequence to the current max version for any pre-existing
-- uploads so we don't restart at 0 on databases where rows already exist.
UPDATE article_brief b
SET case_study_upload_version_seq = COALESCE(sub.max_v, 0)
FROM (
  SELECT article_brief_id, MAX(version_number) AS max_v
  FROM article_brief_case_study_upload
  GROUP BY article_brief_id
) sub
WHERE b.id = sub.article_brief_id
  AND b.case_study_upload_version_seq < sub.max_v;

-- Atomic allocator: increments and returns the next version number for a
-- brief in a single statement, guaranteeing uniqueness and no reuse.
CREATE OR REPLACE FUNCTION next_case_study_upload_version(p_brief_id UUID)
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_next INTEGER;
BEGIN
  UPDATE article_brief
     SET case_study_upload_version_seq = case_study_upload_version_seq + 1
   WHERE id = p_brief_id
   RETURNING case_study_upload_version_seq INTO v_next;
  RETURN v_next;
END;
$$;

-- Public upload token columns on article_brief.
-- The token is regenerated each time a case study email is sent, invalidating
-- any previous link. It is the only handle the unauthenticated provider page
-- has on the brief, so it must be unguessable and unique.
ALTER TABLE article_brief
  ADD COLUMN IF NOT EXISTS case_study_upload_token TEXT;
ALTER TABLE article_brief
  ADD COLUMN IF NOT EXISTS case_study_upload_token_created_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS idx_article_brief_case_study_upload_token
  ON article_brief(case_study_upload_token)
  WHERE case_study_upload_token IS NOT NULL;

-- Extend the activity action CHECK constraint to include the new actions.
ALTER TABLE article_brief_activity
  DROP CONSTRAINT IF EXISTS article_brief_activity_action_check;

ALTER TABLE article_brief_activity
  ADD CONSTRAINT article_brief_activity_action_check
  CHECK (action IN (
    'brief_created',
    'writer_assigned',
    'status_changed',
    'version_uploaded',
    'comment_added',
    'comment_actioned',
    'comment_closed',
    'approved',
    'rejected',
    'case_study_upload_added',
    'case_study_upload_deleted'
  ));
