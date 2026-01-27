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
    return res.status(400).json({ error: 'Invalid tenant context' });
  }

  if (!id) {
    return res.status(400).json({ error: 'ID is required' });
  }

  if (req.method === 'GET') {
    try {
      const { data, error } = await supabase
        .from('stage_email_action')
        .select(`
          *,
          email_template:email_template_id (
            id, name, subject, from_email
          )
        `)
        .eq('id', id)
        .eq('tenant_id', tenantId)
        .single();

      if (error) {
        if (error.code === 'PGRST116') {
          return res.status(404).json({ error: 'Email action not found' });
        }
        console.error('[stage-email-actions] Fetch error:', error);
        return res.status(500).json({ error: 'Failed to fetch email action' });
      }

      return res.json({ email_action: data });
    } catch (err) {
      console.error('[stage-email-actions] Error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }

  if (req.method === 'PUT') {
    try {
      const { 
        email_template_id, 
        recipient_email_field, 
        recipient_name_field,
        cc_emails,
        prompt_custom_message,
        sort_order,
        is_active,
        form_id
      } = req.body;

      const updateData = {};
      if (email_template_id !== undefined) updateData.email_template_id = email_template_id;
      if (recipient_email_field !== undefined) updateData.recipient_email_field = recipient_email_field;
      if (recipient_name_field !== undefined) updateData.recipient_name_field = recipient_name_field || null;
      if (cc_emails !== undefined) updateData.cc_emails = cc_emails || null;
      if (prompt_custom_message !== undefined) updateData.prompt_custom_message = prompt_custom_message || false;
      if (sort_order !== undefined) updateData.sort_order = sort_order;
      if (is_active !== undefined) updateData.is_active = is_active;
      if (form_id !== undefined) updateData.form_id = form_id || null;

      const { data, error } = await supabase
        .from('stage_email_action')
        .update(updateData)
        .eq('id', id)
        .eq('tenant_id', tenantId)
        .select(`
          *,
          email_template:email_template_id (
            id, name, subject, from_email
          )
        `)
        .single();

      if (error) {
        console.error('[stage-email-actions] Update error:', error);
        return res.status(500).json({ error: 'Failed to update email action' });
      }

      return res.json({ email_action: data });
    } catch (err) {
      console.error('[stage-email-actions] Error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }

  if (req.method === 'DELETE') {
    try {
      const { error } = await supabase
        .from('stage_email_action')
        .delete()
        .eq('id', id)
        .eq('tenant_id', tenantId);

      if (error) {
        console.error('[stage-email-actions] Delete error:', error);
        return res.status(500).json({ error: 'Failed to delete email action' });
      }

      return res.json({ success: true });
    } catch (err) {
      console.error('[stage-email-actions] Error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
