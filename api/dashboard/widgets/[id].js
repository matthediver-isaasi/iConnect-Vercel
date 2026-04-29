import { supabase } from '../../_lib/database.js';
import { getDashboardActor, tenantFilter } from '../_lib/permissions.js';
import { widgetUpdateSchema } from '../_lib/validation.js';

export default async function handler(req, res) {
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
  if (!id) {
    return res.status(400).json({ error: 'Widget id is required' });
  }

  const widget = await loadWidget(id, actor);
  if (!widget) {
    return res.status(404).json({ error: 'Widget not found' });
  }

  const writableScope = widget.scope === 'shared'
    ? actor.permissions.manageShared
    : actor.permissions.managePersonal && widget.owner_member_id === actor.memberId;

  if (req.method === 'GET') {
    return res.status(200).json({ widget });
  }
  if (req.method === 'PATCH') {
    if (!writableScope) {
      return res.status(403).json({ error: 'No permission to edit this widget' });
    }
    return updateWidget(req, res, widget);
  }
  if (req.method === 'DELETE') {
    if (!writableScope) {
      return res.status(403).json({ error: 'No permission to delete this widget' });
    }
    return deleteWidget(res, widget);
  }
  res.setHeader('Allow', 'GET, PATCH, DELETE');
  return res.status(405).json({ error: 'Method not allowed' });
}

async function loadWidget(id, actor) {
  let query = supabase
    .from('dashboard_widget')
    .select('*')
    .eq('id', id);
  query = tenantFilter(query, actor.tenantId);
  const { data, error } = await query.single();
  if (error || !data) return null;
  if (data.scope === 'personal' && data.owner_member_id !== actor.memberId) {
    return null;
  }
  return data;
}

async function updateWidget(req, res, widget) {
  const parsed = widgetUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid widget payload', details: parsed.error.flatten() });
  }
  const update = { ...parsed.data, updated_at: new Date().toISOString() };
  const { data, error } = await supabase
    .from('dashboard_widget')
    .update(update)
    .eq('id', widget.id)
    .select()
    .single();
  if (error) {
    console.error('[Dashboard Widgets] Update failed:', error);
    return res.status(500).json({ error: error.message || 'Failed to update widget' });
  }
  return res.status(200).json({ widget: data });
}

async function deleteWidget(res, widget) {
  const { error } = await supabase
    .from('dashboard_widget')
    .delete()
    .eq('id', widget.id);
  if (error) {
    console.error('[Dashboard Widgets] Delete failed:', error);
    return res.status(500).json({ error: error.message || 'Failed to delete widget' });
  }
  return res.status(200).json({ success: true });
}
