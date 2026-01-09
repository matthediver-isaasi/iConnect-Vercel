-- Platform Owner Configuration System
-- Allows SaaS owners to manage app-wide settings and default templates

-- Platform Owner accounts (separate from tenant_user)
CREATE TABLE IF NOT EXISTS platform_owner (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  email VARCHAR(255) NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name TEXT,
  is_active BOOLEAN DEFAULT true,
  last_login_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Platform Preferences (GLOBAL scope - not tenant-scoped)
CREATE TABLE IF NOT EXISTS platform_preferences (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  key VARCHAR(255) NOT NULL UNIQUE,
  value JSONB NOT NULL DEFAULT '{}',
  description TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Platform Owner Sessions (server-side session store)
CREATE TABLE IF NOT EXISTS platform_owner_session (
  id VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id VARCHAR NOT NULL REFERENCES platform_owner(id) ON DELETE CASCADE,
  session_token VARCHAR(255) NOT NULL UNIQUE,
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_platform_owner_email ON platform_owner(email);
CREATE INDEX IF NOT EXISTS idx_platform_preferences_key ON platform_preferences(key);
CREATE INDEX IF NOT EXISTS idx_platform_owner_session_token ON platform_owner_session(session_token);
CREATE INDEX IF NOT EXISTS idx_platform_owner_session_owner ON platform_owner_session(owner_id);

-- Insert default role templates preference (empty initially, will be seeded)
INSERT INTO platform_preferences (key, value, description)
VALUES (
  'default_role_templates',
  '{"roles": []}',
  'Default role configurations to provision for new tenants'
)
ON CONFLICT (key) DO NOTHING;

-- Insert other default preferences
INSERT INTO platform_preferences (key, value, description)
VALUES (
  'tenant_provisioning',
  '{"auto_create_roles": true, "default_subscription_plan": "free"}',
  'Settings for new tenant provisioning'
)
ON CONFLICT (key) DO NOTHING;
