-- Migration: Create tenant_user_member_link table for SSO between SaaS and Portal
-- Run this SQL in your Supabase SQL Editor
-- This table links tenant_user accounts to their corresponding member accounts

CREATE TABLE IF NOT EXISTS tenant_user_member_link (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_user_id VARCHAR NOT NULL REFERENCES tenant_user(id) ON DELETE CASCADE,
  member_id VARCHAR NOT NULL,
  tenant_id VARCHAR NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(tenant_user_id, member_id)
);

-- Index for efficient lookups
CREATE INDEX IF NOT EXISTS idx_tenant_user_member_link_tenant_user_id ON tenant_user_member_link(tenant_user_id);
CREATE INDEX IF NOT EXISTS idx_tenant_user_member_link_member_id ON tenant_user_member_link(member_id);

-- SSO tokens for cross-domain authentication
CREATE TABLE IF NOT EXISTS portal_sso_token (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid()::text,
  token VARCHAR NOT NULL UNIQUE,
  tenant_user_id VARCHAR NOT NULL REFERENCES tenant_user(id) ON DELETE CASCADE,
  member_id VARCHAR NOT NULL,
  tenant_id VARCHAR NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
  used_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_portal_sso_token_token ON portal_sso_token(token);
CREATE INDEX IF NOT EXISTS idx_portal_sso_token_expires ON portal_sso_token(expires_at);

-- Enable RLS
ALTER TABLE tenant_user_member_link ENABLE ROW LEVEL SECURITY;
ALTER TABLE portal_sso_token ENABLE ROW LEVEL SECURITY;

-- RLS policies (allow service role full access)
CREATE POLICY "Service role has full access to tenant_user_member_link" ON tenant_user_member_link
  FOR ALL USING (true) WITH CHECK (true);

CREATE POLICY "Service role has full access to portal_sso_token" ON portal_sso_token
  FOR ALL USING (true) WITH CHECK (true);
