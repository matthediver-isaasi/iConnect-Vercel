import { createClient } from '@supabase/supabase-js';
import { resolveTenantFromRequest } from '../../_lib/tenantResolver.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { token } = req.query;

  if (!token) {
    return res.status(400).json({ error: 'Token is required' });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

  if (!supabaseUrl || !supabaseServiceKey) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  try {
    const { data: teamMember, error: tmError } = await supabase
      .from('fundraising_team_member')
      .select('*')
      .eq('token', token)
      .eq('is_active', true)
      .single();

    if (tmError || !teamMember) {
      return res.status(404).json({ error: 'Donation page not found' });
    }

    const { data: campaign, error: cError } = await supabase
      .from('fundraising_campaign')
      .select('*')
      .eq('id', teamMember.campaign_id)
      .eq('tenant_id', teamMember.tenant_id)
      .single();

    if (cError || !campaign) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    if (campaign.status !== 'active') {
      return res.status(404).json({ error: 'This campaign is not currently active' });
    }

    const { data: allTeamDonations } = await supabase
      .from('fundraising_donation')
      .select('amount, team_member_id')
      .eq('campaign_id', campaign.id)
      .eq('payment_status', 'succeeded');

    let teamTotal = 0;
    let memberTotal = 0;
    let teamDonorCount = 0;
    let memberDonorCount = 0;

    (allTeamDonations || []).forEach(d => {
      const amt = parseFloat(d.amount || 0);
      teamTotal += amt;
      teamDonorCount++;
      if (d.team_member_id === teamMember.id) {
        memberTotal += amt;
        memberDonorCount++;
      }
    });

    const { data: recentDonations } = await supabase
      .from('fundraising_donation')
      .select('id, donor_name, donor_message, amount, is_anonymous, created_at, gift_aid')
      .eq('team_member_id', teamMember.id)
      .eq('payment_status', 'succeeded')
      .order('created_at', { ascending: false })
      .limit(20);

    const donationIds = (recentDonations || []).map(d => d.id);
    let responsesMap = {};
    if (donationIds.length > 0) {
      const { data: responses } = await supabase
        .from('fundraising_donor_response')
        .select('donation_id, response_type, message, created_at')
        .in('donation_id', donationIds)
        .eq('response_type', 'public')
        .order('created_at', { ascending: false });

      (responses || []).forEach(r => {
        if (!responsesMap[r.donation_id]) {
          responsesMap[r.donation_id] = r;
        }
      });
    }

    const sanitizedDonations = (recentDonations || []).map(d => {
      const publicResponse = responsesMap[d.id];
      return {
        id: d.id,
        donor_name: d.is_anonymous ? 'Anonymous' : d.donor_name,
        donor_message: d.donor_message,
        amount: parseFloat(d.amount),
        is_anonymous: d.is_anonymous,
        gift_aid: d.gift_aid,
        created_at: d.created_at,
        thank_you: publicResponse ? { message: publicResponse.message, created_at: publicResponse.created_at } : null
      };
    });

    const { data: wellwishers } = await supabase
      .from('fundraising_wellwisher')
      .select('id, name, message, created_at')
      .eq('team_member_id', teamMember.id)
      .eq('tenant_id', teamMember.tenant_id)
      .order('created_at', { ascending: false })
      .limit(50);

    const wellwisherIds = (wellwishers || []).map(w => w.id);
    let wellwisherResponsesMap = {};
    if (wellwisherIds.length > 0) {
      const { data: wResponses } = await supabase
        .from('fundraising_donor_response')
        .select('wellwisher_id, message, created_at')
        .in('wellwisher_id', wellwisherIds)
        .eq('response_type', 'public')
        .order('created_at', { ascending: false });

      (wResponses || []).forEach(r => {
        if (!wellwisherResponsesMap[r.wellwisher_id]) {
          wellwisherResponsesMap[r.wellwisher_id] = r;
        }
      });
    }

    const enrichedWellwishers = (wellwishers || []).map(w => ({
      ...w,
      reply: wellwisherResponsesMap[w.id] ? { message: wellwisherResponsesMap[w.id].message, created_at: wellwisherResponsesMap[w.id].created_at } : null
    }));

    let tenantBranding = null;
    try {
      const { data: tenant } = await supabase
        .from('tenant')
        .select('name, logo_url')
        .eq('id', teamMember.tenant_id)
        .single();
      tenantBranding = tenant;
    } catch (e) {
    }

    let otherMembers = [];
    const teamName = (teamMember.team_name || '').trim() || null;
    if (teamName) {
      const { data: allMembers } = await supabase
        .from('fundraising_team_member')
        .select('id, first_name, last_name, photo_url, token')
        .eq('campaign_id', campaign.id)
        .eq('team_name', teamMember.team_name)
        .eq('is_active', true)
        .neq('id', teamMember.id)
        .order('created_at', { ascending: true });

      otherMembers = (allMembers || []).map(m => {
        const mDonations = (allTeamDonations || []).filter(d => d.team_member_id === m.id);
        const mTotal = mDonations.reduce((s, d) => s + parseFloat(d.amount || 0), 0);
        return {
          first_name: m.first_name,
          last_name: m.last_name,
          photo_url: m.photo_url,
          token: m.token,
          total_raised: mTotal
        };
      });
    }

    const hideCampaignTarget = campaign.hide_campaign_target === true;

    const campaignResponse = {
      name: campaign.name,
      description: campaign.description,
      cover_image_url: campaign.cover_image_url,
      currency: campaign.currency,
      start_date: campaign.start_date,
      end_date: campaign.end_date,
      allow_anonymous_donations: campaign.allow_anonymous_donations,
      terms_and_conditions: campaign.terms_and_conditions || null,
      privacy_statement: campaign.privacy_statement || null,
      hide_campaign_target: hideCampaignTarget
    };

    if (!hideCampaignTarget) {
      campaignResponse.goal_amount = parseFloat(campaign.goal_amount);
    }

    const progressResponse = {
      member_total: memberTotal,
      member_donor_count: memberDonorCount
    };

    if (!hideCampaignTarget) {
      progressResponse.team_total = teamTotal;
      progressResponse.team_donor_count = teamDonorCount;
      progressResponse.goal_amount = parseFloat(campaign.goal_amount);
      progressResponse.percentage = campaign.goal_amount > 0
        ? Math.min(100, Math.round((teamTotal / parseFloat(campaign.goal_amount)) * 100))
        : 0;
    }

    return res.json({
      campaign: campaignResponse,
      team_member: {
        first_name: teamMember.first_name,
        last_name: teamMember.last_name,
        photo_url: teamMember.photo_url,
        individual_goal: teamMember.individual_goal ? parseFloat(teamMember.individual_goal) : null,
        team_name: teamName
      },
      progress: progressResponse,
      recent_donations: sanitizedDonations,
      wellwishers: enrichedWellwishers,
      other_team_members: otherMembers,
      tenant: tenantBranding
    });
  } catch (error) {
    console.error('[Public Fundraising] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
