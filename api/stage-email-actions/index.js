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

  if (!tenantId || tenantId === 'undefined') {
    console.error('[stage-email-actions] Invalid tenantId:', tenantId);
    return res.status(400).json({ error: 'Invalid tenant context' });
  }

  if (req.method === 'GET') {
    try {
      const { stageId } = req.query;
      
      let query = supabase
        .from('stage_email_action')
        .select(`
          *,
          email_template:email_template_id (
            id, name, subject, from_email
          )
        `)
        .eq('tenant_id', tenantId)
        .order('sort_order', { ascending: true });

      if (stageId && stageId !== 'undefined') {
        query = query.eq('due_diligence_stage_id', stageId);
      }

      const { data, error } = await query;

      if (error) {
        console.error('[stage-email-actions] Fetch error:', error);
        return res.status(500).json({ error: 'Failed to fetch email actions' });
      }

      return res.json({ email_actions: data || [] });
    } catch (err) {
      console.error('[stage-email-actions] Error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }

  if (req.method === 'POST') {
    try {
      const { 
        due_diligence_stage_id, 
        email_template_id, 
        recipient_email_field, 
        recipient_name_field,
        cc_emails,
        sort_order,
        is_active 
      } = req.body;

      if (!due_diligence_stage_id) {
        return res.status(400).json({ error: 'Stage ID is required' });
      }
      if (!email_template_id) {
        return res.status(400).json({ error: 'Email template ID is required' });
      }
      if (!recipient_email_field) {
        return res.status(400).json({ error: 'Recipient email field is required' });
      }

      const { data, error } = await supabase
        .from('stage_email_action')
        .insert({
          tenant_id: tenantId,
          due_diligence_stage_id,
          email_template_id,
          recipient_email_field,
          recipient_name_field: recipient_name_field || null,
          cc_emails: cc_emails || null,
          sort_order: sort_order || 0,
          is_active: is_active !== false
        })
        .select(`
          *,
          email_template:email_template_id (
            id, name, subject, from_email
          )
        `)
        .single();

      if (error) {
        console.error('[stage-email-actions] Insert error:', error);
        return res.status(500).json({ error: 'Failed to create email action' });
      }

      return res.status(201).json({ email_action: data });
    } catch (err) {
      console.error('[stage-email-actions] Error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
