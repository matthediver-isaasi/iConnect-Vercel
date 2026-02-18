import { createClient } from '@supabase/supabase-js';
import { resolveTenantFromRequest } from '../../_lib/tenantResolver.js';

export default async function handler(req, res) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

  if (!supabaseUrl || !supabaseServiceKey) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  if (req.method === 'GET') {
    try {
      const { token, campaign_id } = req.query;

      let targetCampaignId = campaign_id;
      let targetTenantId = null;

      if (token) {
        const { data: member, error: memberError } = await supabase
          .from('fundraising_team_member')
          .select('campaign_id, tenant_id')
          .eq('token', token)
          .eq('is_active', true)
          .single();

        if (memberError || !member) {
          return res.status(404).json({ error: 'Team member not found' });
        }

        targetCampaignId = member.campaign_id;
        targetTenantId = member.tenant_id;
      } else if (campaign_id) {
        const { data: campaign, error: campaignError } = await supabase
          .from('fundraising_campaign')
          .select('id, tenant_id')
          .eq('id', campaign_id)
          .single();

        if (campaignError || !campaign) {
          return res.status(404).json({ error: 'Campaign not found' });
        }

        targetTenantId = campaign.tenant_id;
      }

      if (!targetCampaignId || !targetTenantId) {
        return res.status(400).json({ error: 'token or campaign_id is required' });
      }

      const { data: updates, error: updatesError } = await supabase
        .from('fundraising_update')
        .select(`
          id,
          content,
          image_url,
          created_at,
          team_member_id,
          fundraising_team_member (
            first_name,
            last_name
          )
        `)
        .eq('campaign_id', targetCampaignId)
        .eq('tenant_id', targetTenantId)
        .order('created_at', { ascending: false })
        .limit(50);

      if (updatesError) {
        console.error('[Fundraising Updates] GET error:', updatesError);
        return res.status(500).json({ error: 'Failed to fetch updates' });
      }

      const result = (updates || []).map(u => ({
        id: u.id,
        content: u.content,
        image_url: u.image_url,
        created_at: u.created_at,
        author_name: u.fundraising_team_member
          ? `${u.fundraising_team_member.first_name} ${u.fundraising_team_member.last_name}`
          : 'Unknown',
        author_initials: u.fundraising_team_member
          ? `${u.fundraising_team_member.first_name?.[0] || ''}${u.fundraising_team_member.last_name?.[0] || ''}`
          : '?'
      }));

      return res.json(result);
    } catch (err) {
      console.error('[Fundraising Updates] GET error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }

  if (req.method === 'POST') {
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
        return res.status(401).json({ error: 'Session expired. Please log in again.' });
      }

      const { team_member_id, campaign_id, content, image_url } = req.body;

      if (!team_member_id || !campaign_id || !content?.trim()) {
        return res.status(400).json({ error: 'team_member_id, campaign_id, and content are required' });
      }

      const { data: member, error: memberError } = await supabase
        .from('fundraising_team_member')
        .select('id, email, campaign_id, tenant_id')
        .eq('id', team_member_id)
        .single();

      if (memberError || !member) {
        return res.status(404).json({ error: 'Team member not found' });
      }

      if (member.email?.toLowerCase() !== tokenRecord.email?.toLowerCase()) {
        return res.status(403).json({ error: 'Not authorized to post updates for this team member' });
      }

      if (member.campaign_id !== campaign_id || member.tenant_id !== tenant.id) {
        return res.status(403).json({ error: 'Team member does not belong to this campaign' });
      }

      const { data: update, error: insertError } = await supabase
        .from('fundraising_update')
        .insert({
          tenant_id: tenant.id,
          campaign_id,
          team_member_id,
          content: content.trim(),
          image_url: image_url || null
        })
        .select()
        .single();

      if (insertError) {
        console.error('[Fundraising Updates] Insert error:', insertError);
        return res.status(500).json({ error: 'Failed to create update' });
      }

      return res.status(201).json(update);
    } catch (err) {
      console.error('[Fundraising Updates] POST error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
