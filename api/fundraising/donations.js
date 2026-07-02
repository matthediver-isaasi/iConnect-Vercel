import { supabase } from '../_lib/database.js';
import { getTenantContext } from '../_lib/tenantContext.js';

export default async function handler(req, res) {
  if (!supabase) {
    return res.status(500).json({ error: 'Database not configured' });
  }

  try {
    const tenantContext = await getTenantContext(req);
    if (!tenantContext?.tenantId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { tenantId } = tenantContext;

    if (req.method === 'GET') {
      return handleGet(req, res, tenantId);
    } else {
      return res.status(405).json({ error: 'Method not allowed' });
    }
  } catch (error) {
    console.error('[Fundraising Donations] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

async function handleGet(req, res, tenantId) {
  const { campaign_id, team_member_id, page = 1, limit = 50 } = req.query;

  if (!campaign_id) {
    return res.status(400).json({ error: 'campaign_id is required' });
  }

  const { data: campaign } = await supabase
    .from('fundraising_campaign')
    .select('id')
    .eq('id', campaign_id)
    .eq('tenant_id', tenantId)
    .single();

  if (!campaign) {
    return res.status(404).json({ error: 'Campaign not found' });
  }

  const offset = (parseInt(page) - 1) * parseInt(limit);

  let query = supabase
    .from('fundraising_donation')
    .select('*, fundraising_team_member(first_name, last_name)', { count: 'exact' })
    .eq('campaign_id', campaign_id)
    .eq('tenant_id', tenantId)
    .order('created_at', { ascending: false })
    .range(offset, offset + parseInt(limit) - 1);

  if (team_member_id) {
    query = query.eq('team_member_id', team_member_id);
  }

  const { data, error, count } = await query;

  if (error) {
    console.error('[Fundraising Donations] Error fetching:', error);
    return res.status(500).json({ error: 'Failed to fetch donations' });
  }

  let summaryQuery = supabase
    .from('fundraising_donation')
    .select('amount, gift_aid')
    .eq('campaign_id', campaign_id)
    .eq('tenant_id', tenantId)
    .eq('payment_status', 'succeeded');

  if (team_member_id) {
    summaryQuery = summaryQuery.eq('team_member_id', team_member_id);
  }

  const { data: allSucceeded } = await summaryQuery;

  const totalRaised = (allSucceeded || []).reduce((sum, d) => sum + parseFloat(d.amount || 0), 0);
  const giftAidCount = (allSucceeded || []).filter(d => d.gift_aid).length;

  return res.json({
    donations: data || [],
    total: count || 0,
    page: parseInt(page),
    limit: parseInt(limit),
    summary: {
      total_raised: totalRaised,
      gift_aid_count: giftAidCount,
      succeeded_count: (allSucceeded || []).length
    }
  });
}
