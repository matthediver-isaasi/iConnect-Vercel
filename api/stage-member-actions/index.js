import { createClient } from '@supabase/supabase-js';
import { getTenantContext } from '../_lib/tenantContext.js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

const supabase = supabaseUrl && supabaseServiceKey 
  ? createClient(supabaseUrl, supabaseServiceKey)
  : null;

export default async function handler(req, res) {
  if (!supabase) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  const tenantCtx = await getTenantContext(req);
  if (!tenantCtx.isAuthenticated || !tenantCtx.tenantId) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  try {
    if (req.method === 'GET') {
      const { stage_id } = req.query;
      
      let query = supabase
        .from('stage_member_action')
        .select('*, role:role_id(id, name), welcome_email_template:welcome_email_template_id(id, name)')
        .eq('tenant_id', tenantCtx.tenantId)
        .order('sort_order', { ascending: true });
      
      if (stage_id) {
        query = query.eq('due_diligence_stage_id', stage_id);
      }
      
      const { data, error } = await query;
      
      if (error) {
        console.error('[stage-member-actions] List error:', error);
        return res.status(500).json({ error: error.message });
      }
      
      return res.json(data || []);

    } else if (req.method === 'POST') {
      const { 
        due_diligence_stage_id, 
        first_name_field,
        last_name_field,
        email_field,
        field_mappings,
        role_id,
        welcome_email_template_id,
        sort_order 
      } = req.body;
      
      if (!due_diligence_stage_id) {
        return res.status(400).json({ error: 'due_diligence_stage_id is required' });
      }
      
      if (!first_name_field || !last_name_field || !email_field) {
        return res.status(400).json({ error: 'first_name_field, last_name_field, and email_field are required' });
      }
      
      const insertData = {
        tenant_id: tenantCtx.tenantId,
        due_diligence_stage_id,
        first_name_field,
        last_name_field,
        email_field,
        field_mappings: field_mappings || { core: {}, custom: {} },
        role_id: role_id || null,
        welcome_email_template_id: welcome_email_template_id || null,
        sort_order: sort_order || 0,
        is_active: true
      };
      
      const { data, error } = await supabase
        .from('stage_member_action')
        .insert(insertData)
        .select('*, role:role_id(id, name), welcome_email_template:welcome_email_template_id(id, name)')
        .single();
      
      if (error) {
        console.error('[stage-member-actions] Insert error:', error);
        return res.status(500).json({ error: error.message });
      }
      
      return res.status(201).json(data);

    } else {
      return res.status(405).json({ error: 'Method not allowed' });
    }
  } catch (error) {
    console.error('[stage-member-actions] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
