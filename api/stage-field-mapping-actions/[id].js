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
        .from('stage_field_mapping_action')
        .select('*')
        .eq('id', id)
        .eq('tenant_id', tenantId)
        .single();

      if (error) {
        if (error.code === 'PGRST116') {
          return res.status(404).json({ error: 'Field mapping action not found' });
        }
        console.error('[stage-field-mapping-actions] Fetch error:', error);
        return res.status(500).json({ error: 'Failed to fetch field mapping action' });
      }

      return res.json({ field_mapping_action: data });
    } catch (err) {
      console.error('[stage-field-mapping-actions] Error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }

  if (req.method === 'PUT') {
    try {
      const { 
        field_mappings,
        sort_order,
        is_active 
      } = req.body;

      const updateData = {};
      
      // Valid core fields for organization
      const VALID_CORE_FIELDS = ['name', 'email', 'phone', 'website', 'address', 'description'];
      
      if (field_mappings !== undefined) {
        if (!Array.isArray(field_mappings) || field_mappings.length === 0) {
          return res.status(400).json({ error: 'At least one field mapping is required' });
        }
        
        // Validate each mapping
        for (const mapping of field_mappings) {
          if (!mapping.source_field_id) {
            return res.status(400).json({ error: 'Each mapping requires a source_field_id' });
          }
          if (!mapping.target_type || !['core', 'custom'].includes(mapping.target_type)) {
            return res.status(400).json({ error: 'Each mapping requires target_type of "core" or "custom"' });
          }
          if (!mapping.target_field) {
            return res.status(400).json({ error: 'Each mapping requires a target_field' });
          }
          // Validate core fields against allowlist
          if (mapping.target_type === 'core' && !VALID_CORE_FIELDS.includes(mapping.target_field)) {
            return res.status(400).json({ error: `Invalid core field: ${mapping.target_field}. Valid options: ${VALID_CORE_FIELDS.join(', ')}` });
          }
        }
        
        updateData.field_mappings = field_mappings;
      }
      
      if (sort_order !== undefined) updateData.sort_order = sort_order;
      if (is_active !== undefined) updateData.is_active = is_active;

      const { data, error } = await supabase
        .from('stage_field_mapping_action')
        .update(updateData)
        .eq('id', id)
        .eq('tenant_id', tenantId)
        .select()
        .single();

      if (error) {
        console.error('[stage-field-mapping-actions] Update error:', error);
        return res.status(500).json({ error: 'Failed to update field mapping action' });
      }

      return res.json({ field_mapping_action: data });
    } catch (err) {
      console.error('[stage-field-mapping-actions] Error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }

  if (req.method === 'DELETE') {
    try {
      const { error } = await supabase
        .from('stage_field_mapping_action')
        .delete()
        .eq('id', id)
        .eq('tenant_id', tenantId);

      if (error) {
        console.error('[stage-field-mapping-actions] Delete error:', error);
        return res.status(500).json({ error: 'Failed to delete field mapping action' });
      }

      return res.json({ success: true });
    } catch (err) {
      console.error('[stage-field-mapping-actions] Error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
