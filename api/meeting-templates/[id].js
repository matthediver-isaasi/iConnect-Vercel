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
    console.error('[meeting-templates] Invalid tenantId:', tenantId);
    return res.status(400).json({ error: 'Invalid tenant context' });
  }

  if (!id) {
    return res.status(400).json({ error: 'Template ID is required' });
  }

  if (req.method === 'GET') {
    try {
      const { data, error } = await supabase
        .from('meeting_template')
        .select('*')
        .eq('id', id)
        .eq('tenant_id', tenantId)
        .single();

      if (error || !data) {
        return res.status(404).json({ error: 'Meeting template not found' });
      }

      return res.json({ template: data });
    } catch (err) {
      console.error('[meeting-templates/id] Error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }

  if (req.method === 'PUT' || req.method === 'PATCH') {
    try {
      const { name, description, duration_minutes, meeting_type, is_active, buffer_before_minutes, buffer_after_minutes, sort_order, email_template_id } = req.body;

      const updates = {};
      if (name !== undefined) {
        updates.name = name;
        updates.slug = name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-+|-+$/g, '');
      }
      if (description !== undefined) updates.description = description;
      if (duration_minutes !== undefined) updates.duration_minutes = duration_minutes;
      if (meeting_type !== undefined) updates.meeting_type = meeting_type;
      if (is_active !== undefined) updates.is_active = is_active;
      if (buffer_before_minutes !== undefined) updates.buffer_before_minutes = buffer_before_minutes;
      if (buffer_after_minutes !== undefined) updates.buffer_after_minutes = buffer_after_minutes;
      if (sort_order !== undefined) updates.sort_order = sort_order;
      if (email_template_id !== undefined) updates.email_template_id = email_template_id || null;

      const { data, error } = await supabase
        .from('meeting_template')
        .update(updates)
        .eq('id', id)
        .eq('tenant_id', tenantId)
        .select()
        .single();

      if (error) {
        console.error('[meeting-templates/id] Update error:', error);
        return res.status(500).json({ error: 'Failed to update meeting template' });
      }

      if (!data) {
        return res.status(404).json({ error: 'Meeting template not found' });
      }

      return res.json({ template: data });
    } catch (err) {
      console.error('[meeting-templates/id] Error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }

  if (req.method === 'DELETE') {
    try {
      const { error } = await supabase
        .from('meeting_template')
        .delete()
        .eq('id', id)
        .eq('tenant_id', tenantId);

      if (error) {
        console.error('[meeting-templates/id] Delete error:', error);
        return res.status(500).json({ error: 'Failed to delete meeting template' });
      }

      return res.json({ success: true });
    } catch (err) {
      console.error('[meeting-templates/id] Error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
