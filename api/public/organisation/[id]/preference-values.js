import { createClient } from '@supabase/supabase-js';
import { resolveTenantFromRequest } from '../../../_lib/tenantResolver.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { id, tenant: tenantParam } = req.query;

  if (!id) {
    return res.status(400).json({ error: 'Organisation ID is required' });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

  if (!supabaseUrl || !supabaseServiceKey) {
    return res.status(503).json({ error: 'Supabase not configured' });
  }

  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  try {
    let tenantId = null;
    
    // First try: centralized tenant resolver (subdomain and custom domain)
    const tenant = await resolveTenantFromRequest(req);
    if (tenant) {
      tenantId = tenant.id;
    }
    
    // Second try: explicit tenant query parameter (for local dev, embedded forms, etc.)
    if (!tenantId && tenantParam) {
      // Try slug first
      let { data: tenantBySlug } = await supabase
        .from('tenant')
        .select('id')
        .eq('slug', tenantParam)
        .eq('status', 'active')
        .single();
      
      if (tenantBySlug) {
        tenantId = tenantBySlug.id;
      } else {
        // Fallback to subdomain field for legacy tenants
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
    
    if (!tenantId) {
      return res.status(400).json({ error: 'Invalid tenant context' });
    }

    // Verify organisation exists AND belongs to the current tenant
    const { data: org, error: orgError } = await supabase
      .from('organization')
      .select('id, tenant_id')
      .eq('id', id)
      .single();

    if (orgError || !org) {
      return res.status(404).json({ error: 'Organisation not found' });
    }

    // Enforce tenant isolation - org must belong to requesting tenant
    if (org.tenant_id && org.tenant_id !== tenantId) {
      return res.status(404).json({ error: 'Organisation not found' });
    }

    // Fetch all custom field values for this organization
    console.log('[preference-values API] Fetching values for organization:', id);
    const { data: values, error: valuesError } = await supabase
      .from('organization_preference_value')
      .select('id, organization_id, field_id, value')
      .eq('organization_id', id);

    if (valuesError) {
      console.error('Error fetching organization preference values:', valuesError);
      return res.status(500).json({ error: valuesError.message });
    }

    console.log('[preference-values API] Found values:', values?.length || 0, JSON.stringify(values));
    return res.json(values || []);
  } catch (error) {
    console.error('Public organization preference values fetch error:', error);
    return res.status(500).json({ error: 'Failed to fetch organization preference values' });
  }
}
