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
    } else if (req.method === 'POST') {
      return handlePost(req, res, tenantId);
    } else if (req.method === 'PUT') {
      return handlePut(req, res, tenantId);
    } else if (req.method === 'DELETE') {
      return handleDelete(req, res, tenantId);
    } else {
      return res.status(405).json({ error: 'Method not allowed' });
    }
  } catch (error) {
    console.error('[Fundraising Campaigns] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

function generateSlug(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 80);
}

async function handleGet(req, res, tenantId) {
  const { id } = req.query;

  if (id) {
    const { data, error } = await supabase
      .from('fundraising_campaign')
      .select('*')
      .eq('id', id)
      .eq('tenant_id', tenantId)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return res.status(404).json({ error: 'Campaign not found' });
      }
      console.error('[Fundraising Campaigns] Error fetching campaign:', error);
      return res.status(500).json({ error: 'Failed to fetch campaign' });
    }

    const { data: teamMembers } = await supabase
      .from('fundraising_team_member')
      .select('*')
      .eq('campaign_id', id)
      .eq('tenant_id', tenantId)
      .order('created_at', { ascending: true });

    const { data: allDonations } = await supabase
      .from('fundraising_donation')
      .select('id, team_member_id, donor_name, donor_email, donor_message, is_anonymous, amount, currency, gift_aid, gift_aid_address_line_1, gift_aid_city, gift_aid_postcode, payment_status, created_at')
      .eq('campaign_id', id)
      .eq('tenant_id', tenantId)
      .order('created_at', { ascending: false });

    const donations = allDonations || [];
    const succeededDonations = donations.filter(d => d.payment_status === 'succeeded');
    const totalRaised = succeededDonations.reduce((sum, d) => sum + parseFloat(d.amount || 0), 0);
    const donationCount = succeededDonations.length;
    const giftAidDonations = succeededDonations.filter(d => d.gift_aid);
    const giftAidTotal = giftAidDonations.reduce((sum, d) => sum + parseFloat(d.amount || 0) * 0.25, 0);
    const avgDonation = donationCount > 0 ? totalRaised / donationCount : 0;

    const uniqueDonors = new Set(succeededDonations.map(d => d.donor_email).filter(Boolean)).size;

    const memberStats = {};
    succeededDonations.forEach(d => {
      if (!memberStats[d.team_member_id]) {
        memberStats[d.team_member_id] = { raised: 0, count: 0, gift_aid_count: 0 };
      }
      memberStats[d.team_member_id].raised += parseFloat(d.amount || 0);
      memberStats[d.team_member_id].count += 1;
      if (d.gift_aid) memberStats[d.team_member_id].gift_aid_count += 1;
    });

    const enrichedTeamMembers = (teamMembers || []).map(m => ({
      ...m,
      total_raised: memberStats[m.id]?.raised || 0,
      donation_count: memberStats[m.id]?.count || 0,
      gift_aid_count: memberStats[m.id]?.gift_aid_count || 0
    }));

    const topDonors = succeededDonations
      .filter(d => !d.is_anonymous)
      .sort((a, b) => parseFloat(b.amount) - parseFloat(a.amount))
      .slice(0, 10)
      .map(d => ({
        donor_name: d.donor_name,
        amount: d.amount,
        currency: d.currency,
        gift_aid: d.gift_aid,
        created_at: d.created_at,
        donor_message: d.donor_message
      }));

    const recentDonations = donations.slice(0, 15).map(d => ({
      id: d.id,
      donor_name: d.is_anonymous ? 'Anonymous' : d.donor_name,
      amount: d.amount,
      currency: d.currency,
      gift_aid: d.gift_aid,
      payment_status: d.payment_status,
      created_at: d.created_at,
      donor_message: d.donor_message,
      team_member_id: d.team_member_id
    }));

    return res.json({
      ...data,
      team_members: enrichedTeamMembers,
      total_raised: totalRaised,
      donation_count: donationCount,
      gift_aid_total: giftAidTotal,
      gift_aid_count: giftAidDonations.length,
      avg_donation: avgDonation,
      unique_donors: uniqueDonors,
      pending_count: donations.filter(d => d.payment_status === 'pending').length,
      top_donors: topDonors,
      recent_donations: recentDonations
    });
  }

  const { data, error } = await supabase
    .from('fundraising_campaign')
    .select('*')
    .eq('tenant_id', tenantId)
    .order('created_at', { ascending: false });

  if (error) {
    console.error('[Fundraising Campaigns] Error fetching campaigns:', error);
    return res.status(500).json({ error: 'Failed to fetch campaigns' });
  }

  const campaignIds = (data || []).map(c => c.id);
  let donationSummaries = {};
  let teamMemberCounts = {};

  if (campaignIds.length > 0) {
    const { data: donations } = await supabase
      .from('fundraising_donation')
      .select('campaign_id, amount')
      .in('campaign_id', campaignIds)
      .eq('payment_status', 'succeeded');

    (donations || []).forEach(d => {
      if (!donationSummaries[d.campaign_id]) {
        donationSummaries[d.campaign_id] = { total: 0, count: 0 };
      }
      donationSummaries[d.campaign_id].total += parseFloat(d.amount || 0);
      donationSummaries[d.campaign_id].count += 1;
    });

    const { data: members } = await supabase
      .from('fundraising_team_member')
      .select('campaign_id')
      .in('campaign_id', campaignIds);

    (members || []).forEach(m => {
      teamMemberCounts[m.campaign_id] = (teamMemberCounts[m.campaign_id] || 0) + 1;
    });
  }

  const enriched = (data || []).map(c => ({
    ...c,
    total_raised: donationSummaries[c.id]?.total || 0,
    donation_count: donationSummaries[c.id]?.count || 0,
    team_member_count: teamMemberCounts[c.id] || 0
  }));

  return res.json(enriched);
}

async function handlePost(req, res, tenantId) {
  const { name, description, cover_image_url, goal_amount, currency, start_date, end_date, status, allow_anonymous_donations } = req.body;

  if (!name) {
    return res.status(400).json({ error: 'Campaign name is required' });
  }

  if (!goal_amount || parseFloat(goal_amount) <= 0) {
    return res.status(400).json({ error: 'A positive goal amount is required' });
  }

  let slug = generateSlug(name);
  const { data: existing } = await supabase
    .from('fundraising_campaign')
    .select('id')
    .eq('tenant_id', tenantId)
    .eq('slug', slug);

  if (existing && existing.length > 0) {
    slug = `${slug}-${Date.now().toString(36)}`;
  }

  const { data, error } = await supabase
    .from('fundraising_campaign')
    .insert({
      tenant_id: tenantId,
      name,
      slug,
      description: description || null,
      cover_image_url: cover_image_url || null,
      goal_amount: parseFloat(goal_amount),
      currency: currency || 'GBP',
      start_date: start_date || null,
      end_date: end_date || null,
      status: status || 'draft',
      allow_anonymous_donations: allow_anonymous_donations !== false
    })
    .select()
    .single();

  if (error) {
    console.error('[Fundraising Campaigns] Error creating campaign:', error);
    return res.status(500).json({ error: 'Failed to create campaign' });
  }

  return res.status(201).json(data);
}

async function handlePut(req, res, tenantId) {
  const { id } = req.query;
  if (!id) {
    return res.status(400).json({ error: 'Campaign ID is required' });
  }

  const { name, description, cover_image_url, goal_amount, currency, start_date, end_date, status, allow_anonymous_donations } = req.body;

  const updates = {};
  if (name !== undefined) updates.name = name;
  if (description !== undefined) updates.description = description;
  if (cover_image_url !== undefined) updates.cover_image_url = cover_image_url;
  if (goal_amount !== undefined) updates.goal_amount = parseFloat(goal_amount);
  if (currency !== undefined) updates.currency = currency;
  if (start_date !== undefined) updates.start_date = start_date;
  if (end_date !== undefined) updates.end_date = end_date;
  if (status !== undefined) updates.status = status;
  if (allow_anonymous_donations !== undefined) updates.allow_anonymous_donations = allow_anonymous_donations;
  updates.updated_at = new Date().toISOString();

  const { data, error } = await supabase
    .from('fundraising_campaign')
    .update(updates)
    .eq('id', id)
    .eq('tenant_id', tenantId)
    .select()
    .single();

  if (error) {
    console.error('[Fundraising Campaigns] Error updating campaign:', error);
    return res.status(500).json({ error: 'Failed to update campaign' });
  }

  return res.json(data);
}

async function handleDelete(req, res, tenantId) {
  const { id } = req.query;
  if (!id) {
    return res.status(400).json({ error: 'Campaign ID is required' });
  }

  const { error } = await supabase
    .from('fundraising_campaign')
    .delete()
    .eq('id', id)
    .eq('tenant_id', tenantId);

  if (error) {
    console.error('[Fundraising Campaigns] Error deleting campaign:', error);
    return res.status(500).json({ error: 'Failed to delete campaign' });
  }

  return res.json({ success: true });
}
