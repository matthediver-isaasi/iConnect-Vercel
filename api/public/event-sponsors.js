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
    const tenant = await resolveTenantFromRequest(req);

    if (!tenant) {
      return res.status(404).json({ error: 'Tenant not found' });
    }

    const eventId = req.query.event_id;
    const eventType = req.query.event_type || 'simple';
    if (!eventId) {
      return res.status(400).json({ error: 'event_id is required' });
    }

    let assignQuery = supabase
      .from('event_sponsor_assignment')
      .select('sponsor_id, category_id')
      .eq('tenant_id', tenant.id)
      .eq('event_id', eventId)
      .eq('event_type', eventType);

    const { data: assignments, error: assignError } = await assignQuery;

    if (assignError) {
      console.error('[Public event-sponsors] Assignment query error:', assignError);
      return res.status(500).json({ error: 'Failed to load sponsor assignments' });
    }

    if (!assignments || assignments.length === 0) {
      return res.status(200).json({ sponsors: [], categories: [], assignments: [] });
    }

    const sponsorIds = assignments.map(a => a.sponsor_id).filter(Boolean);

    const { data: sponsors, error: sponsorError } = await supabase
      .from('event_sponsor')
      .select('id, name, logo_url, website_url, description, category_id')
      .eq('tenant_id', tenant.id)
      .in('id', sponsorIds);

    if (sponsorError) {
      console.error('[Public event-sponsors] Sponsor query error:', sponsorError);
      return res.status(500).json({ error: 'Failed to load sponsors' });
    }

    const { data: categories, error: catError } = await supabase
      .from('event_sponsor_category')
      .select('id, name, display_order')
      .eq('tenant_id', tenant.id)
      .order('display_order', { ascending: true });

    if (catError) {
      console.error('[Public event-sponsors] Category query error:', catError);
    }

    return res.status(200).json({
      sponsors: sponsors || [],
      categories: categories || [],
      assignments: assignments || []
    });
  } catch (err) {
    console.error('[Public event-sponsors] Error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
