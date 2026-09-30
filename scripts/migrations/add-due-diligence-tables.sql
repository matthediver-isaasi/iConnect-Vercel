-- Due Diligence Extension Tables Migration
-- Run this in Supabase SQL Editor

-- 1. Add is_due_diligence_enabled flag to existing form table
ALTER TABLE form ADD COLUMN IF NOT EXISTS is_due_diligence_enabled BOOLEAN DEFAULT false;

-- 2. Create form_due_diligence_config table
CREATE TABLE IF NOT EXISTS form_due_diligence_config (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  form_id UUID NOT NULL UNIQUE REFERENCES form(id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  
  -- Scoring configuration
  scoring_approach VARCHAR(50) DEFAULT 'dynamic', -- 'dynamic' or 'static_traffic_light'
  scoring_rules JSONB DEFAULT '{}', -- { rules: [], risk_thresholds: {} }
  static_questions JSONB DEFAULT '[]', -- Traffic light questions array
  custom_risk_levels JSONB DEFAULT '[]', -- [{ name, threshold, color }]
  
  -- Review configuration
  default_review_state VARCHAR(50) DEFAULT 'amended', -- 'amended' or 'approved'
  
  -- Workflow configuration
  workflow_stages JSONB DEFAULT '[]', -- [{ id, label, color, is_initial, order, selection_conditions }]
  status_change_webhooks JSONB DEFAULT '[]', -- Webhook configurations
  
  -- CRM integration config
  crm_attachment_config JSONB DEFAULT '{}', -- { enabled, module_name, crm_lookup_field, etc. }
  crm_logo_upload_config JSONB DEFAULT '{}', -- Logo upload settings
  
  -- Field mappings for applicant info extraction
  applicant_name_field TEXT,
  applicant_email_field TEXT,
  applicant_organization_name_field TEXT,
  
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 3. Create form_submission_due_diligence table
CREATE TABLE IF NOT EXISTS form_submission_due_diligence (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  form_submission_id UUID NOT NULL UNIQUE REFERENCES form_submission(id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  
  -- Application tracking
  application_uid VARCHAR(255), -- Unique application identifier
  
  -- Review data
  original_form_values JSONB DEFAULT '{}', -- Unmodified original values
  reviewed_form_values JSONB DEFAULT '{}', -- Amended values during review
  field_review_status JSONB DEFAULT '{}', -- { field_name: 'approved'|'amended'|'pending' }
  field_notes JSONB DEFAULT '{}', -- Per-field review notes
  
  -- Static question responses (traffic light scoring)
  static_question_responses JSONB DEFAULT '{}', -- { question_id: 'green'|'amber'|'red' }
  static_question_notes JSONB DEFAULT '{}', -- { question_id: note }
  
  -- Workflow status
  workflow_status VARCHAR(100) DEFAULT 'new', -- Current stage id
  
  -- Scoring
  due_diligence_score INTEGER, -- 0-100 calculated score
  risk_level VARCHAR(50), -- 'low', 'medium', 'high', 'critical' or custom
  
  -- DD call tracking
  dd_call_date TIMESTAMP WITH TIME ZONE,
  
  -- Internal notes
  notes TEXT, -- Rich text notes from DD calls
  
  -- Signature tracking
  agreements_status JSONB DEFAULT '[]', -- [{ signature_field_name, is_signed, signed_date, etc. }]
  
  -- CRM attachment tracking
  crm_attachments_status JSONB DEFAULT '[]', -- [{ attachment_id, file_name, is_approved, etc. }]
  
  -- Webhook reminder tracking
  status_webhook_reminders_status JSONB DEFAULT '[]',
  sent_webhook_messages JSONB DEFAULT '[]',
  
  -- Audit history
  history_log JSONB DEFAULT '[]', -- [{ timestamp, event_type, user_email, details }]
  
  -- Review metadata
  reviewed_by VARCHAR(255), -- Email of reviewer
  reviewed_date TIMESTAMP WITH TIME ZONE,
  
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 4. Create indexes for common queries
CREATE INDEX IF NOT EXISTS idx_form_dd_config_form_id ON form_due_diligence_config(form_id);
CREATE INDEX IF NOT EXISTS idx_form_dd_config_tenant_id ON form_due_diligence_config(tenant_id);
CREATE INDEX IF NOT EXISTS idx_form_submission_dd_submission_id ON form_submission_due_diligence(form_submission_id);
CREATE INDEX IF NOT EXISTS idx_form_submission_dd_tenant_id ON form_submission_due_diligence(tenant_id);
CREATE INDEX IF NOT EXISTS idx_form_submission_dd_workflow_status ON form_submission_due_diligence(workflow_status);
CREATE INDEX IF NOT EXISTS idx_form_submission_dd_risk_level ON form_submission_due_diligence(risk_level);
CREATE INDEX IF NOT EXISTS idx_form_submission_dd_application_uid ON form_submission_due_diligence(application_uid);

-- 5. Enable Row Level Security
ALTER TABLE form_due_diligence_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE form_submission_due_diligence ENABLE ROW LEVEL SECURITY;

-- 6. Create RLS policies for form_due_diligence_config
CREATE POLICY "Users can view due diligence configs in their tenant" 
  ON form_due_diligence_config FOR SELECT 
  USING (true); -- API layer handles tenant filtering

CREATE POLICY "Users can insert due diligence configs in their tenant" 
  ON form_due_diligence_config FOR INSERT 
  WITH CHECK (true);

CREATE POLICY "Users can update due diligence configs in their tenant" 
  ON form_due_diligence_config FOR UPDATE 
  USING (true);

CREATE POLICY "Users can delete due diligence configs in their tenant" 
  ON form_due_diligence_config FOR DELETE 
  USING (true);

-- 7. Create RLS policies for form_submission_due_diligence
CREATE POLICY "Users can view due diligence submissions in their tenant" 
  ON form_submission_due_diligence FOR SELECT 
  USING (true); -- API layer handles tenant filtering

CREATE POLICY "Users can insert due diligence submissions in their tenant" 
  ON form_submission_due_diligence FOR INSERT 
  WITH CHECK (true);

CREATE POLICY "Users can update due diligence submissions in their tenant" 
  ON form_submission_due_diligence FOR UPDATE 
  USING (true);

CREATE POLICY "Users can delete due diligence submissions in their tenant" 
  ON form_submission_due_diligence FOR DELETE 
  USING (true);

-- 8. Create trigger functions for updated_at
CREATE OR REPLACE FUNCTION update_form_dd_config_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION update_form_submission_dd_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 9. Create triggers
DROP TRIGGER IF EXISTS trigger_update_form_dd_config_updated_at ON form_due_diligence_config;
CREATE TRIGGER trigger_update_form_dd_config_updated_at
  BEFORE UPDATE ON form_due_diligence_config
  FOR EACH ROW EXECUTE FUNCTION update_form_dd_config_updated_at();

DROP TRIGGER IF EXISTS trigger_update_form_submission_dd_updated_at ON form_submission_due_diligence;
CREATE TRIGGER trigger_update_form_submission_dd_updated_at
  BEFORE UPDATE ON form_submission_due_diligence
  FOR EACH ROW EXECUTE FUNCTION update_form_submission_dd_updated_at();

-- Done! Remember to run this migration in Supabase SQL Editor
