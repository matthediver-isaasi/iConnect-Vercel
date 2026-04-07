-- Article Brief: Main editorial brief record
CREATE TABLE IF NOT EXISTS article_brief (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  summary TEXT,
  instructions TEXT,
  target_audience TEXT,
  tone_guidance TEXT,
  word_count_target INTEGER,
  deadline TIMESTAMPTZ,
  priority TEXT DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high', 'urgent')),
  category TEXT,
  notes TEXT,
  attachments JSONB DEFAULT '[]'::jsonb,
  status TEXT DEFAULT 'new' CHECK (status IN ('new', 'assigned', 'in_progress', 'under_review', 'changes_requested', 'approved', 'rejected')),
  assigned_writer_id UUID REFERENCES member(id) ON DELETE SET NULL,
  assigned_date TIMESTAMPTZ,
  review_owner_id UUID REFERENCES member(id) ON DELETE SET NULL,
  assignment_note TEXT,
  tenant_id UUID NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  created_by UUID REFERENCES member(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Article Brief Version: Draft submissions
CREATE TABLE IF NOT EXISTS article_brief_version (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  article_brief_id UUID NOT NULL REFERENCES article_brief(id) ON DELETE CASCADE,
  version_number INTEGER NOT NULL,
  uploaded_by UUID REFERENCES member(id) ON DELETE SET NULL,
  upload_date TIMESTAMPTZ DEFAULT NOW(),
  submission_note TEXT,
  file_url TEXT,
  file_name TEXT,
  status_at_upload TEXT,
  tenant_id UUID NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(article_brief_id, version_number)
);

-- Article Brief Comment: Review feedback on versions
CREATE TABLE IF NOT EXISTS article_brief_comment (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  article_brief_id UUID NOT NULL REFERENCES article_brief(id) ON DELETE CASCADE,
  version_id UUID REFERENCES article_brief_version(id) ON DELETE SET NULL,
  comment_text TEXT NOT NULL,
  category TEXT DEFAULT 'other' CHECK (category IN ('structure', 'tone', 'factual', 'grammar', 'missing_info', 'other')),
  status TEXT DEFAULT 'open' CHECK (status IN ('open', 'acknowledged', 'actioned', 'closed')),
  created_by UUID REFERENCES member(id) ON DELETE SET NULL,
  tenant_id UUID NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Article Brief Activity: Audit log
CREATE TABLE IF NOT EXISTS article_brief_activity (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  article_brief_id UUID NOT NULL REFERENCES article_brief(id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK (action IN ('brief_created', 'writer_assigned', 'status_changed', 'version_uploaded', 'comment_added', 'comment_actioned', 'comment_closed', 'approved', 'rejected')),
  description TEXT,
  performed_by UUID REFERENCES member(id) ON DELETE SET NULL,
  metadata JSONB DEFAULT '{}'::jsonb,
  tenant_id UUID NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_article_brief_tenant ON article_brief(tenant_id);
CREATE INDEX IF NOT EXISTS idx_article_brief_status ON article_brief(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_article_brief_writer ON article_brief(assigned_writer_id);
CREATE INDEX IF NOT EXISTS idx_article_brief_version_brief ON article_brief_version(article_brief_id);
CREATE INDEX IF NOT EXISTS idx_article_brief_version_tenant ON article_brief_version(tenant_id);
CREATE INDEX IF NOT EXISTS idx_article_brief_comment_brief ON article_brief_comment(article_brief_id);
CREATE INDEX IF NOT EXISTS idx_article_brief_comment_version ON article_brief_comment(version_id);
CREATE INDEX IF NOT EXISTS idx_article_brief_comment_tenant ON article_brief_comment(tenant_id);
CREATE INDEX IF NOT EXISTS idx_article_brief_activity_brief ON article_brief_activity(article_brief_id);
CREATE INDEX IF NOT EXISTS idx_article_brief_activity_tenant ON article_brief_activity(tenant_id);
