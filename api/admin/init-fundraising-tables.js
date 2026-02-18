import { supabase } from '../_lib/database.js';
import { getTenantContext } from '../_lib/tenantContext.js';

const FUNDRAISING_SQL = `
CREATE TABLE IF NOT EXISTS fundraising_campaign (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id UUID NOT NULL,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  description TEXT,
  cover_image_url TEXT,
  goal_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'GBP',
  start_date TIMESTAMPTZ,
  end_date TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'completed', 'cancelled')),
  allow_anonymous_donations BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(tenant_id, slug)
);

CREATE INDEX IF NOT EXISTS idx_fundraising_campaign_tenant
  ON fundraising_campaign(tenant_id);
CREATE INDEX IF NOT EXISTS idx_fundraising_campaign_status
  ON fundraising_campaign(tenant_id, status);

CREATE TABLE IF NOT EXISTS fundraising_team_member (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id UUID NOT NULL,
  campaign_id UUID NOT NULL REFERENCES fundraising_campaign(id) ON DELETE CASCADE,
  member_id UUID,
  organization_id UUID REFERENCES organization(id) ON DELETE SET NULL,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  email TEXT,
  photo_url TEXT,
  token TEXT NOT NULL UNIQUE,
  individual_goal NUMERIC(12,2),
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_fundraising_team_member_campaign
  ON fundraising_team_member(campaign_id);
CREATE INDEX IF NOT EXISTS idx_fundraising_team_member_token
  ON fundraising_team_member(token);
CREATE INDEX IF NOT EXISTS idx_fundraising_team_member_tenant
  ON fundraising_team_member(tenant_id);

CREATE TABLE IF NOT EXISTS fundraising_donation (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id UUID NOT NULL,
  campaign_id UUID NOT NULL REFERENCES fundraising_campaign(id) ON DELETE CASCADE,
  team_member_id UUID NOT NULL REFERENCES fundraising_team_member(id) ON DELETE CASCADE,
  donor_name TEXT NOT NULL,
  donor_email TEXT,
  donor_message TEXT,
  is_anonymous BOOLEAN DEFAULT false,
  amount NUMERIC(12,2) NOT NULL,
  currency TEXT NOT NULL DEFAULT 'GBP',
  gift_aid BOOLEAN DEFAULT false,
  gift_aid_address_line_1 TEXT,
  gift_aid_address_line_2 TEXT,
  gift_aid_city TEXT,
  gift_aid_postcode TEXT,
  stripe_payment_intent_id TEXT,
  payment_status TEXT NOT NULL DEFAULT 'pending' CHECK (payment_status IN ('pending', 'succeeded', 'failed', 'refunded')),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_fundraising_donation_campaign
  ON fundraising_donation(campaign_id);
CREATE INDEX IF NOT EXISTS idx_fundraising_donation_team_member
  ON fundraising_donation(team_member_id);
CREATE INDEX IF NOT EXISTS idx_fundraising_donation_tenant
  ON fundraising_donation(tenant_id);
CREATE INDEX IF NOT EXISTS idx_fundraising_donation_payment
  ON fundraising_donation(stripe_payment_intent_id);

CREATE TABLE IF NOT EXISTS fundraising_login_token (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id UUID NOT NULL,
  email TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL DEFAULT 'magic_link' CHECK (type IN ('magic_link', 'session')),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_fundraising_login_token_token ON fundraising_login_token(token);
CREATE INDEX IF NOT EXISTS idx_fundraising_login_token_email ON fundraising_login_token(tenant_id, email);
`;

export default async function handler(req, res) {
  if (!supabase) {
    return res.status(500).json({ error: 'Database not configured' });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const tenantContext = await getTenantContext(req);
    if (!tenantContext?.tenantId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { error } = await supabase.rpc('exec_sql', {
      sql_text: FUNDRAISING_SQL
    });

    if (error) {
      if (error.message?.includes('function') && error.message?.includes('does not exist')) {
        const { error: checkError } = await supabase
          .from('fundraising_campaign')
          .select('id')
          .limit(1);

        if (checkError && checkError.code === '42P01') {
          return res.status(200).json({
            success: false,
            message: 'Tables do not exist yet. Please create the fundraising tables manually in Supabase SQL editor.',
            sql: FUNDRAISING_SQL
          });
        }

        return res.json({ success: true, message: 'Tables already exist' });
      }

      console.error('[Init Fundraising] Error:', error);
      return res.status(500).json({ error: 'Failed to create tables', details: error.message });
    }

    return res.json({ success: true, message: 'Fundraising tables created successfully' });
  } catch (error) {
    console.error('[Init Fundraising] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
