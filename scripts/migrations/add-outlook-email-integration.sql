-- Migration: Add Outlook email integration tables
-- Enables Microsoft Graph API integration for email tracking on member records
-- Run this SQL in your Supabase SQL Editor

-- Step 1: Create outlook_connection table (stores OAuth tokens per tenant user)
CREATE TABLE IF NOT EXISTS outlook_connection (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id VARCHAR NOT NULL,
  identity_id VARCHAR NOT NULL REFERENCES tenant_identity(id) ON DELETE CASCADE,
  
  -- Microsoft account info
  microsoft_user_id VARCHAR NOT NULL,
  microsoft_email VARCHAR NOT NULL,
  display_name VARCHAR,
  
  -- OAuth tokens (encrypted at rest by Supabase)
  access_token TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  token_expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
  scopes TEXT,
  
  -- Connection status
  status VARCHAR DEFAULT 'active', -- 'active', 'expired', 'revoked'
  last_sync_at TIMESTAMP WITH TIME ZONE,
  sync_error TEXT,
  
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  
  UNIQUE(tenant_id, identity_id)
);

-- Step 2: Create member_email table (stores synced emails linked to members)
CREATE TABLE IF NOT EXISTS member_email (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id VARCHAR NOT NULL,
  member_id VARCHAR NOT NULL,
  
  -- Microsoft message metadata
  microsoft_message_id VARCHAR NOT NULL,
  conversation_id VARCHAR,
  internet_message_id VARCHAR,
  
  -- Email content
  subject TEXT,
  body_preview TEXT,
  body_content TEXT,
  body_content_type VARCHAR DEFAULT 'html', -- 'html' or 'text'
  
  -- Sender/recipient info
  from_address VARCHAR NOT NULL,
  from_name VARCHAR,
  to_addresses JSONB DEFAULT '[]', -- [{address, name}]
  cc_addresses JSONB DEFAULT '[]',
  
  -- Email direction and type
  direction VARCHAR NOT NULL, -- 'inbound' (from member) or 'outbound' (to member)
  is_read BOOLEAN DEFAULT false,
  is_draft BOOLEAN DEFAULT false,
  has_attachments BOOLEAN DEFAULT false,
  importance VARCHAR DEFAULT 'normal', -- 'low', 'normal', 'high'
  
  -- Attachments metadata
  attachments JSONB DEFAULT '[]', -- [{id, name, contentType, size}]
  
  -- Timestamps
  sent_at TIMESTAMP WITH TIME ZONE,
  received_at TIMESTAMP WITH TIME ZONE,
  
  -- Tracking who synced this
  synced_by_identity_id VARCHAR,
  synced_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  
  UNIQUE(tenant_id, microsoft_message_id)
);

-- Step 3: Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_outlook_connection_tenant ON outlook_connection(tenant_id);
CREATE INDEX IF NOT EXISTS idx_outlook_connection_identity ON outlook_connection(identity_id);
CREATE INDEX IF NOT EXISTS idx_outlook_connection_status ON outlook_connection(status);

CREATE INDEX IF NOT EXISTS idx_member_email_tenant ON member_email(tenant_id);
CREATE INDEX IF NOT EXISTS idx_member_email_member ON member_email(member_id);
CREATE INDEX IF NOT EXISTS idx_member_email_from ON member_email(from_address);
CREATE INDEX IF NOT EXISTS idx_member_email_sent ON member_email(sent_at);
CREATE INDEX IF NOT EXISTS idx_member_email_direction ON member_email(direction);
CREATE INDEX IF NOT EXISTS idx_member_email_conversation ON member_email(conversation_id);

-- Step 4: Enable RLS
ALTER TABLE outlook_connection ENABLE ROW LEVEL SECURITY;
ALTER TABLE member_email ENABLE ROW LEVEL SECURITY;

-- Step 5: RLS policies (allow service role full access)
DROP POLICY IF EXISTS "Service role has full access to outlook_connection" ON outlook_connection;
DROP POLICY IF EXISTS "Service role has full access to member_email" ON member_email;

CREATE POLICY "Service role has full access to outlook_connection" ON outlook_connection
  FOR ALL USING (true) WITH CHECK (true);

CREATE POLICY "Service role has full access to member_email" ON member_email
  FOR ALL USING (true) WITH CHECK (true);

-- Step 6: Create trigger to keep updated_at current
DROP TRIGGER IF EXISTS trigger_outlook_connection_updated_at ON outlook_connection;

CREATE OR REPLACE FUNCTION update_outlook_connection_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_outlook_connection_updated_at
  BEFORE UPDATE ON outlook_connection
  FOR EACH ROW
  EXECUTE FUNCTION update_outlook_connection_updated_at();

-- Verify migration
SELECT 
  'outlook_connection' as table_name, 
  COUNT(*) as record_count 
FROM outlook_connection
UNION ALL
SELECT 
  'member_email' as table_name, 
  COUNT(*) as record_count 
FROM member_email;
