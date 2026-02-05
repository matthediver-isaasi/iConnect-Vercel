import { supabase } from '../_lib/database.js';
import { getTenantContext, hasAdminAccess, hasFeatureAccess } from '../_lib/tenantContext.js';

export default async function handler(req, res) {
  try {
    const context = await getTenantContext(req);
    
    if (!context.isAuthenticated) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    
    // Check for admin access (tenant user) or specific feature access (member with permission)
    const isAdmin = await hasAdminAccess(context);
    const hasFeature = context.roleId ? await hasFeatureAccess(context.roleId, 'forms.due-diligence-config') : false;
    
    if (!isAdmin && !hasFeature) {
      return res.status(403).json({ error: 'Access denied - requires due diligence config permission' });
    }
    
    const tenantId = context.tenantId;
    
    if (req.method === 'GET') {
      const { stage_id, form_id } = req.query;
      
      let query = supabase
        .from('stage_zoho_crm_action')
        .select('*')
        .eq('tenant_id', tenantId)
        .order('sort_order', { ascending: true });
      
      if (stage_id) {
        query = query.eq('due_diligence_stage_id', stage_id);
      }
      
      if (form_id) {
        query = query.eq('form_id', form_id);
      }
      
      const { data: actions, error } = await query;
      
      if (error) {
        console.error('[Stage Zoho CRM Actions] Error fetching:', error);
        return res.status(500).json({ error: 'Failed to fetch Zoho CRM actions' });
      }
      
      return res.status(200).json({ actions: actions || [] });
    }
    
    if (req.method === 'POST') {
      const { 
        due_diligence_stage_id,
        form_id,
        is_active = true,
        sort_order = 0,
        field_mappings = {}
      } = req.body;
      
      if (!due_diligence_stage_id) {
        return res.status(400).json({ error: 'due_diligence_stage_id is required' });
      }
      
      const { data: action, error } = await supabase
        .from('stage_zoho_crm_action')
        .insert({
          tenant_id: tenantId,
          due_diligence_stage_id,
          form_id,
          is_active,
          sort_order,
          field_mappings,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        })
        .select()
        .single();
      
      if (error) {
        console.error('[Stage Zoho CRM Actions] Error creating:', error);
        return res.status(500).json({ error: 'Failed to create Zoho CRM action' });
      }
      
      return res.status(201).json({ action });
    }
    
    return res.status(405).json({ error: 'Method not allowed' });
    
  } catch (error) {
    console.error('[Stage Zoho CRM Actions] Error:', error);
    return res.status(500).json({ error: error.message });
  }
}
