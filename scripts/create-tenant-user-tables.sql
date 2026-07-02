-- Migration: Create tenant_user tables for SaaS-level authentication
-- Run this SQL in your Supabase SQL Editor
-- These tables separate SaaS platform admins from organizational members

-- tenant_user: Platform-level accounts for people who manage tenants
CREATE TABLE IF NOT EXISTS tenant_user (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id VARCHAR NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  email VARCHAR NOT NULL,
  first_name VARCHAR,
  last_name VARCHAR,
  role VARCHAR DEFAULT 'owner',  -- owner, admin, billing
  status VARCHAR DEFAULT 'active',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(tenant_id, email)
);

-- tenant_user_credentials: Login credentials for tenant users
CREATE TABLE IF NOT EXISTS tenant_user_credentials (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_user_id VARCHAR NOT NULL REFERENCES tenant_user(id) ON DELETE CASCADE,
  email VARCHAR NOT NULL UNIQUE,
  password_hash VARCHAR,
  is_temporary BOOLEAN DEFAULT false,
  reset_token VARCHAR,
  reset_token_expires TIMESTAMP WITH TIME ZONE,
  last_login TIMESTAMP WITH TIME ZONE,
  failed_attempts INTEGER DEFAULT 0,
  locked_until TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_tenant_user_tenant_id ON tenant_user(tenant_id);
CREATE INDEX IF NOT EXISTS idx_tenant_user_email ON tenant_user(email);
CREATE INDEX IF NOT EXISTS idx_tenant_user_credentials_email ON tenant_user_credentials(email);
CREATE INDEX IF NOT EXISTS idx_tenant_user_credentials_tenant_user_id ON tenant_user_credentials(tenant_user_id);

-- Enable RLS
ALTER TABLE tenant_user ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_user_credentials ENABLE ROW LEVEL SECURITY;

-- RLS policies (allow service role full access)
CREATE POLICY "Service role has full access to tenant_user" ON tenant_user
  FOR ALL USING (true) WITH CHECK (true);

CREATE POLICY "Service role has full access to tenant_user_credentials" ON tenant_user_credentials
  FOR ALL USING (true) WITH CHECK (true);
