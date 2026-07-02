-- Project Management (Trello-style) Database Schema
-- Run this migration in your Supabase SQL Editor

-- Project Boards table
CREATE TABLE IF NOT EXISTS project_board (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  color VARCHAR(20) DEFAULT '#6366f1',
  background_image TEXT,
  is_archived BOOLEAN DEFAULT FALSE,
  visibility VARCHAR(20) DEFAULT 'private', -- 'private', 'team', 'organization'
  settings JSONB DEFAULT '{}',
  created_by UUID NOT NULL, -- tenant_identity id
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Board members (who can access the board)
CREATE TABLE IF NOT EXISTS project_board_member (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  board_id UUID NOT NULL REFERENCES project_board(id) ON DELETE CASCADE,
  identity_id UUID NOT NULL, -- tenant_identity id
  role VARCHAR(20) DEFAULT 'member', -- 'owner', 'admin', 'member', 'viewer'
  added_by UUID, -- tenant_identity id who added this member
  added_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(board_id, identity_id)
);

-- Project Lists (columns in the kanban board)
CREATE TABLE IF NOT EXISTS project_list (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  board_id UUID NOT NULL REFERENCES project_board(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  color VARCHAR(20),
  is_archived BOOLEAN DEFAULT FALSE,
  settings JSONB DEFAULT '{}',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Project Cards (tasks)
CREATE TABLE IF NOT EXISTS project_card (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  list_id UUID NOT NULL REFERENCES project_list(id) ON DELETE CASCADE,
  board_id UUID NOT NULL REFERENCES project_board(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  cover_image TEXT,
  cover_color VARCHAR(20),
  due_date TIMESTAMP,
  due_reminder VARCHAR(20), -- 'none', '1day', '2days', '1week'
  start_date TIMESTAMP,
  is_complete BOOLEAN DEFAULT FALSE,
  completed_at TIMESTAMP,
  completed_by UUID, -- tenant_identity id
  is_archived BOOLEAN DEFAULT FALSE,
  priority VARCHAR(20) DEFAULT 'none', -- 'none', 'low', 'medium', 'high', 'urgent'
  estimated_hours DECIMAL(10,2),
  actual_hours DECIMAL(10,2),
  settings JSONB DEFAULT '{}',
  created_by UUID NOT NULL, -- tenant_identity id
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Card Labels (customizable per board)
CREATE TABLE IF NOT EXISTS project_label (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  board_id UUID NOT NULL REFERENCES project_board(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  color VARCHAR(20) NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Card-Label assignments (many-to-many)
CREATE TABLE IF NOT EXISTS project_card_label (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  card_id UUID NOT NULL REFERENCES project_card(id) ON DELETE CASCADE,
  label_id UUID NOT NULL REFERENCES project_label(id) ON DELETE CASCADE,
  UNIQUE(card_id, label_id)
);

-- Card Assignees (who is assigned to work on a card)
CREATE TABLE IF NOT EXISTS project_card_assignee (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  card_id UUID NOT NULL REFERENCES project_card(id) ON DELETE CASCADE,
  identity_id UUID NOT NULL, -- tenant_identity id
  assigned_by UUID, -- tenant_identity id
  assigned_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(card_id, identity_id)
);

-- Card Comments
CREATE TABLE IF NOT EXISTS project_card_comment (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  card_id UUID NOT NULL REFERENCES project_card(id) ON DELETE CASCADE,
  identity_id UUID NOT NULL, -- tenant_identity id who wrote the comment
  content TEXT NOT NULL,
  is_edited BOOLEAN DEFAULT FALSE,
  edited_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Card Checklist (subtasks)
CREATE TABLE IF NOT EXISTS project_card_checklist (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  card_id UUID NOT NULL REFERENCES project_card(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT 'Checklist',
  position INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Checklist Items
CREATE TABLE IF NOT EXISTS project_checklist_item (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  checklist_id UUID NOT NULL REFERENCES project_card_checklist(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  is_complete BOOLEAN DEFAULT FALSE,
  completed_at TIMESTAMP,
  completed_by UUID, -- tenant_identity id
  position INTEGER NOT NULL DEFAULT 0,
  due_date TIMESTAMP,
  assignee_id UUID, -- tenant_identity id
  created_at TIMESTAMP DEFAULT NOW()
);

-- Card Attachments
CREATE TABLE IF NOT EXISTS project_card_attachment (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  card_id UUID NOT NULL REFERENCES project_card(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  file_type VARCHAR(100),
  file_size INTEGER,
  uploaded_by UUID NOT NULL, -- tenant_identity id
  uploaded_at TIMESTAMP DEFAULT NOW()
);

-- Card Activity Log (audit trail)
CREATE TABLE IF NOT EXISTS project_card_activity (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  card_id UUID NOT NULL REFERENCES project_card(id) ON DELETE CASCADE,
  identity_id UUID NOT NULL, -- who performed the action
  action_type VARCHAR(50) NOT NULL, -- 'created', 'moved', 'assigned', 'completed', 'commented', etc.
  action_data JSONB, -- additional data about the action
  created_at TIMESTAMP DEFAULT NOW()
);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_project_board_tenant ON project_board(tenant_id);
CREATE INDEX IF NOT EXISTS idx_project_board_created_by ON project_board(created_by);
CREATE INDEX IF NOT EXISTS idx_project_board_member_board ON project_board_member(board_id);
CREATE INDEX IF NOT EXISTS idx_project_board_member_identity ON project_board_member(identity_id);
CREATE INDEX IF NOT EXISTS idx_project_list_board ON project_list(board_id);
CREATE INDEX IF NOT EXISTS idx_project_list_position ON project_list(board_id, position);
CREATE INDEX IF NOT EXISTS idx_project_card_list ON project_card(list_id);
CREATE INDEX IF NOT EXISTS idx_project_card_board ON project_card(board_id);
CREATE INDEX IF NOT EXISTS idx_project_card_position ON project_card(list_id, position);
CREATE INDEX IF NOT EXISTS idx_project_card_due_date ON project_card(due_date);
CREATE INDEX IF NOT EXISTS idx_project_label_board ON project_label(board_id);
CREATE INDEX IF NOT EXISTS idx_project_card_label_card ON project_card_label(card_id);
CREATE INDEX IF NOT EXISTS idx_project_card_assignee_card ON project_card_assignee(card_id);
CREATE INDEX IF NOT EXISTS idx_project_card_assignee_identity ON project_card_assignee(identity_id);
CREATE INDEX IF NOT EXISTS idx_project_card_comment_card ON project_card_comment(card_id);
CREATE INDEX IF NOT EXISTS idx_project_card_activity_card ON project_card_activity(card_id);

-- Enable Row Level Security
ALTER TABLE project_board ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_board_member ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_list ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_card ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_label ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_card_label ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_card_assignee ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_card_comment ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_card_checklist ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_checklist_item ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_card_attachment ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_card_activity ENABLE ROW LEVEL SECURITY;

-- RLS Policies (allow all for service role, we handle access in API)
CREATE POLICY "Service role has full access to project_board" ON project_board FOR ALL USING (true);
CREATE POLICY "Service role has full access to project_board_member" ON project_board_member FOR ALL USING (true);
CREATE POLICY "Service role has full access to project_list" ON project_list FOR ALL USING (true);
CREATE POLICY "Service role has full access to project_card" ON project_card FOR ALL USING (true);
CREATE POLICY "Service role has full access to project_label" ON project_label FOR ALL USING (true);
CREATE POLICY "Service role has full access to project_card_label" ON project_card_label FOR ALL USING (true);
CREATE POLICY "Service role has full access to project_card_assignee" ON project_card_assignee FOR ALL USING (true);
CREATE POLICY "Service role has full access to project_card_comment" ON project_card_comment FOR ALL USING (true);
CREATE POLICY "Service role has full access to project_card_checklist" ON project_card_checklist FOR ALL USING (true);
CREATE POLICY "Service role has full access to project_checklist_item" ON project_checklist_item FOR ALL USING (true);
CREATE POLICY "Service role has full access to project_card_attachment" ON project_card_attachment FOR ALL USING (true);
CREATE POLICY "Service role has full access to project_card_activity" ON project_card_activity FOR ALL USING (true);
