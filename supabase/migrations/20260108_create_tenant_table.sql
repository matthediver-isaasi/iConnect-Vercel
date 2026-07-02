-- Create tenant table for multi-tenant SaaS
-- Tenant = The SaaS subscribing company (e.g., "Graduate Futures Institute")
-- Organization = Organizational members within a tenant (member companies)
-- Member = Individual people associated with organizations

CREATE TABLE IF NOT EXISTS tenant (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  slug VARCHAR(100) UNIQUE,
  domain VARCHAR(255),
  status VARCHAR(50) NOT NULL DEFAULT 'active',
  logo_url TEXT,
  favicon_url TEXT,
  primary_color VARCHAR(20),
  subscription_plan VARCHAR(50) DEFAULT 'free',
  subscription_status VARCHAR(50) DEFAULT 'active',
  stripe_customer_id VARCHAR(255),
  stripe_subscription_id VARCHAR(255),
  billing_email VARCHAR(255),
  settings JSONB DEFAULT '{}',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

COMMENT ON TABLE tenant IS 'SaaS tenants (subscribing companies) - the top level of multi-tenancy';
COMMENT ON COLUMN tenant.slug IS 'URL-friendly identifier, used for subdomain or path routing';
COMMENT ON COLUMN tenant.domain IS 'Custom domain for white-label branding';
COMMENT ON COLUMN tenant.status IS 'active, suspended, cancelled, trial';
COMMENT ON COLUMN tenant.subscription_plan IS 'SaaS pricing tier';
COMMENT ON COLUMN tenant.settings IS 'Tenant-specific configuration and feature flags';

-- Helper function to safely add tenant_id column to tables that exist
CREATE OR REPLACE FUNCTION add_tenant_id_if_table_exists(table_name TEXT)
RETURNS VOID AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND information_schema.tables.table_name = add_tenant_id_if_table_exists.table_name) THEN
    EXECUTE format('ALTER TABLE %I ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenant(id)', table_name);
  END IF;
END;
$$ LANGUAGE plpgsql;

-- Helper function to safely create index on tables that exist
CREATE OR REPLACE FUNCTION create_tenant_index_if_table_exists(table_name TEXT)
RETURNS VOID AS $$
DECLARE
  idx_name TEXT;
BEGIN
  idx_name := 'idx_' || table_name || '_tenant_id';
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND information_schema.tables.table_name = create_tenant_index_if_table_exists.table_name) THEN
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND information_schema.columns.table_name = create_tenant_index_if_table_exists.table_name AND column_name = 'tenant_id') THEN
      EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I(tenant_id)', idx_name, table_name);
    END IF;
  END IF;
END;
$$ LANGUAGE plpgsql;

-- Add tenant_id to all tenant-scoped tables (safely skips non-existent tables)
SELECT add_tenant_id_if_table_exists('organization');
SELECT add_tenant_id_if_table_exists('role');
SELECT add_tenant_id_if_table_exists('event');
SELECT add_tenant_id_if_table_exists('program');
SELECT add_tenant_id_if_table_exists('form');
SELECT add_tenant_id_if_table_exists('form_submission');
SELECT add_tenant_id_if_table_exists('booking');
SELECT add_tenant_id_if_table_exists('voucher');
SELECT add_tenant_id_if_table_exists('discount_code');
SELECT add_tenant_id_if_table_exists('job_posting');
SELECT add_tenant_id_if_table_exists('resource');
SELECT add_tenant_id_if_table_exists('resource_category');
SELECT add_tenant_id_if_table_exists('resource_folder');
SELECT add_tenant_id_if_table_exists('blog_post');
SELECT add_tenant_id_if_table_exists('news_post');
SELECT add_tenant_id_if_table_exists('navigation_item');
SELECT add_tenant_id_if_table_exists('portal_navigation_item');
SELECT add_tenant_id_if_table_exists('portal_menu');
SELECT add_tenant_id_if_table_exists('page_banner');
SELECT add_tenant_id_if_table_exists('floater');
SELECT add_tenant_id_if_table_exists('support_ticket');
SELECT add_tenant_id_if_table_exists('workflow');
SELECT add_tenant_id_if_table_exists('award');
SELECT add_tenant_id_if_table_exists('offline_award');
SELECT add_tenant_id_if_table_exists('wall_of_fame_section');
SELECT add_tenant_id_if_table_exists('wall_of_fame_category');
SELECT add_tenant_id_if_table_exists('wall_of_fame_person');
SELECT add_tenant_id_if_table_exists('member_group');
SELECT add_tenant_id_if_table_exists('file_repository');
SELECT add_tenant_id_if_table_exists('file_repository_folder');
SELECT add_tenant_id_if_table_exists('team_member');
SELECT add_tenant_id_if_table_exists('speaker');
SELECT add_tenant_id_if_table_exists('card_deck');
SELECT add_tenant_id_if_table_exists('dynamic_directory');
SELECT add_tenant_id_if_table_exists('i_edit_page');
SELECT add_tenant_id_if_table_exists('i_edit_page_element');
SELECT add_tenant_id_if_table_exists('program_ticket_transaction');
SELECT add_tenant_id_if_table_exists('training_fund_transaction');
SELECT add_tenant_id_if_table_exists('voucher_transaction');
SELECT add_tenant_id_if_table_exists('discount_code_usage');
SELECT add_tenant_id_if_table_exists('email_template');
SELECT add_tenant_id_if_table_exists('resource_author_settings');
SELECT add_tenant_id_if_table_exists('article_category');
SELECT add_tenant_id_if_table_exists('offline_award_assignment');
SELECT add_tenant_id_if_table_exists('engagement_award');
SELECT add_tenant_id_if_table_exists('engagement_award_assignment');
SELECT add_tenant_id_if_table_exists('organisation_award');
SELECT add_tenant_id_if_table_exists('organisation_award_assignment');
SELECT add_tenant_id_if_table_exists('member_group_assignment');
SELECT add_tenant_id_if_table_exists('member_group_guest');
SELECT add_tenant_id_if_table_exists('support_ticket_response');
SELECT add_tenant_id_if_table_exists('workflow_log');
SELECT add_tenant_id_if_table_exists('communication_category');
SELECT add_tenant_id_if_table_exists('communication_category_role');
SELECT add_tenant_id_if_table_exists('page_visibility');
SELECT add_tenant_id_if_table_exists('xero_token');
SELECT add_tenant_id_if_table_exists('guest_writer');

-- Create indexes for efficient tenant-scoped queries (safely skips non-existent tables)
SELECT create_tenant_index_if_table_exists('organization');
SELECT create_tenant_index_if_table_exists('role');
SELECT create_tenant_index_if_table_exists('event');
SELECT create_tenant_index_if_table_exists('program');
SELECT create_tenant_index_if_table_exists('form');
SELECT create_tenant_index_if_table_exists('form_submission');
SELECT create_tenant_index_if_table_exists('booking');
SELECT create_tenant_index_if_table_exists('job_posting');
SELECT create_tenant_index_if_table_exists('resource');
SELECT create_tenant_index_if_table_exists('blog_post');
SELECT create_tenant_index_if_table_exists('workflow');
SELECT create_tenant_index_if_table_exists('member_group');
SELECT create_tenant_index_if_table_exists('team_member');
SELECT create_tenant_index_if_table_exists('program_ticket_transaction');
SELECT create_tenant_index_if_table_exists('email_template');
SELECT create_tenant_index_if_table_exists('article_category');

-- Clean up helper functions (optional - comment out if you want to keep them)
DROP FUNCTION IF EXISTS add_tenant_id_if_table_exists(TEXT);
DROP FUNCTION IF EXISTS create_tenant_index_if_table_exists(TEXT);
