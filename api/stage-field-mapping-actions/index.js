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
    console.error('[stage-field-mapping-actions] Invalid tenantId:', tenantId);
    return res.status(400).json({ error: 'Invalid tenant context' });
  }

  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  if (req.method === 'GET') {
    try {
      const { stageId } = req.query;
      
      let query = supabase
        .from('stage_field_mapping_action')
        .select('*')
        .eq('tenant_id', tenantId)
        .order('sort_order', { ascending: true });

      if (stageId && stageId !== 'undefined') {
        query = query.eq('due_diligence_stage_id', stageId);
      }

      const { data, error } = await query;

      if (error) {
        console.error('[stage-field-mapping-actions] Fetch error:', error);
        return res.status(500).json({ error: 'Failed to fetch field mapping actions' });
      }

      return res.json({ field_mapping_actions: data || [] });
    } catch (err) {
      console.error('[stage-field-mapping-actions] Error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }

  if (req.method === 'POST') {
    try {
      const { 
        due_diligence_stage_id, 
        field_mappings,
        sort_order,
        is_active 
      } = req.body;

      if (!due_diligence_stage_id) {
        return res.status(400).json({ error: 'Stage ID is required' });
      }
      if (!field_mappings || !Array.isArray(field_mappings) || field_mappings.length === 0) {
        return res.status(400).json({ error: 'At least one field mapping is required' });
      }

      // Valid core fields for organization
      const VALID_CORE_FIELDS = ['name', 'email', 'phone', 'website', 'address', 'description'];
      
      // Validate each mapping has required fields
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

      const { data, error } = await supabase
        .from('stage_field_mapping_action')
        .insert({
          tenant_id: tenantId,
          due_diligence_stage_id,
          field_mappings,
          sort_order: sort_order || 0,
          is_active: is_active !== false
        })
        .select()
        .single();

      if (error) {
        console.error('[stage-field-mapping-actions] Insert error:', error);
        return res.status(500).json({ error: 'Failed to create field mapping action' });
      }

      return res.status(201).json({ field_mapping_action: data });
    } catch (err) {
      console.error('[stage-field-mapping-actions] Error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
