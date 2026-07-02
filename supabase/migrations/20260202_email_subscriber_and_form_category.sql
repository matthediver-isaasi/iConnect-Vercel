-- Email Subscriber table for non-member newsletter subscriptions
-- Tracks opt-in/opt-out status for people who submit forms but aren't members

CREATE TABLE IF NOT EXISTS email_subscriber (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenant(id),
  email VARCHAR(255) NOT NULL,
  first_name VARCHAR(255),
  last_name VARCHAR(255),
  
  -- Which form they subscribed via
  form_id UUID REFERENCES form(id) ON DELETE SET NULL,
  
  -- Which communication category this subscription is for
  communication_category_id UUID REFERENCES communication_category(id) ON DELETE SET NULL,
  
  -- Subscription status
  opted_out BOOLEAN NOT NULL DEFAULT false,
  
  -- Timestamps
  subscribed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  opted_out_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

COMMENT ON TABLE email_subscriber IS 'Non-member email subscriptions from form submissions (newsletter signups, etc.)';
COMMENT ON COLUMN email_subscriber.opted_out IS 'When true, subscriber has opted out of emails for this category';
COMMENT ON COLUMN email_subscriber.form_id IS 'The form that was submitted to create this subscription';

CREATE INDEX idx_email_subscriber_tenant ON email_subscriber(tenant_id);
CREATE INDEX idx_email_subscriber_email ON email_subscriber(email);
CREATE INDEX idx_email_subscriber_form ON email_subscriber(form_id);
CREATE INDEX idx_email_subscriber_category ON email_subscriber(communication_category_id);

-- Unique constraint: one subscription per email per tenant per category
CREATE UNIQUE INDEX idx_email_subscriber_unique ON email_subscriber(tenant_id, email, communication_category_id) 
  WHERE communication_category_id IS NOT NULL;

-- Add communication_category_id to form table for linking forms to categories
-- This allows forms (like newsletter signup) to auto-subscribe submitters to a category
ALTER TABLE form ADD COLUMN IF NOT EXISTS communication_category_id UUID REFERENCES communication_category(id) ON DELETE SET NULL;

COMMENT ON COLUMN form.communication_category_id IS 'When set, form submissions will auto-subscribe the submitter to this communication category';

-- Enable RLS on email_subscriber
ALTER TABLE email_subscriber ENABLE ROW LEVEL SECURITY;

-- RLS Policy (service role can access all)
CREATE POLICY "Service role access" ON email_subscriber FOR ALL USING (true);
