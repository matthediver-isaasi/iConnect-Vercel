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
  const { id } = req.query;

  if (!tenantId || tenantId === 'undefined') {
    return res.status(400).json({ error: 'Invalid tenant context' });
  }

  const supabase = createClient(supabaseUrl, supabaseServiceKey);

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
      const VALID_CORE_FIELDS = ['name', 'email', 'phone', 'website', 'description'];
      // Composite core fields (stored as JSONB with sub-fields)
      const COMPOSITE_CORE_FIELDS = {
        address: ['line1', 'line2', 'city', 'region', 'postcode', 'country']
      };
      
      // Helper to validate core field (including composite sub-fields like "address.line1")
      const isValidCoreField = (fieldName) => {
        if (VALID_CORE_FIELDS.includes(fieldName)) return true;
        if (fieldName.includes('.')) {
          const [parent, subField] = fieldName.split('.');
          if (COMPOSITE_CORE_FIELDS[parent] && COMPOSITE_CORE_FIELDS[parent].includes(subField)) {
            return true;
          }
        }
        return false;
      };
      
      if (field_mappings !== undefined) {
        if (!Array.isArray(field_mappings) || field_mappings.length === 0) {
          return res.status(400).json({ error: 'At least one field mapping is required' });
        }
        
        // Validate each mapping
        for (const mapping of field_mappings) {
          // For static mappings, require static_value; for field mappings, require source_field_id
          const isStaticMapping = mapping.source_type === 'static';
          if (isStaticMapping) {
            if (!mapping.static_value && mapping.static_value !== 0 && mapping.static_value !== false) {
              return res.status(400).json({ error: 'Static mappings require a static_value' });
            }
          } else {
            if (!mapping.source_field_id) {
              return res.status(400).json({ error: 'Field mappings require a source_field_id' });
            }
          }
          if (!mapping.target_type || !['core', 'custom'].includes(mapping.target_type)) {
            return res.status(400).json({ error: 'Each mapping requires target_type of "core" or "custom"' });
          }
          if (!mapping.target_field) {
            return res.status(400).json({ error: 'Each mapping requires a target_field' });
          }
          // Validate core fields against allowlist
          if (mapping.target_type === 'core' && !isValidCoreField(mapping.target_field)) {
            const allValidFields = [...VALID_CORE_FIELDS, ...Object.keys(COMPOSITE_CORE_FIELDS).flatMap(k => COMPOSITE_CORE_FIELDS[k].map(sf => `${k}.${sf}`))];
            return res.status(400).json({ error: `Invalid core field: ${mapping.target_field}. Valid options: ${allValidFields.join(', ')}` });
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
