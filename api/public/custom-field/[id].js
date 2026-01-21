import { createClient } from '@supabase/supabase-js';
import { resolveTenantFromRequest } from '../../_lib/tenantResolver.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

  if (!supabaseUrl || !supabaseServiceKey) {
    return res.status(503).json({ error: 'Supabase not configured' });
  }

  const supabase = createClient(supabaseUrl, supabaseServiceKey);
  const { id, tenant: tenantParam } = req.query;

  try {
    // Resolve tenant for proper data isolation
    let tenantId = null;
    
    // First try: centralized tenant resolver (subdomain and custom domain)
    const tenant = await resolveTenantFromRequest(req);
    if (tenant) {
      tenantId = tenant.id;
    }
    
    // Second try: explicit tenant query parameter (for embedded forms, local dev)
    if (!tenantId && tenantParam) {
      const { data: tenantBySlug } = await supabase
        .from('tenant')
        .select('id')
        .eq('slug', tenantParam)
        .eq('status', 'active')
        .single();
      
      if (tenantBySlug) {
        tenantId = tenantBySlug.id;
      }
    }
    
    // Tenant context is required for proper data isolation
    if (!tenantId) {
      console.error('[Public Custom Field] Missing tenant context for field:', id);
      return res.status(400).json({ error: 'Tenant context required' });
    }

    // PreferenceField is now TENANT-scoped (tenant_id column added via migration)
    const { data, error } = await supabase
      .from('preference_field')
      .select('id, label, field_type, options, entity_scope, min_selections, max_selections, allowed_file_types')
      .eq('id', id)
      .eq('tenant_id', tenantId)
      .eq('is_active', true)
      .single();

    if (error) {
      console.error('Error fetching custom field:', error);
      return res.status(404).json({ error: 'Custom field not found' });
    }

    return res.json(data);
  } catch (error) {
    console.error('Public custom field fetch error:', error);
    return res.status(500).json({ error: 'Failed to fetch custom field' });
  }
}
