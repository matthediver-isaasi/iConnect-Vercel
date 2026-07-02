import { supabase } from '../_lib/database.js';
import { getTenantContext } from '../_lib/tenantContext.js';
import { resolveWallOfFameTitlePrefixes } from '../_lib/wallOfFameTitlePrefix.js';

// Authenticated endpoint that resolves the title/honorific prefix for every
// Wall of Fame person in the tenant, using the same resolution path as the
// public display so the admin management list matches what visitors see.
export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!supabase) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  const tenantCtx = await getTenantContext(req);
  if (!tenantCtx || !tenantCtx.isAuthenticated) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const tenantId = tenantCtx.tenantId;
  if (!tenantId) {
    return res.status(403).json({ error: 'Invalid tenant context' });
  }

  try {
    const { data: people, error } = await supabase
      .from('wall_of_fame_person')
      .select('id, member_id')
      .eq('tenant_id', tenantId);

    if (error) {
      console.error('[WallOfFame TitlePrefixes] People query error:', error);
      return res.status(500).json({ error: 'Failed to fetch people' });
    }

    const prefixes = await resolveWallOfFameTitlePrefixes(supabase, tenantId, people || []);

    const map = {};
    for (const [personId, prefix] of prefixes.entries()) {
      map[personId] = prefix;
    }

    return res.status(200).json({ prefixes: map });
  } catch (err) {
    console.error('[WallOfFame TitlePrefixes] Error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
