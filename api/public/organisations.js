import { createClient } from '@supabase/supabase-js';
import { resolveTenantFromRequest } from './_lib/tenantResolver.js';

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

  try {
    const { tenant: tenantParam } = req.query;
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

    const { data, error } = await supabase
      .from('organization')
      .select('id, name, logo_url')
      .eq('tenant_id', tenantId)
      .order('name', { ascending: true });

    if (error) {
      console.error('Error fetching organisations:', error);
      return res.status(500).json({ error: error.message });
    }

    return res.json(data || []);
  } catch (error) {
    console.error('Public organisations fetch error:', error);
    return res.status(500).json({ error: 'Failed to fetch organisations' });
  }
}
