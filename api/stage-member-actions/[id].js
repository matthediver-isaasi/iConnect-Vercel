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

  const { id } = req.query;

  if (!id) {
    return res.status(400).json({ error: 'ID is required' });
  }

  try {
    if (req.method === 'GET') {
      const { data, error } = await supabase
        .from('stage_member_action')
        .select('*, role:role_id(id, name), welcome_email_template:welcome_email_template_id(id, name)')
        .eq('id', id)
        .eq('tenant_id', tenantCtx.tenantId)
        .single();
      
      if (error) {
        if (error.code === 'PGRST116') {
          return res.status(404).json({ error: 'Not found' });
        }
        return res.status(500).json({ error: error.message });
      }
      
      return res.json(data);

    } else if (req.method === 'PATCH') {
      const updates = {};
      const allowedFields = [
        'first_name_field', 
        'last_name_field', 
        'email_field', 
        'field_mappings',
        'role_id',
        'welcome_email_template_id',
        'sort_order', 
        'is_active',
        'login_enabled',
        'form_due_diligence_config_id'
      ];
      
      for (const field of allowedFields) {
        if (req.body[field] !== undefined) {
          updates[field] = req.body[field];
        }
      }
      
      if (Object.keys(updates).length === 0) {
        return res.status(400).json({ error: 'No valid fields to update' });
      }
      
      const { data, error } = await supabase
        .from('stage_member_action')
        .update(updates)
        .eq('id', id)
        .eq('tenant_id', tenantCtx.tenantId)
        .select('*, role:role_id(id, name), welcome_email_template:welcome_email_template_id(id, name)')
        .single();
      
      if (error) {
        if (error.code === 'PGRST116') {
          return res.status(404).json({ error: 'Not found' });
        }
        return res.status(500).json({ error: error.message });
      }
      
      return res.json(data);

    } else if (req.method === 'DELETE') {
      const { error } = await supabase
        .from('stage_member_action')
        .delete()
        .eq('id', id)
        .eq('tenant_id', tenantCtx.tenantId);
      
      if (error) {
        return res.status(500).json({ error: error.message });
      }
      
      return res.status(204).end();

    } else {
      return res.status(405).json({ error: 'Method not allowed' });
    }
  } catch (error) {
    console.error('[stage-member-actions] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
