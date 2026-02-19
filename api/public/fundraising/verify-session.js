import { createClient } from '@supabase/supabase-js';
import { resolveTenantFromRequest } from '../../_lib/tenantResolver.js';

async function fetchDashboardData(supabase, tenantId, email) {
  const { data: members, error: membersError } = await supabase
    .from('fundraising_team_member')
    .select(`
      id,
      campaign_id,
      organization_id,
      first_name,
      last_name,
      email,
      token,
      individual_goal,
      is_active,
      created_at
    `)
    .eq('tenant_id', tenantId)
    .ilike('email', email)
    .eq('is_active', true)
    .order('created_at', { ascending: true });

  if (membersError || !members || members.length === 0) {
    return null;
  }

  const campaignIds = [...new Set(members.map(m => m.campaign_id))];
  const orgIds = [...new Set(members.filter(m => m.organization_id).map(m => m.organization_id))];

  const { data: campaigns } = await supabase
    .from('fundraising_campaign')
    .select('id, name, slug, description, cover_image_url, goal_amount, currency, start_date, end_date, status, hide_campaign_target')
    .eq('tenant_id', tenantId)
    .in('id', campaignIds);

  const campaignMap = {};
  (campaigns || []).forEach(c => { campaignMap[c.id] = c; });

  let orgMap = {};
  if (orgIds.length > 0) {
    const { data: orgs } = await supabase
      .from('organization')
      .select('id, name')
      .in('id', orgIds);
    (orgs || []).forEach(o => { orgMap[o.id] = o; });
  }

  const memberIds = members.map(m => m.id);
  const { data: individualDonations } = await supabase
    .from('fundraising_donation')
    .select('team_member_id, amount')
    .eq('tenant_id', tenantId)
    .in('team_member_id', memberIds)
    .eq('payment_status', 'succeeded');

  const individualStats = {};
  (individualDonations || []).forEach(d => {
    if (!individualStats[d.team_member_id]) {
      individualStats[d.team_member_id] = { raised: 0, count: 0 };
    }
    individualStats[d.team_member_id].raised += parseFloat(d.amount || 0);
    individualStats[d.team_member_id].count += 1;
  });

  const { data: campaignDonations } = await supabase
    .from('fundraising_donation')
    .select('campaign_id, amount')
    .eq('tenant_id', tenantId)
    .in('campaign_id', campaignIds)
    .eq('payment_status', 'succeeded');

  const campaignRaised = {};
  (campaignDonations || []).forEach(d => {
    if (!campaignRaised[d.campaign_id]) {
      campaignRaised[d.campaign_id] = 0;
    }
    campaignRaised[d.campaign_id] += parseFloat(d.amount || 0);
  });

  const { data: allCampaignMembers } = await supabase
    .from('fundraising_team_member')
    .select('id, campaign_id, created_at')
    .in('campaign_id', campaignIds)
    .eq('tenant_id', tenantId)
    .order('created_at', { ascending: true });

  const firstMemberPerCampaign = {};
  (allCampaignMembers || []).forEach(m => {
    if (!firstMemberPerCampaign[m.campaign_id]) {
      firstMemberPerCampaign[m.campaign_id] = m.id;
    }
  });

  const { data: memberDonationsDetail } = await supabase
    .from('fundraising_donation')
    .select('id, team_member_id, campaign_id, donor_name, donor_email, donor_message, amount, currency, is_anonymous, gift_aid, created_at')
    .eq('tenant_id', tenantId)
    .in('team_member_id', memberIds)
    .eq('payment_status', 'succeeded')
    .order('created_at', { ascending: false });

  const donorsByMember = {};
  (memberDonationsDetail || []).forEach(d => {
    if (!donorsByMember[d.team_member_id]) {
      donorsByMember[d.team_member_id] = [];
    }
    donorsByMember[d.team_member_id].push({
      id: d.id,
      donor_name: d.is_anonymous ? 'Anonymous' : d.donor_name,
      donor_email: d.donor_email,
      donor_message: d.donor_message,
      amount: parseFloat(d.amount),
      currency: d.currency,
      is_anonymous: d.is_anonymous,
      gift_aid: d.gift_aid,
      created_at: d.created_at
    });
  });

  const allDonationIds = (memberDonationsDetail || []).map(d => d.id);
  let existingResponsesMap = {};
  if (allDonationIds.length > 0) {
    const { data: existingResponses } = await supabase
      .from('fundraising_donor_response')
      .select('donation_id, response_type, message, created_at')
      .in('donation_id', allDonationIds);

    (existingResponses || []).forEach(r => {
      if (!existingResponsesMap[r.donation_id]) {
        existingResponsesMap[r.donation_id] = [];
      }
      existingResponsesMap[r.donation_id].push(r);
    });
  }

  Object.values(donorsByMember).forEach(donors => {
    donors.forEach(d => {
      d.responses = existingResponsesMap[d.id] || [];
    });
  });

  const { data: memberWellwishers } = await supabase
    .from('fundraising_wellwisher')
    .select('id, team_member_id, name, email, message, created_at')
    .eq('tenant_id', tenantId)
    .in('team_member_id', memberIds)
    .order('created_at', { ascending: false });

  const wellwishersByMember = {};
  (memberWellwishers || []).forEach(w => {
    if (!wellwishersByMember[w.team_member_id]) {
      wellwishersByMember[w.team_member_id] = [];
    }
    wellwishersByMember[w.team_member_id].push({
      id: w.id,
      name: w.name,
      email: w.email,
      message: w.message,
      created_at: w.created_at
    });
  });

  const allWellwisherIds = (memberWellwishers || []).map(w => w.id);
  let wellwisherResponsesMap = {};
  if (allWellwisherIds.length > 0) {
    const { data: wellwisherResponses } = await supabase
      .from('fundraising_donor_response')
      .select('wellwisher_id, response_type, message, created_at')
      .in('wellwisher_id', allWellwisherIds)
      .eq('response_type', 'public');

    (wellwisherResponses || []).forEach(r => {
      if (!wellwisherResponsesMap[r.wellwisher_id]) {
        wellwisherResponsesMap[r.wellwisher_id] = [];
      }
      wellwisherResponsesMap[r.wellwisher_id].push(r);
    });
  }

  Object.values(wellwishersByMember).forEach(wellwishers => {
    wellwishers.forEach(w => {
      w.responses = wellwisherResponsesMap[w.id] || [];
    });
  });

  const campaignsData = members.map(member => {
    const campaign = campaignMap[member.campaign_id];
    if (!campaign) return null;

    const stats = individualStats[member.id] || { raised: 0, count: 0 };
    const org = member.organization_id ? orgMap[member.organization_id] : null;
    const isLead = firstMemberPerCampaign[member.campaign_id] === member.id;

    const result = {
      campaign_id: campaign.id,
      campaign_name: campaign.name,
      campaign_slug: campaign.slug,
      campaign_status: campaign.status,
      campaign_cover_image_url: campaign.cover_image_url,
      currency: campaign.currency,
      hide_campaign_target: campaign.hide_campaign_target === true,
      team_member_id: member.id,
      participant_token: member.token,
      individual_goal: parseFloat(member.individual_goal || 0),
      individual_raised: stats.raised,
      donation_count: stats.count,
      organization_name: org?.name || null,
      role: isLead ? 'lead' : 'member',
      donors: donorsByMember[member.id] || [],
      wellwishers: wellwishersByMember[member.id] || []
    };

    if (campaign.hide_campaign_target !== true) {
      result.campaign_goal = parseFloat(campaign.goal_amount || 0);
      result.campaign_raised = campaignRaised[campaign.id] || 0;
    }

    return result;
  }).filter(Boolean);

  return {
    email,
    first_name: members[0].first_name,
    last_name: members[0].last_name,
    campaigns: campaignsData
  };
}

export { fetchDashboardData };

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

    const sessionToken = req.query.session_token;
    if (!sessionToken) {
      return res.status(400).json({ error: 'Session token is required' });
    }

    const { data: tokenRecord, error: tokenError } = await supabase
      .from('fundraising_login_token')
      .select('*')
      .eq('token', sessionToken)
      .eq('tenant_id', tenant.id)
      .eq('type', 'session')
      .single();

    if (tokenError || !tokenRecord) {
      return res.status(401).json({ error: 'Session expired. Please log in again.' });
    }

    if (new Date(tokenRecord.expires_at) < new Date()) {
      await supabase.from('fundraising_login_token').delete().eq('id', tokenRecord.id);
      return res.status(401).json({ error: 'Session expired. Please log in again.' });
    }

    const dashboardData = await fetchDashboardData(supabase, tenant.id, tokenRecord.email);

    if (!dashboardData) {
      return res.status(404).json({ error: 'No active fundraising campaigns found' });
    }

    return res.status(200).json(dashboardData);
  } catch (err) {
    console.error('Verify fundraiser session error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
