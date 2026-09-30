import { createClient } from '@supabase/supabase-js';
import { resolveTenantFromRequest } from '../_lib/tenantResolver.js';

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
    
    if (!tenantId) {
      return res.status(400).json({ error: 'Invalid tenant context' });
    }

    const { data, error } = await supabase
      .from('resource_author_settings')
      .select('hide_empty_subcategories, enabled_social_icons')
      .eq('tenant_id', tenantId)
      .limit(1)
      .single();

    if (error && error.code !== 'PGRST116') {
      console.error('Error fetching resource author settings:', error);
      return res.status(500).json({ error: error.message });
    }

    // Return defaults if no settings found
    return res.json(data || {
      hide_empty_subcategories: false,
      enabled_social_icons: ['x', 'linkedin', 'email']
    });
  } catch (error) {
    console.error('Public resource author settings fetch error:', error);
    return res.status(500).json({ error: 'Failed to fetch resource author settings' });
  }
}
