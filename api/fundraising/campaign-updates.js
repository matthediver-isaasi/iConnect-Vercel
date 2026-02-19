import { getTenantContext } from '../_lib/tenantContext.js';
import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

  if (!supabaseUrl || !supabaseServiceKey) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  try {
    const tenantContext = await getTenantContext(req);
    if (!tenantContext?.tenantId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { tenantId } = tenantContext;

    if (req.method === 'GET') {
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

      const { data: updates, error: fetchError } = await supabase
        .from('fundraising_update')
        .select(`
          id,
          content,
          image_url,
          attachment_urls,
          visibility,
          posted_by,
          posted_by_name,
          created_at,
          team_member_id,
          parent_id,
          fundraising_team_member (
            first_name,
            last_name
          )
        `)
        .eq('campaign_id', campaign_id)
        .eq('tenant_id', tenantId)
        .order('created_at', { ascending: false })
        .limit(200);

      if (fetchError) {
        console.error('[Campaign Updates] GET error:', fetchError);
        return res.status(500).json({ error: 'Failed to fetch updates' });
      }

      const result = (updates || []).map(u => ({
        id: u.id,
        content: u.content,
        image_url: u.image_url,
        attachment_urls: u.attachment_urls || [],
        visibility: u.visibility || 'public',
        posted_by: u.posted_by || 'fundraiser',
        posted_by_name: u.posted_by_name,
        created_at: u.created_at,
        team_member_id: u.team_member_id,
        parent_id: u.parent_id || null,
        author_name: u.posted_by === 'tenant'
          ? (u.posted_by_name || 'Campaign Organiser')
          : u.fundraising_team_member
            ? `${u.fundraising_team_member.first_name} ${u.fundraising_team_member.last_name}`
            : 'Unknown',
        author_initials: u.posted_by === 'tenant'
          ? (u.posted_by_name ? u.posted_by_name.split(' ').map(n => n[0]).join('').substring(0, 2) : 'CO')
          : u.fundraising_team_member
            ? `${u.fundraising_team_member.first_name?.[0] || ''}${u.fundraising_team_member.last_name?.[0] || ''}`
            : '?'
      }));

      return res.json(result);
    }

    if (req.method === 'POST') {
      const { campaign_id, content, image_url, visibility, posted_by_name, attachment_urls, parent_id } = req.body;

      if (!campaign_id || !content?.trim()) {
        return res.status(400).json({ error: 'campaign_id and content are required' });
      }

      if (visibility && !['public', 'private'].includes(visibility)) {
        return res.status(400).json({ error: 'visibility must be public or private' });
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

      if (parent_id) {
        const { data: parentUpdate } = await supabase
          .from('fundraising_update')
          .select('id')
          .eq('id', parent_id)
          .eq('campaign_id', campaign_id)
          .eq('tenant_id', tenantId)
          .single();

        if (!parentUpdate) {
          return res.status(404).json({ error: 'Parent update not found' });
        }
      }

      const { data: update, error: insertError } = await supabase
        .from('fundraising_update')
        .insert({
          tenant_id: tenantId,
          campaign_id,
          team_member_id: null,
          content: content.trim(),
          image_url: image_url || null,
          attachment_urls: attachment_urls && attachment_urls.length > 0 ? attachment_urls : null,
          visibility: visibility || 'public',
          posted_by: 'tenant',
          posted_by_name: posted_by_name?.trim() || null,
          parent_id: parent_id || null
        })
        .select()
        .single();

      if (insertError) {
        console.error('[Campaign Updates] Insert error:', insertError);
        return res.status(500).json({ error: 'Failed to create update' });
      }

      return res.status(201).json(update);
    }

    if (req.method === 'DELETE') {
      const { id } = req.query;
      if (!id) {
        return res.status(400).json({ error: 'id is required' });
      }

      const { error: deleteError } = await supabase
        .from('fundraising_update')
        .delete()
        .eq('id', id)
        .eq('tenant_id', tenantId);

      if (deleteError) {
        console.error('[Campaign Updates] Delete error:', deleteError);
        return res.status(500).json({ error: 'Failed to delete update' });
      }

      return res.json({ success: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    console.error('[Campaign Updates] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
