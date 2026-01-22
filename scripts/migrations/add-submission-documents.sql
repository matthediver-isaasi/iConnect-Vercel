-- Submission Documents Table Migration
-- Run this in Supabase SQL Editor
-- Tracks document versions, approval status, and comments for form submission files

-- Create submission_document table for tracking document versions
CREATE TABLE IF NOT EXISTS submission_document (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  form_submission_id UUID NOT NULL REFERENCES form_submission(id) ON DELETE CASCADE,
  
  -- Document identification --
  field_name TEXT NOT NULL, -- The form field name this document is for
  original_file_name TEXT NOT NULL, -- Original filename from upload
  
  -- Version tracking
  version INTEGER NOT NULL DEFAULT 1,
  is_current_version BOOLEAN NOT NULL DEFAULT true,
  superseded_by_id UUID REFERENCES submission_document(id),
  
  -- File metadata
  file_url TEXT NOT NULL,
  file_name TEXT NOT NULL,
  file_size INTEGER,
  mime_type TEXT,
  
  -- Status: pending, approved, rejected, aged
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'aged')),
  status_changed_at TIMESTAMP WITH TIME ZONE,
  status_changed_by TEXT, -- Email of member who changed status
  
  -- Timestamps
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create submission_document_comment table for per-version comments
CREATE TABLE IF NOT EXISTS submission_document_comment (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  submission_document_id UUID NOT NULL REFERENCES submission_document(id) ON DELETE CASCADE,
  
  -- Comment content
  comment TEXT NOT NULL,
  
  -- Author info
  author_email TEXT NOT NULL,
  author_name TEXT,
  
  -- Timestamps
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes for efficient querying
CREATE INDEX IF NOT EXISTS idx_submission_document_tenant ON submission_document(tenant_id);
CREATE INDEX IF NOT EXISTS idx_submission_document_form_submission ON submission_document(form_submission_id);
CREATE INDEX IF NOT EXISTS idx_submission_document_field ON submission_document(form_submission_id, field_name);
CREATE INDEX IF NOT EXISTS idx_submission_document_current ON submission_document(form_submission_id, is_current_version) WHERE is_current_version = true;
CREATE INDEX IF NOT EXISTS idx_submission_document_status ON submission_document(status);

CREATE INDEX IF NOT EXISTS idx_submission_document_comment_tenant ON submission_document_comment(tenant_id);
CREATE INDEX IF NOT EXISTS idx_submission_document_comment_document ON submission_document_comment(submission_document_id);

-- Enable RLS
ALTER TABLE submission_document ENABLE ROW LEVEL SECURITY;
ALTER TABLE submission_document_comment ENABLE ROW LEVEL SECURITY;

-- RLS policies for submission_document
CREATE POLICY "Service role can do everything on submission_document" ON submission_document
  FOR ALL USING (true) WITH CHECK (true);

CREATE POLICY "Authenticated users can view tenant documents" ON submission_document
  FOR SELECT USING (
    auth.role() = 'authenticated' AND 
    tenant_id IN (
      SELECT tenant_id FROM tenant_membership WHERE identity_id = auth.uid()::text
    )
  );

-- RLS policies for submission_document_comment
CREATE POLICY "Service role can do everything on submission_document_comment" ON submission_document_comment
  FOR ALL USING (true) WITH CHECK (true);

CREATE POLICY "Authenticated users can view tenant document comments" ON submission_document_comment
  FOR SELECT USING (
    auth.role() = 'authenticated' AND 
    tenant_id IN (
      SELECT tenant_id FROM tenant_membership WHERE identity_id = auth.uid()::text
    )
  );
