import { getDashboardActor } from './_lib/permissions.js';
import { getSourceCatalog } from './_lib/sources.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const actor = await getDashboardActor(req);
  if (!actor) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  if (!actor.permissions.view) {
    return res.status(403).json({ error: 'Dashboard not available for this role' });
  }

  try {
    const sources = await getSourceCatalog(actor.tenantId);
    return res.status(200).json({ sources });
  } catch (err) {
    console.error('[Dashboard Sources] Failed:', err);
    return res.status(500).json({ error: err.message || 'Failed to load sources' });
  }
}
