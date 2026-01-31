-- Email Marketing System (EMS) Tables
-- Replaces Zoho Campaigns with native email campaign management via Mailgun

-- Email Campaigns - the main campaign record
CREATE TABLE IF NOT EXISTS email_campaign (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID REFERENCES tenant(id),
  name VARCHAR(255) NOT NULL,
  subject VARCHAR(500) NOT NULL,
  from_name VARCHAR(255),
  from_email VARCHAR(255),
  reply_to VARCHAR(255),
  email_template_id UUID REFERENCES email_template(id),
  html_content TEXT,
  text_content TEXT,
  status VARCHAR(50) NOT NULL DEFAULT 'draft',
  scheduled_at TIMESTAMP WITH TIME ZONE,
  sent_at TIMESTAMP WITH TIME ZONE,
  completed_at TIMESTAMP WITH TIME ZONE,
  
  -- Recipient targeting
  target_type VARCHAR(50) NOT NULL DEFAULT 'communication_category',
  target_ids TEXT[] DEFAULT '{}',
  
  -- Stats (denormalized for quick access)
  total_recipients INTEGER DEFAULT 0,
  sent_count INTEGER DEFAULT 0,
  delivered_count INTEGER DEFAULT 0,
  opened_count INTEGER DEFAULT 0,
  clicked_count INTEGER DEFAULT 0,
  bounced_count INTEGER DEFAULT 0,
  unsubscribed_count INTEGER DEFAULT 0,
  complained_count INTEGER DEFAULT 0,
  
  created_by UUID,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

COMMENT ON TABLE email_campaign IS 'Email marketing campaigns managed via Mailgun';
COMMENT ON COLUMN email_campaign.status IS 'draft, scheduled, sending, sent, cancelled, failed';
COMMENT ON COLUMN email_campaign.target_type IS 'communication_category, member_group, role, all_members';
COMMENT ON COLUMN email_campaign.target_ids IS 'Array of IDs for the selected target type';

-- Campaign Recipients - individual send records for each recipient
CREATE TABLE IF NOT EXISTS email_campaign_recipient (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID NOT NULL REFERENCES email_campaign(id) ON DELETE CASCADE,
  member_id UUID REFERENCES member(id),
  email VARCHAR(255) NOT NULL,
  first_name VARCHAR(255),
  last_name VARCHAR(255),
  
  -- Send status
  status VARCHAR(50) NOT NULL DEFAULT 'pending',
  mailgun_message_id VARCHAR(255),
  sent_at TIMESTAMP WITH TIME ZONE,
  delivered_at TIMESTAMP WITH TIME ZONE,
  opened_at TIMESTAMP WITH TIME ZONE,
  clicked_at TIMESTAMP WITH TIME ZONE,
  bounced_at TIMESTAMP WITH TIME ZONE,
  unsubscribed_at TIMESTAMP WITH TIME ZONE,
  complained_at TIMESTAMP WITH TIME ZONE,
  
  -- Tracking counts
  open_count INTEGER DEFAULT 0,
  click_count INTEGER DEFAULT 0,
  
  error_message TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

COMMENT ON TABLE email_campaign_recipient IS 'Individual recipient records for each campaign send';
COMMENT ON COLUMN email_campaign_recipient.status IS 'pending, sending, sent, delivered, opened, clicked, bounced, failed, unsubscribed, complained';

CREATE INDEX idx_email_campaign_recipient_campaign ON email_campaign_recipient(campaign_id);
CREATE INDEX idx_email_campaign_recipient_member ON email_campaign_recipient(member_id);
CREATE INDEX idx_email_campaign_recipient_email ON email_campaign_recipient(email);
CREATE INDEX idx_email_campaign_recipient_mailgun_id ON email_campaign_recipient(mailgun_message_id);

-- Link Clicks - detailed click tracking with position data for heat maps
CREATE TABLE IF NOT EXISTS email_link_click (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID REFERENCES email_campaign(id) ON DELETE CASCADE,
  recipient_id UUID REFERENCES email_campaign_recipient(id) ON DELETE CASCADE,
  member_id UUID REFERENCES member(id),
  
  -- Link details
  original_url TEXT NOT NULL,
  link_position VARCHAR(100),
  link_text VARCHAR(500),
  link_index INTEGER,
  
  -- Tracking
  clicked_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  user_agent TEXT,
  ip_address VARCHAR(45),
  
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

COMMENT ON TABLE email_link_click IS 'Detailed click tracking for email links with position data for heat mapping';
COMMENT ON COLUMN email_link_click.link_position IS 'Position identifier like header, footer, cta-1, body-link-2';
COMMENT ON COLUMN email_link_click.link_index IS 'Numeric index of link in email (0-based)';

CREATE INDEX idx_email_link_click_campaign ON email_link_click(campaign_id);
CREATE INDEX idx_email_link_click_recipient ON email_link_click(recipient_id);
CREATE INDEX idx_email_link_click_link_position ON email_link_click(link_position);

-- Email Events - webhook events from Mailgun for audit trail
CREATE TABLE IF NOT EXISTS email_event (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID REFERENCES tenant(id),
  campaign_id UUID REFERENCES email_campaign(id) ON DELETE SET NULL,
  recipient_id UUID REFERENCES email_campaign_recipient(id) ON DELETE SET NULL,
  member_id UUID REFERENCES member(id),
  
  -- Event details
  event_type VARCHAR(50) NOT NULL,
  email VARCHAR(255) NOT NULL,
  mailgun_message_id VARCHAR(255),
  mailgun_event_id VARCHAR(255),
  
  -- Additional data
  severity VARCHAR(50),
  reason TEXT,
  delivery_status_code INTEGER,
  delivery_status_message TEXT,
  
  -- Client info
  client_type VARCHAR(50),
  client_name VARCHAR(100),
  client_os VARCHAR(100),
  device_type VARCHAR(50),
  
  -- Geo data
  country VARCHAR(100),
  region VARCHAR(100),
  city VARCHAR(100),
  
  -- Raw event data
  raw_event JSONB,
  
  event_timestamp TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

COMMENT ON TABLE email_event IS 'Mailgun webhook events for detailed tracking and audit';
COMMENT ON COLUMN email_event.event_type IS 'delivered, opened, clicked, bounced, dropped, complained, unsubscribed, stored, accepted, rejected, failed';

CREATE INDEX idx_email_event_campaign ON email_event(campaign_id);
CREATE INDEX idx_email_event_recipient ON email_event(recipient_id);
CREATE INDEX idx_email_event_email ON email_event(email);
CREATE INDEX idx_email_event_type ON email_event(event_type);
CREATE INDEX idx_email_event_mailgun_id ON email_event(mailgun_message_id);
CREATE INDEX idx_email_event_timestamp ON email_event(event_timestamp);

-- Unsubscribe list (local tracking in addition to Mailgun's)
CREATE TABLE IF NOT EXISTS email_unsubscribe (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID REFERENCES tenant(id),
  email VARCHAR(255) NOT NULL,
  member_id UUID REFERENCES member(id),
  
  -- Unsubscribe details
  unsubscribe_type VARCHAR(50) NOT NULL DEFAULT 'all',
  communication_category_id UUID REFERENCES communication_category(id),
  campaign_id UUID REFERENCES email_campaign(id),
  
  reason TEXT,
  source VARCHAR(50) NOT NULL DEFAULT 'user',
  
  unsubscribed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

COMMENT ON TABLE email_unsubscribe IS 'Local unsubscribe tracking for email preference management';
COMMENT ON COLUMN email_unsubscribe.unsubscribe_type IS 'all, category, campaign';
COMMENT ON COLUMN email_unsubscribe.source IS 'user, webhook, admin, bounce, complaint';

CREATE INDEX idx_email_unsubscribe_email ON email_unsubscribe(email);
CREATE INDEX idx_email_unsubscribe_member ON email_unsubscribe(member_id);
CREATE INDEX idx_email_unsubscribe_tenant ON email_unsubscribe(tenant_id);
CREATE UNIQUE INDEX idx_email_unsubscribe_unique ON email_unsubscribe(tenant_id, email, unsubscribe_type, communication_category_id) 
  WHERE communication_category_id IS NOT NULL;

-- Add tenant_id index for multi-tenancy
CREATE INDEX idx_email_campaign_tenant ON email_campaign(tenant_id);
CREATE INDEX idx_email_campaign_status ON email_campaign(status);
CREATE INDEX idx_email_campaign_scheduled ON email_campaign(scheduled_at) WHERE status = 'scheduled';

-- Enable RLS
ALTER TABLE email_campaign ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_campaign_recipient ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_link_click ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_unsubscribe ENABLE ROW LEVEL SECURITY;

-- RLS Policies (service role can access all)
CREATE POLICY "Service role access" ON email_campaign FOR ALL USING (true);
CREATE POLICY "Service role access" ON email_campaign_recipient FOR ALL USING (true);
CREATE POLICY "Service role access" ON email_link_click FOR ALL USING (true);
CREATE POLICY "Service role access" ON email_event FOR ALL USING (true);
CREATE POLICY "Service role access" ON email_unsubscribe FOR ALL USING (true);
