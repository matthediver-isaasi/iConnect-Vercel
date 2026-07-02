import { supabase } from '../../_lib/database.js';
import { getDashboardActor, tenantFilter } from '../_lib/permissions.js';
import { reorderSchema } from '../_lib/validation.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const actor = await getDashboardActor(req);
  if (!actor) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  if (!actor.permissions.view) {
    return res.status(403).json({ error: 'Dashboard not available for this role' });
  }
  if (!supabase) {
    return res.status(500).json({ error: 'Database not configured' });
  }

  const parsed = reorderSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid reorder payload', details: parsed.error.flatten() });
  }
  const { scope, ids } = parsed.data;

  if (scope === 'shared' && !actor.permissions.manageShared) {
    return res.status(403).json({ error: 'No permission to reorder shared widgets' });
  }
  if (scope === 'personal' && !actor.permissions.managePersonal) {
    return res.status(403).json({ error: 'No permission to reorder personal widgets' });
  }

  try {
    // Verify all ids belong to the calling actor + scope.
    let query = supabase
      .from('dashboard_widget')
      .select('id, owner_member_id, scope')
      .in('id', ids)
      .eq('scope', scope);
    query = tenantFilter(query, actor.tenantId);
    const { data: rows, error: loadErr } = await query;
    if (loadErr) throw loadErr;
    const allowedIds = new Set(
      (rows || [])
        .filter(r => scope === 'shared' || r.owner_member_id === actor.memberId)
        .map(r => r.id),
    );
    const filteredIds = ids.filter(id => allowedIds.has(id));

    // Apply orders sequentially (small lists).
    for (let index = 0; index < filteredIds.length; index += 1) {
      const id = filteredIds[index];
      const { error } = await supabase
        .from('dashboard_widget')
        .update({ display_order: index, updated_at: new Date().toISOString() })
        .eq('id', id);
      if (error) throw error;
    }

    return res.status(200).json({ success: true, count: filteredIds.length });
  } catch (err) {
    console.error('[Dashboard Widgets] Reorder failed:', err);
    return res.status(500).json({ error: err.message || 'Failed to reorder widgets' });
  }
}
