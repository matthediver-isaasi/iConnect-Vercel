import { createClient } from '@supabase/supabase-js';
import { resolveTenantFromRequest } from '../../_lib/tenantResolver.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

  if (!supabaseUrl || !supabaseServiceKey) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  try {
    const tenant = await resolveTenantFromRequest(req);
    if (!tenant?.id) {
      return res.status(404).json({ error: 'Tenant not found' });
    }

    const { slug } = req.query;
    if (!slug) {
      return res.status(400).json({ error: 'Campaign slug is required' });
    }

    const { data: campaign, error } = await supabase
      .from('fundraising_campaign')
      .select('id, name, slug, description, public_description, cover_image_url, goal_amount, currency, start_date, end_date, status, campaign_type, max_team_size, registration_open, registration_message, allow_anonymous_donations, allow_org_signup')
      .eq('tenant_id', tenant.id)
      .eq('slug', slug)
      .single();

    if (error || !campaign) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    if (campaign.status !== 'active') {
      return res.status(400).json({ error: 'This campaign is not currently active' });
    }

    const { data: donations } = await supabase
      .from('fundraising_donation')
      .select('amount')
      .eq('campaign_id', campaign.id)
      .eq('tenant_id', tenant.id)
      .eq('payment_status', 'succeeded');

    const totalRaised = (donations || []).reduce((sum, d) => sum + parseFloat(d.amount || 0), 0);
    const donationCount = (donations || []).length;

    const { count: participantCount } = await supabase
      .from('fundraising_team_member')
      .select('id', { count: 'exact', head: true })
      .eq('campaign_id', campaign.id)
      .eq('tenant_id', tenant.id)
      .eq('is_active', true);

    return res.json({
      ...campaign,
      total_raised: totalRaised,
      donation_count: donationCount,
      participant_count: participantCount || 0,
      tenant_name: tenant.name,
      tenant_logo_url: tenant.logo_url,
      tenant_primary_color: tenant.primary_color
    });
  } catch (error) {
    console.error('[Public Fundraising Campaign] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
