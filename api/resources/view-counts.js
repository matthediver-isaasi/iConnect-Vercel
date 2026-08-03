// Task #3300: per-resource view/download counts, aggregated in the database.
// The Resources page previously fetched every resource_view row via the
// generic entity list and grouped in the browser — PostgREST caps that list
// at 1000 rows, so counts froze once a tenant exceeded 1000 view rows.
import { supabase } from '../_lib/database.js';
import { getTenantContext } from '../_lib/tenantContext.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!supabase) {
    return res.status(500).json({ error: 'Database not configured' });
  }

  try {
    const tenantContext = await getTenantContext(req);
    // getTenantContext resolves a tenantId from the host even for anonymous
    // callers — require a real authenticated session (counts are shown to
    // logged-in members only) and reject stale cross-tenant sessions.
    if (!tenantContext?.tenantId || tenantContext.isAuthenticated !== true || tenantContext.tenantMismatch) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Aggregated in Postgres (GROUP BY) — no row shipping, no pagination.
    const { data, error } = await supabase.rpc('resource_view_counts', {
      p_tenant_id: tenantContext.tenantId,
    });
    if (error) {
      console.error('[resources/view-counts] aggregation failed:', error.message);
      return res.status(500).json({ error: 'Failed to load view counts' });
    }

    const counts = {};
    (data || []).forEach(row => {
      counts[row.resource_id] = Number(row.views) || 0;
    });

    return res.status(200).json({ counts });
  } catch (error) {
    console.error('[resources/view-counts] error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
