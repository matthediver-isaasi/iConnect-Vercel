import { supabase } from '../_lib/database.js';
import { getTenantContext } from '../_lib/tenantContext.js';
import { getSessionTenantUser } from '../_lib/session.js';

export default async function handler(req, res) {
  try {
    const context = await getTenantContext(req);
    
    if (!context.isAuthenticated) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    
    const tenantUser = await getSessionTenantUser(req);
    if (!tenantUser) {
      return res.status(403).json({ error: 'Admin access required' });
    }
    
    const tenantId = context.tenantId;
    const { id } = req.query;
    
    if (!id) {
      return res.status(400).json({ error: 'Action ID is required' });
    }
    
    // Verify the action belongs to this tenant
    const { data: existing, error: fetchError } = await supabase
      .from('stage_zoho_crm_action')
      .select('*')
      .eq('id', id)
      .eq('tenant_id', tenantId)
      .single();
    
    if (fetchError || !existing) {
      return res.status(404).json({ error: 'Zoho CRM action not found' });
    }
    
    if (req.method === 'GET') {
      return res.status(200).json({ action: existing });
    }
    
    if (req.method === 'PUT' || req.method === 'PATCH') {
      const { 
        is_active,
        sort_order,
        field_mappings,
        form_id
      } = req.body;
      
      const updateData = {
        updated_at: new Date().toISOString()
      };
      
      if (is_active !== undefined) updateData.is_active = is_active;
      if (sort_order !== undefined) updateData.sort_order = sort_order;
      if (field_mappings !== undefined) updateData.field_mappings = field_mappings;
      if (form_id !== undefined) updateData.form_id = form_id;
      
      const { data: updated, error: updateError } = await supabase
        .from('stage_zoho_crm_action')
        .update(updateData)
        .eq('id', id)
        .eq('tenant_id', tenantId)
        .select()
        .single();
      
      if (updateError) {
        console.error('[Stage Zoho CRM Actions] Error updating:', updateError);
        return res.status(500).json({ error: 'Failed to update Zoho CRM action' });
      }
      
      return res.status(200).json({ action: updated });
    }
    
    if (req.method === 'DELETE') {
      const { error: deleteError } = await supabase
        .from('stage_zoho_crm_action')
        .delete()
        .eq('id', id)
        .eq('tenant_id', tenantId);
      
      if (deleteError) {
        console.error('[Stage Zoho CRM Actions] Error deleting:', deleteError);
        return res.status(500).json({ error: 'Failed to delete Zoho CRM action' });
      }
      
      return res.status(200).json({ success: true });
    }
    
    return res.status(405).json({ error: 'Method not allowed' });
    
  } catch (error) {
    console.error('[Stage Zoho CRM Actions] Error:', error);
    return res.status(500).json({ error: error.message });
  }
}
