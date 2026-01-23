import { createClient } from '@supabase/supabase-js';
import { getSessionTenantUser } from '../_lib/session.js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

export default async function handler(req, res) {
  const session = await getSessionTenantUser(req, res);
  if (!session) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const supabase = createClient(supabaseUrl, supabaseServiceKey);
  const { tenantId } = session;

  if (req.method === 'GET') {
    try {
      const { identity_id, meeting_template_id } = req.query;

      let query = supabase
        .from('agent_meeting_template')
        .select(`
          *,
          identity:identity_id(id, email, first_name, last_name, booking_slug),
          template:meeting_template_id(id, name, slug, duration_minutes, meeting_type)
        `)
        .eq('tenant_id', tenantId);

      if (identity_id) {
        query = query.eq('identity_id', identity_id);
      }
      if (meeting_template_id) {
        query = query.eq('meeting_template_id', meeting_template_id);
      }

      const { data, error } = await query;

      if (error) {
        console.error('[agent-meeting-templates] Fetch error:', error);
        return res.status(500).json({ error: 'Failed to fetch assignments' });
      }

      return res.json({ assignments: data || [] });
    } catch (err) {
      console.error('[agent-meeting-templates] Error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }

  if (req.method === 'POST') {
    try {
      const { identity_id, meeting_template_id, custom_duration_minutes, is_active } = req.body;

      if (!identity_id || !meeting_template_id) {
        return res.status(400).json({ error: 'identity_id and meeting_template_id are required' });
      }

      const { data: identity } = await supabase
        .from('tenant_identity')
        .select('id')
        .eq('id', identity_id)
        .eq('tenant_id', tenantId)
        .single();

      if (!identity) {
        return res.status(404).json({ error: 'Agent not found in this tenant' });
      }

      const { data: template } = await supabase
        .from('meeting_template')
        .select('id')
        .eq('id', meeting_template_id)
        .eq('tenant_id', tenantId)
        .single();

      if (!template) {
        return res.status(404).json({ error: 'Meeting template not found in this tenant' });
      }

      const { data: existing } = await supabase
        .from('agent_meeting_template')
        .select('id')
        .eq('tenant_id', tenantId)
        .eq('identity_id', identity_id)
        .eq('meeting_template_id', meeting_template_id)
        .single();

      if (existing) {
        return res.status(409).json({ error: 'Assignment already exists' });
      }

      const { data, error } = await supabase
        .from('agent_meeting_template')
        .insert({
          tenant_id: tenantId,
          identity_id,
          meeting_template_id,
          custom_duration_minutes: custom_duration_minutes || null,
          is_active: is_active !== false
        })
        .select(`
          *,
          identity:identity_id(id, email, first_name, last_name, booking_slug),
          template:meeting_template_id(id, name, slug, duration_minutes, meeting_type)
        `)
        .single();

      if (error) {
        console.error('[agent-meeting-templates] Insert error:', error);
        return res.status(500).json({ error: 'Failed to create assignment' });
      }

      return res.status(201).json({ assignment: data });
    } catch (err) {
      console.error('[agent-meeting-templates] Error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }

  if (req.method === 'DELETE') {
    try {
      const { identity_id, meeting_template_id } = req.body;

      if (!identity_id || !meeting_template_id) {
        return res.status(400).json({ error: 'identity_id and meeting_template_id are required' });
      }

      const { error } = await supabase
        .from('agent_meeting_template')
        .delete()
        .eq('tenant_id', tenantId)
        .eq('identity_id', identity_id)
        .eq('meeting_template_id', meeting_template_id);

      if (error) {
        console.error('[agent-meeting-templates] Delete error:', error);
        return res.status(500).json({ error: 'Failed to delete assignment' });
      }

      return res.json({ success: true });
    } catch (err) {
      console.error('[agent-meeting-templates] Error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
