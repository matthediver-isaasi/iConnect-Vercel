-- Self-serve tenant signup & onboarding wizard (Task #1022)
--
-- Adds:
--   * plan catalog (free / starter / growth / enterprise) with quota JSONB
--   * tenant.plan_code, tenant.onboarding_status, tenant.onboarding_data
--   * tenant_signup table — pending self-serve registrations awaiting email verification
--   * tenant_integration_intent table — admin's declared intent for stripe/xero/qbo/zoom
--   * is_sample boolean columns on member, organization, event, blog_post,
--     resource, fundraising_campaign, iedit_page so the seeder can mark seeded
--     content and the "Remove sample content" action can find and delete it
--   * Backfill: every existing tenant gets onboarding_status='complete' and
--     plan_code='free' so the wizard never blocks legacy admins
--
-- All statements idempotent — safe to re-run.

-- ---------------------------------------------------------------------------
-- 1. Plan catalog
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS plan (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  is_self_serve BOOLEAN NOT NULL DEFAULT FALSE,
  quotas JSONB NOT NULL DEFAULT '{}'::jsonb,
  display_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO plan (code, name, is_self_serve, quotas, display_order) VALUES
  ('free',       'Free',       TRUE,
    '{"members":50,"events_per_month":2,"storage_mb":500,"emails_per_month":500,"custom_domain":false}'::jsonb, 10),
  ('starter',    'Starter',    FALSE,
    '{"members":250,"events_per_month":10,"storage_mb":5000,"emails_per_month":5000,"custom_domain":true}'::jsonb, 20),
  ('growth',     'Growth',     FALSE,
    '{"members":2000,"events_per_month":50,"storage_mb":25000,"emails_per_month":25000,"custom_domain":true}'::jsonb, 30),
  ('enterprise', 'Enterprise', FALSE,
    '{"members":null,"events_per_month":null,"storage_mb":null,"emails_per_month":null,"custom_domain":true}'::jsonb, 40)
ON CONFLICT (code) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 2. Tenant: plan + onboarding lifecycle
-- ---------------------------------------------------------------------------
ALTER TABLE tenant ADD COLUMN IF NOT EXISTS plan_code TEXT NOT NULL DEFAULT 'free';
ALTER TABLE tenant ADD COLUMN IF NOT EXISTS onboarding_status TEXT NOT NULL DEFAULT 'complete'
  CHECK (onboarding_status IN ('pending', 'complete', 'skipped'));
ALTER TABLE tenant ADD COLUMN IF NOT EXISTS onboarding_data JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE tenant ADD COLUMN IF NOT EXISTS onboarding_completed_at TIMESTAMPTZ;

-- Backfill: legacy tenants are already set up — mark them complete explicitly
UPDATE tenant
   SET onboarding_status = 'complete',
       onboarding_completed_at = COALESCE(onboarding_completed_at, created_at, NOW())
 WHERE onboarding_status IS NULL OR onboarding_status = 'complete';

CREATE INDEX IF NOT EXISTS idx_tenant_onboarding_status ON tenant(onboarding_status);

-- ---------------------------------------------------------------------------
-- 3. Pending self-serve signup (pre-verification)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tenant_signup (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL,
  tenant_name TEXT NOT NULL,
  slug TEXT NOT NULL,
  admin_first_name TEXT NOT NULL,
  admin_last_name TEXT NOT NULL,
  password_hash TEXT,
  verification_token TEXT NOT NULL,
  verification_expires TIMESTAMPTZ NOT NULL,
  ip_address TEXT,
  user_agent TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'verified', 'expired', 'consumed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  verified_at TIMESTAMPTZ,
  consumed_at TIMESTAMPTZ,
  provisioned_tenant_id UUID
);

CREATE INDEX IF NOT EXISTS idx_tenant_signup_token ON tenant_signup(verification_token);
CREATE INDEX IF NOT EXISTS idx_tenant_signup_email ON tenant_signup(LOWER(email));
CREATE INDEX IF NOT EXISTS idx_tenant_signup_status ON tenant_signup(status, created_at);

-- ---------------------------------------------------------------------------
-- 4. Tenant integration intent (declared during wizard)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tenant_integration_intent (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  integration_type TEXT NOT NULL
    CHECK (integration_type IN ('stripe', 'xero', 'quickbooks', 'zoom', 'mailgun', 'wordpress', 'zoho')),
  intent TEXT NOT NULL DEFAULT 'maybe_later'
    CHECK (intent IN ('connect_now', 'maybe_later', 'not_needed')),
  configured_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, integration_type)
);

CREATE INDEX IF NOT EXISTS idx_tenant_integration_intent_tenant ON tenant_integration_intent(tenant_id);

-- ---------------------------------------------------------------------------
-- 5. Sample-content markers (so the seeder's content can be wiped in one click)
-- ---------------------------------------------------------------------------
ALTER TABLE member             ADD COLUMN IF NOT EXISTS is_sample BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE organization       ADD COLUMN IF NOT EXISTS is_sample BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE event              ADD COLUMN IF NOT EXISTS is_sample BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE blog_post          ADD COLUMN IF NOT EXISTS is_sample BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE resource           ADD COLUMN IF NOT EXISTS is_sample BOOLEAN NOT NULL DEFAULT FALSE;

-- Tables we mark optionally — some installs may not have these; wrap in DO blocks
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='fundraising_campaign') THEN
    EXECUTE 'ALTER TABLE fundraising_campaign ADD COLUMN IF NOT EXISTS is_sample BOOLEAN NOT NULL DEFAULT FALSE';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='iedit_page') THEN
    EXECUTE 'ALTER TABLE iedit_page ADD COLUMN IF NOT EXISTS is_sample BOOLEAN NOT NULL DEFAULT FALSE';
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_member_is_sample       ON member(tenant_id)       WHERE is_sample = TRUE;
CREATE INDEX IF NOT EXISTS idx_organization_is_sample ON organization(tenant_id) WHERE is_sample = TRUE;
CREATE INDEX IF NOT EXISTS idx_event_is_sample        ON event(tenant_id)        WHERE is_sample = TRUE;
CREATE INDEX IF NOT EXISTS idx_blog_post_is_sample    ON blog_post(tenant_id)    WHERE is_sample = TRUE;
CREATE INDEX IF NOT EXISTS idx_resource_is_sample     ON resource(tenant_id)     WHERE is_sample = TRUE;
