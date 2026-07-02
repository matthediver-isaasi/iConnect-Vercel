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

    const { data: campaigns, error } = await supabase
      .from('fundraising_campaign')
      .select('id, name, slug, description, public_description, cover_image_url, goal_amount, currency, start_date, end_date, status, registration_open, hide_campaign_target')
      .eq('tenant_id', tenant.id)
      .eq('status', 'active')
      .order('created_at', { ascending: false });

    if (error) {
      console.error('[Public Campaigns List] Query error:', error);
      return res.status(500).json({ error: 'Failed to fetch campaigns' });
    }

    if (!campaigns || campaigns.length === 0) {
      return res.json({
        campaigns: [],
        tenant_name: tenant.name,
        tenant_logo_url: tenant.logo_url
      });
    }

    const campaignIds = campaigns.map(c => c.id);

    const { data: donations } = await supabase
      .from('fundraising_donation')
      .select('campaign_id, amount')
      .eq('tenant_id', tenant.id)
      .in('campaign_id', campaignIds)
      .eq('payment_status', 'succeeded');

    const donationStats = {};
    (donations || []).forEach(d => {
      if (!donationStats[d.campaign_id]) {
        donationStats[d.campaign_id] = { raised: 0, count: 0 };
      }
      donationStats[d.campaign_id].raised += parseFloat(d.amount || 0);
      donationStats[d.campaign_id].count += 1;
    });

    const { data: teamMembers } = await supabase
      .from('fundraising_team_member')
      .select('campaign_id')
      .eq('tenant_id', tenant.id)
      .in('campaign_id', campaignIds)
      .eq('is_active', true);

    const participantCounts = {};
    (teamMembers || []).forEach(m => {
      participantCounts[m.campaign_id] = (participantCounts[m.campaign_id] || 0) + 1;
    });

    const enrichedCampaigns = campaigns.map(c => {
      const stats = donationStats[c.id] || { raised: 0, count: 0 };
      const result = {
        id: c.id,
        name: c.name,
        slug: c.slug,
        description: c.public_description || c.description,
        cover_image_url: c.cover_image_url,
        currency: c.currency,
        start_date: c.start_date,
        end_date: c.end_date,
        registration_open: c.registration_open,
        participant_count: participantCounts[c.id] || 0,
        hide_campaign_target: c.hide_campaign_target
      };

      if (!c.hide_campaign_target) {
        result.goal_amount = parseFloat(c.goal_amount || 0);
        result.total_raised = stats.raised;
        result.donation_count = stats.count;
      }

      return result;
    });

    return res.json({
      campaigns: enrichedCampaigns,
      tenant_name: tenant.name,
      tenant_logo_url: tenant.logo_url
    });
  } catch (error) {
    console.error('[Public Campaigns List] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
