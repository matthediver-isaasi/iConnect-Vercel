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
    // Resolve tenant for isolation (same pattern as other public endpoints)
    let tenantId = null;
    
    // First try: centralized tenant resolver (subdomain and custom domain)
    const tenant = await resolveTenantFromRequest(req);
    if (tenant) {
      tenantId = tenant.id;
    }
    
    // Second try: explicit tenant query parameter (for local dev, embedded forms)
    if (!tenantId && tenantParam) {
      let { data: tenantBySlug } = await supabase
        .from('tenant')
        .select('id')
        .eq('slug', tenantParam)
        .eq('status', 'active')
        .single();
      
      if (tenantBySlug) {
        tenantId = tenantBySlug.id;
      } else {
        const { data: tenantBySubdomain } = await supabase
          .from('tenant')
          .select('id')
          .eq('subdomain', tenantParam)
          .eq('status', 'active')
          .single();
        
        if (tenantBySubdomain) {
          tenantId = tenantBySubdomain.id;
        }
      }
    }
    
    // Build query with tenant isolation when possible
    let query = supabase
      .from('preference_field')
      .select('id, label, field_type, options, entity_scope, min_selections, max_selections')
      .eq('id', id)
      .eq('is_active', true);
    
    // Add tenant filter if we have tenant context (preferred for security)
    // If no tenant context, allow lookup (backward compatibility for legacy embeds)
    if (tenantId) {
      query = query.eq('tenant_id', tenantId);
    } else {
      console.warn('[Public Custom Field] No tenant context - falling back to global lookup for field:', id);
    }
    
    const { data, error } = await query.single();

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
