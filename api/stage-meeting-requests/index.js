import { createClient } from '@supabase/supabase-js';
import { getTenantContext } from '../_lib/tenantContext.js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

export default async function handler(req, res) {
  const tenantCtx = await getTenantContext(req);
  if (!tenantCtx.isAuthenticated) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const tenantId = tenantCtx.tenantId;
  if (!tenantId || tenantId === 'undefined') {
    console.error('[stage-meeting-requests] Invalid tenantId:', tenantId);
    return res.status(400).json({ error: 'Invalid tenant context' });
  }

  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  if (req.method === 'GET') {
    try {
      const { stageId } = req.query;
      
      let query = supabase
        .from('stage_meeting_request')
        .select(`
          *,
          meeting_template:meeting_template_id (
            id, name, slug, duration_minutes, meeting_type, email_template_id
          )
        `)
        .eq('tenant_id', tenantId)
        .order('sort_order', { ascending: true });

      if (stageId && stageId !== 'undefined') {
        query = query.eq('due_diligence_stage_id', stageId);
      }

      const { data, error } = await query;

      if (error) {
        console.error('[stage-meeting-requests] Fetch error:', error);
        return res.status(500).json({ error: 'Failed to fetch meeting requests' });
      }

      return res.json({ meeting_requests: data || [] });
    } catch (err) {
      console.error('[stage-meeting-requests] Error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }

  if (req.method === 'POST') {
    try {
      const { 
        due_diligence_stage_id, 
        meeting_template_id, 
        recipient_email_field, 
        first_name_field,
        sort_order,
        is_active 
      } = req.body;

      if (!due_diligence_stage_id) {
        return res.status(400).json({ error: 'Stage ID is required' });
      }
      if (!meeting_template_id) {
        return res.status(400).json({ error: 'Meeting template ID is required' });
      }
      if (!recipient_email_field) {
        return res.status(400).json({ error: 'Recipient email field is required' });
      }

      const { data, error } = await supabase
        .from('stage_meeting_request')
        .insert({
          tenant_id: tenantId,
          due_diligence_stage_id,
          meeting_template_id,
          recipient_email_field,
          first_name_field: first_name_field || null,
          sort_order: sort_order || 0,
          is_active: is_active !== false
        })
        .select(`
          *,
          meeting_template:meeting_template_id (
            id, name, slug, duration_minutes, meeting_type, email_template_id
          )
        `)
        .single();

      if (error) {
        console.error('[stage-meeting-requests] Insert error:', error);
        return res.status(500).json({ error: 'Failed to create meeting request' });
      }

      return res.status(201).json({ meeting_request: data });
    } catch (err) {
      console.error('[stage-meeting-requests] Error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
