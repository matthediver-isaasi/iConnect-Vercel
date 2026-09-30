-- External Writer: People outside the organisation who write briefs
CREATE TABLE IF NOT EXISTS external_writer (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  organisation TEXT,
  job_title TEXT,
  email TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(tenant_id, email)
);

-- External Writer Document: NDA documents uploaded per external writer
CREATE TABLE IF NOT EXISTS external_writer_document (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  external_writer_id UUID NOT NULL REFERENCES external_writer(id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  file_name TEXT NOT NULL,
  file_url TEXT NOT NULL,
  storage_path TEXT,
  bucket TEXT,
  uploaded_at TIMESTAMPTZ DEFAULT NOW()
);

-- Add external_writer_id to article_brief
ALTER TABLE article_brief
  ADD COLUMN IF NOT EXISTS external_writer_id UUID REFERENCES external_writer(id) ON DELETE SET NULL;

-- Indexes
CREATE INDEX IF NOT EXISTS idx_external_writer_tenant ON external_writer(tenant_id);
CREATE INDEX IF NOT EXISTS idx_external_writer_email ON external_writer(tenant_id, email);
CREATE INDEX IF NOT EXISTS idx_external_writer_document_writer ON external_writer_document(external_writer_id);
CREATE INDEX IF NOT EXISTS idx_external_writer_document_tenant ON external_writer_document(tenant_id);
CREATE INDEX IF NOT EXISTS idx_article_brief_external_writer ON article_brief(external_writer_id);
