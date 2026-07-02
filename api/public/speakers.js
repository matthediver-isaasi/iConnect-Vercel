import { createClient } from '@supabase/supabase-js';
import { resolveTenantFromRequest } from '../_lib/tenantResolver.js';

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

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

  if (!supabaseUrl || !supabaseServiceKey) {
    return res.status(503).json({ error: 'Supabase not configured' });
  }

  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  try {
    const ids = req.query.ids; // Optional: comma-separated list of speaker IDs
    const tenant = await resolveTenantFromRequest(req);

    if (!tenant) {
      return res.status(404).json({ error: 'Tenant not found' });
    }

    let query = supabase
      .from('speaker')
      .select(`
        id,
        full_name,
        job_title,
        biography,
        profile_photo_url,
        organization
      `)
      .eq('tenant_id', tenant.id)
      .eq('is_active', true);

    // Filter by specific IDs if provided - tenant_id filter above ensures multi-tenant safety
    if (ids) {
      const idArray = ids.split(',').map(id => id.trim()).filter(id => id);
      if (idArray.length > 0) {
        query = query.in('id', idArray);
      }
    }

    const { data: speakers, error } = await query.order('full_name', { ascending: true });

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
