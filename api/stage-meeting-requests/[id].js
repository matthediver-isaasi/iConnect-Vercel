import { createClient } from '@supabase/supabase-js';
import { getSessionTenantUser } from '../_lib/session.js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

export default async function handler(req, res) {
  const tenantUser = await getSessionTenantUser(req);
  if (!tenantUser) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const supabase = createClient(supabaseUrl, supabaseServiceKey);
  const tenantId = tenantUser._sessionTenantId || tenantUser.tenant_id;
  const { id } = req.query;

  if (!tenantId || tenantId === 'undefined') {
    console.error('[stage-meeting-requests] Invalid tenantId:', tenantId);
    return res.status(400).json({ error: 'Invalid tenant context' });
  }

  if (!id) {
    return res.status(400).json({ error: 'Meeting request ID is required' });
  }

  if (req.method === 'GET') {
    try {
      const { data, error } = await supabase
        .from('stage_meeting_request')
        .select(`
          *,
          meeting_template:meeting_template_id (
            id, name, slug, duration_minutes, meeting_type, email_template_id
          )
        `)
        .eq('id', id)
        .eq('tenant_id', tenantId)
        .single();

      if (error || !data) {
        return res.status(404).json({ error: 'Meeting request not found' });
      }

      return res.json({ meeting_request: data });
    } catch (err) {
      console.error('[stage-meeting-requests/id] Error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }

  if (req.method === 'PUT' || req.method === 'PATCH') {
    try {
      const { 
        meeting_template_id, 
        recipient_email_field, 
        first_name_field,
        sort_order,
        is_active 
      } = req.body;

      const updates = {};
      if (meeting_template_id !== undefined) updates.meeting_template_id = meeting_template_id;
      if (recipient_email_field !== undefined) updates.recipient_email_field = recipient_email_field;
      if (first_name_field !== undefined) updates.first_name_field = first_name_field || null;
      if (sort_order !== undefined) updates.sort_order = sort_order;
      if (is_active !== undefined) updates.is_active = is_active;

      const { data, error } = await supabase
        .from('stage_meeting_request')
        .update(updates)
        .eq('id', id)
        .eq('tenant_id', tenantId)
        .select(`
          *,
          meeting_template:meeting_template_id (
            id, name, slug, duration_minutes, meeting_type, email_template_id
          )
        `)
        .single();

      if (error) {
        console.error('[stage-meeting-requests/id] Update error:', error);
        return res.status(500).json({ error: 'Failed to update meeting request' });
      }

      if (!data) {
        return res.status(404).json({ error: 'Meeting request not found' });
      }

      return res.json({ meeting_request: data });
    } catch (err) {
      console.error('[stage-meeting-requests/id] Error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }

  if (req.method === 'DELETE') {
    try {
      const { error } = await supabase
        .from('stage_meeting_request')
        .delete()
        .eq('id', id)
        .eq('tenant_id', tenantId);

      if (error) {
        console.error('[stage-meeting-requests/id] Delete error:', error);
        return res.status(500).json({ error: 'Failed to delete meeting request' });
      }

      return res.json({ success: true });
    } catch (err) {
      console.error('[stage-meeting-requests/id] Error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
