import { supabase } from '../_lib/database.js';
import { getSession } from '../_lib/session.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!supabase) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  const sessionResult = await getSession(req);
  if (!sessionResult?.data) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  const session = sessionResult.data;
  if (!session.tenantId || !session.identityId) {
    return res.status(401).json({ error: 'Invalid session' });
  }

  try {
    const { status, from_date, to_date, limit = 50, offset = 0 } = req.query;

    let query = supabase
      .from('agent_booking')
      .select('*', { count: 'exact' })
      .eq('tenant_id', session.tenantId)
      .eq('identity_id', session.identityId)
      .order('starts_at', { ascending: true });

    if (status && status !== 'all') {
      query = query.eq('status', status);
    }

    if (from_date) {
      query = query.gte('starts_at', from_date);
    }

    if (to_date) {
      query = query.lte('starts_at', to_date);
    }

    query = query.range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1);

    const { data: bookings, error, count } = await query;

    if (error) {
      console.error('[Bookings List] Database error:', error);
      return res.status(500).json({ error: 'Failed to fetch bookings' });
    }

    return res.json({
      bookings: bookings || [],
      total: count || 0
    });
  } catch (err) {
    console.error('[Bookings List] Error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
}
