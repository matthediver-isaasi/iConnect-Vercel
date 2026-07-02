// Admin preview endpoint for the safe-delete flow (task-700) — complex variant.
// See api/events/[id]/delete-preview.js for behaviour.

import { supabase } from '../../_lib/database.js';
import { getTenantContext, hasAdminAccess } from '../../_lib/tenantContext.js';
import { previewEventDeletion } from '../../_lib/eventDeletion.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!supabase) return res.status(503).json({ error: 'Database not configured' });

  const ctx = await getTenantContext(req);
  if (!ctx.isAuthenticated) return res.status(401).json({ error: 'Authentication required' });
  if (!(await hasAdminAccess(ctx))) return res.status(403).json({ error: 'Admin access required' });
  if (!ctx.tenantId) return res.status(400).json({ error: 'Tenant context required' });

  const { id } = req.query;
  if (!id) return res.status(400).json({ error: 'Event id required' });

  const result = await previewEventDeletion({ eventId: id, tenantId: ctx.tenantId, eventTable: 'complex_event' });
  if (!result.found) return res.status(404).json(result);
  return res.json(result);
}
