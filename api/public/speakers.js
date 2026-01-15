import { createClient } from '@supabase/supabase-js';

function getTenantSlugFromHost(host) {
  if (!host) return null;
  const hostname = host.split(':')[0];
  const parts = hostname.split('.');
  if (parts.length >= 2) {
    return parts[0];
  }
  return null;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const supabaseUrl = process.env.DEV_SUPABASE_URL || process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.DEV_SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_KEY;

  if (!supabaseUrl || !supabaseServiceKey) {
    return res.status(503).json({ error: 'Supabase not configured' });
  }

  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  try {
    const host = req.headers['x-forwarded-host'] || req.headers.host || '';
    const tenantSlug = req.query.tenant || getTenantSlugFromHost(host);
    const ids = req.query.ids; // Optional: comma-separated list of speaker IDs

    if (!tenantSlug) {
      return res.status(400).json({ error: 'Tenant not specified' });
    }

    const { data: tenant, error: tenantError } = await supabase
      .from('tenant')
      .select('id, name')
      .eq('slug', tenantSlug)
      .eq('status', 'active')
      .single();

    if (tenantError || !tenant) {
      return res.status(404).json({ error: 'Tenant not found' });
    }

    let query = supabase
      .from('speaker')
      .select(`
        id,
        name,
        title,
        bio,
        image_url,
        organization,
        linkedin_url,
        website_url
      `)
      .eq('tenant_id', tenant.id);

    // Filter by specific IDs if provided
    if (ids) {
      const idArray = ids.split(',').map(id => id.trim()).filter(id => id);
      if (idArray.length > 0) {
        query = query.in('id', idArray);
      }
    }

    const { data: speakers, error } = await query.order('name', { ascending: true });

    if (error) {
      console.error('[Public Speakers] Query error:', error);
      return res.status(500).json({ error: 'Failed to fetch speakers' });
    }

    return res.status(200).json(speakers || []);
  } catch (error) {
    console.error('[Public Speakers] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
