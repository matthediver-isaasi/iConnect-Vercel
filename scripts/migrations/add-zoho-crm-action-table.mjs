// Run this migration via Supabase SQL Editor or psql
// This script just documents the required SQL

const SQL = `
-- Add stage_zoho_crm_action table for DD workflow Zoho CRM integration
CREATE TABLE IF NOT EXISTS stage_zoho_crm_action (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  due_diligence_stage_id UUID NOT NULL,
  form_id UUID REFERENCES form(id) ON DELETE CASCADE,
  is_active BOOLEAN DEFAULT true,
  sort_order INTEGER DEFAULT 0,
  field_mappings JSONB DEFAULT '{}'::jsonb,
  last_executed_at TIMESTAMPTZ,
  last_execution_result JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_stage_zoho_crm_action_tenant ON stage_zoho_crm_action(tenant_id);
CREATE INDEX IF NOT EXISTS idx_stage_zoho_crm_action_stage ON stage_zoho_crm_action(due_diligence_stage_id);
CREATE INDEX IF NOT EXISTS idx_stage_zoho_crm_action_form ON stage_zoho_crm_action(form_id);

-- Add zoho_crm_record_id to form_submission_due_diligence to track created records
ALTER TABLE form_submission_due_diligence 
ADD COLUMN IF NOT EXISTS zoho_crm_account_id TEXT;
`;

console.log('Please run the following SQL in Supabase SQL Editor:');
console.log('='.repeat(60));
console.log(SQL);
console.log('='.repeat(60));
