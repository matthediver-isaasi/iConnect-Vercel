import { supabase } from '../_lib/database.js';
import { getTenantContext } from '../_lib/tenantContext.js';
import crypto from 'crypto';

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
    console.error('[Fundraising Team Members] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

function generateToken() {
  return crypto.randomBytes(12).toString('base64url');
}

async function handleGet(req, res, tenantId) {
  const { campaign_id } = req.query;

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

  const { data: teamMembers, error } = await supabase
    .from('fundraising_team_member')
    .select('*')
    .eq('campaign_id', campaign_id)
    .eq('tenant_id', tenantId)
    .order('created_at', { ascending: true });

  if (error) {
    console.error('[Fundraising Team Members] Error:', error);
    return res.status(500).json({ error: 'Failed to fetch team members' });
  }

  const memberIds = (teamMembers || []).map(m => m.id);
  let donationTotals = {};

  if (memberIds.length > 0) {
    const { data: donations } = await supabase
      .from('fundraising_donation')
      .select('team_member_id, amount')
      .in('team_member_id', memberIds)
      .eq('payment_status', 'succeeded');

    (donations || []).forEach(d => {
      if (!donationTotals[d.team_member_id]) {
        donationTotals[d.team_member_id] = { total: 0, count: 0 };
      }
      donationTotals[d.team_member_id].total += parseFloat(d.amount || 0);
      donationTotals[d.team_member_id].count += 1;
    });
  }

  const enriched = (teamMembers || []).map(m => ({
    ...m,
    total_raised: donationTotals[m.id]?.total || 0,
    donation_count: donationTotals[m.id]?.count || 0
  }));

  return res.json(enriched);
}

async function handlePost(req, res, tenantId) {
  const { campaign_id, member_id, first_name, last_name, email, photo_url, individual_goal } = req.body;

  if (!campaign_id) {
    return res.status(400).json({ error: 'campaign_id is required' });
  }
  if (!first_name || !last_name) {
    return res.status(400).json({ error: 'First name and last name are required' });
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

  const token = generateToken();

  const { data, error } = await supabase
    .from('fundraising_team_member')
    .insert({
      tenant_id: tenantId,
      campaign_id,
      member_id: member_id || null,
      first_name,
      last_name,
      email: email || null,
      photo_url: photo_url || null,
      token,
      individual_goal: individual_goal ? parseFloat(individual_goal) : null
    })
    .select()
    .single();

  if (error) {
    console.error('[Fundraising Team Members] Error creating:', error);
    return res.status(500).json({ error: 'Failed to add team member' });
  }

  return res.status(201).json(data);
}

async function handlePut(req, res, tenantId) {
  const { id } = req.query;
  if (!id) {
    return res.status(400).json({ error: 'Team member ID is required' });
  }

  const { first_name, last_name, email, photo_url, individual_goal, is_active } = req.body;

  const updates = {};
  if (first_name !== undefined) updates.first_name = first_name;
  if (last_name !== undefined) updates.last_name = last_name;
  if (email !== undefined) updates.email = email;
  if (photo_url !== undefined) updates.photo_url = photo_url;
  if (individual_goal !== undefined) updates.individual_goal = individual_goal ? parseFloat(individual_goal) : null;
  if (is_active !== undefined) updates.is_active = is_active;
  updates.updated_at = new Date().toISOString();

  const { data, error } = await supabase
    .from('fundraising_team_member')
    .update(updates)
    .eq('id', id)
    .eq('tenant_id', tenantId)
    .select()
    .single();

  if (error) {
    console.error('[Fundraising Team Members] Error updating:', error);
    return res.status(500).json({ error: 'Failed to update team member' });
  }

  return res.json(data);
}

async function handleDelete(req, res, tenantId) {
  const { id } = req.query;
  if (!id) {
    return res.status(400).json({ error: 'Team member ID is required' });
  }

  const { error } = await supabase
    .from('fundraising_team_member')
    .delete()
    .eq('id', id)
    .eq('tenant_id', tenantId);

  if (error) {
    console.error('[Fundraising Team Members] Error deleting:', error);
    return res.status(500).json({ error: 'Failed to remove team member' });
  }

  return res.json({ success: true });
}
