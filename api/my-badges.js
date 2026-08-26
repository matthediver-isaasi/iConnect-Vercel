import { supabase } from './_lib/database.js';
import { getTenantContext } from './_lib/tenantContext.js';
import { loadActiveSelfBadges } from './_lib/selfMemberBadges.js';

export default async function handler(req, res) {
  if (!supabase) return res.status(503).json({ error: 'Database not configured' });
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const result = await loadActiveSelfBadges(supabase, await getTenantContext(req));
    if (result.error) return res.status(result.status).json({ error: result.error });
    return res.status(200).json({ badges: result.badges });
  } catch (error) {
    console.error('[My badges]', error);
    return res.status(500).json({ error: 'Failed to load badges' });
  }
}