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

-- Add tenant_id to organization table
ALTER TABLE organization ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenant(id);

-- Add tenant_id to other tenant-scoped tables
ALTER TABLE role ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenant(id);
ALTER TABLE event ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenant(id);
ALTER TABLE program ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenant(id);
ALTER TABLE form ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenant(id);
ALTER TABLE form_submission ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenant(id);
ALTER TABLE booking ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenant(id);
ALTER TABLE voucher ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenant(id);
ALTER TABLE discount_code ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenant(id);
ALTER TABLE job_posting ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenant(id);
ALTER TABLE resource ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenant(id);
ALTER TABLE resource_category ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenant(id);
ALTER TABLE resource_folder ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenant(id);
ALTER TABLE blog_post ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenant(id);
ALTER TABLE news_post ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenant(id);
ALTER TABLE navigation_item ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenant(id);
ALTER TABLE portal_navigation_item ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenant(id);
ALTER TABLE portal_menu ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenant(id);
ALTER TABLE page_banner ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenant(id);
ALTER TABLE floater ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenant(id);
ALTER TABLE support_ticket ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenant(id);
ALTER TABLE workflow ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenant(id);
ALTER TABLE award ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenant(id);
ALTER TABLE offline_award ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenant(id);
ALTER TABLE wall_of_fame_section ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenant(id);
ALTER TABLE wall_of_fame_category ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenant(id);
ALTER TABLE wall_of_fame_person ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenant(id);
ALTER TABLE member_group ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenant(id);
ALTER TABLE file_repository ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenant(id);
ALTER TABLE file_repository_folder ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenant(id);
ALTER TABLE team_member ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenant(id);
ALTER TABLE speaker ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenant(id);
ALTER TABLE card_deck ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenant(id);
ALTER TABLE dynamic_directory ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenant(id);
ALTER TABLE i_edit_page ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenant(id);
ALTER TABLE i_edit_page_element ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenant(id);

-- Additional tenant-scoped tables
ALTER TABLE program_ticket_transaction ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenant(id);
ALTER TABLE training_fund_transaction ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenant(id);
ALTER TABLE voucher_transaction ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenant(id);
ALTER TABLE discount_code_usage ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenant(id);
ALTER TABLE email_template ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenant(id);
ALTER TABLE resource_author_settings ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenant(id);
ALTER TABLE article_category ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenant(id);
ALTER TABLE offline_award_assignment ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenant(id);
ALTER TABLE engagement_award ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenant(id);
ALTER TABLE engagement_award_assignment ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenant(id);
ALTER TABLE organisation_award ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenant(id);
ALTER TABLE organisation_award_assignment ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenant(id);
ALTER TABLE member_group_assignment ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenant(id);
ALTER TABLE member_group_guest ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenant(id);
ALTER TABLE support_ticket_response ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenant(id);
ALTER TABLE workflow_log ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenant(id);
ALTER TABLE communication_category ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenant(id);
ALTER TABLE communication_category_role ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenant(id);
ALTER TABLE page_visibility ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenant(id);
ALTER TABLE xero_token ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenant(id);
ALTER TABLE guest_writer ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenant(id);

-- Create indexes for efficient tenant-scoped queries
CREATE INDEX IF NOT EXISTS idx_organization_tenant_id ON organization(tenant_id);
CREATE INDEX IF NOT EXISTS idx_role_tenant_id ON role(tenant_id);
CREATE INDEX IF NOT EXISTS idx_event_tenant_id ON event(tenant_id);
CREATE INDEX IF NOT EXISTS idx_program_tenant_id ON program(tenant_id);
CREATE INDEX IF NOT EXISTS idx_form_tenant_id ON form(tenant_id);
CREATE INDEX IF NOT EXISTS idx_form_submission_tenant_id ON form_submission(tenant_id);
CREATE INDEX IF NOT EXISTS idx_booking_tenant_id ON booking(tenant_id);
CREATE INDEX IF NOT EXISTS idx_job_posting_tenant_id ON job_posting(tenant_id);
CREATE INDEX IF NOT EXISTS idx_resource_tenant_id ON resource(tenant_id);
CREATE INDEX IF NOT EXISTS idx_blog_post_tenant_id ON blog_post(tenant_id);
CREATE INDEX IF NOT EXISTS idx_workflow_tenant_id ON workflow(tenant_id);
CREATE INDEX IF NOT EXISTS idx_member_group_tenant_id ON member_group(tenant_id);
CREATE INDEX IF NOT EXISTS idx_team_member_tenant_id ON team_member(tenant_id);
CREATE INDEX IF NOT EXISTS idx_program_ticket_transaction_tenant_id ON program_ticket_transaction(tenant_id);
CREATE INDEX IF NOT EXISTS idx_email_template_tenant_id ON email_template(tenant_id);
CREATE INDEX IF NOT EXISTS idx_article_category_tenant_id ON article_category(tenant_id);
