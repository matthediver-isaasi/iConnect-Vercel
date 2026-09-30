import { createClient } from '@supabase/supabase-js';
import { resolveTenantFromRequest } from '../_lib/tenantResolver.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY;

  if (!supabaseUrl || !supabaseServiceKey) {
    return res.status(500).json({ error: 'Server configuration error' });
  }

  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  try {
    const { slug, excludeEventId } = req.query;

    if (!slug) {
      return res.status(400).json({ error: 'Slug is required' });
    }

    const normalizedSlug = slug.toLowerCase().trim();

    const tenant = await resolveTenantFromRequest(req);

    if (!tenant) {
      return res.status(404).json({ error: 'Tenant not found' });
    }

    let query = supabase
      .from('event')
      .select('id')
      .eq('tenant_id', tenant.id)
      .eq('slug', normalizedSlug);

    if (excludeEventId) {
      query = query.neq('id', excludeEventId);
    }

    const { data: events, error } = await query;

    if (error) {
      console.error('[Check Event Slug] Error:', error);
      return res.status(500).json({ error: 'Internal server error' });
    }

    return res.status(200).json({
      available: !events || events.length === 0,
      slug
    });
  } catch (error) {
    console.error('[Check Event Slug] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
