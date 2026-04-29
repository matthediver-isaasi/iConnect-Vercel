import { supabase } from '../../../_lib/database.js';
import { getDashboardActor, tenantFilter } from '../../_lib/permissions.js';
import { runWidgetConfig } from '../../_lib/aggregation.js';

export default async function handler(req, res) {
  if (req.method !== 'POST' && req.method !== 'GET') {
    res.setHeader('Allow', 'GET, POST');
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

  const { id } = req.query || {};
  if (!id) return res.status(400).json({ error: 'Widget id is required' });

  let query = supabase.from('dashboard_widget').select('*').eq('id', id);
  query = tenantFilter(query, actor.tenantId);
  const { data: widget, error } = await query.single();
  if (error || !widget) {
    return res.status(404).json({ error: 'Widget not found' });
  }
  if (widget.scope === 'personal' && widget.owner_member_id !== actor.memberId) {
    return res.status(404).json({ error: 'Widget not found' });
  }

  try {
    const result = await runWidgetConfig(widget.config, actor.tenantId);
    return res.status(200).json({ widget, data: result });
  } catch (err) {
    console.error('[Dashboard Widgets] Data failed:', err);
    return res.status(400).json({ error: err.message || 'Failed to run widget' });
  }
}
