import { supabase } from '../../_lib/database.js';
import { getDashboardActor, tenantFilter } from '../_lib/permissions.js';
import { widgetCreateSchema } from '../_lib/validation.js';
import { getDashboardWidgetPalette } from '../_lib/palette.js';

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

  if (req.method === 'GET') {
    return listWidgets(req, res, actor);
  }
  if (req.method === 'POST') {
    return createWidget(req, res, actor);
  }
  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'Method not allowed' });
}

async function listWidgets(req, res, actor) {
  // Optional ?scope=shared|personal narrows the response. The default returns
  // both lists so the dashboard page can render in a single round trip.
  const requestedScope = (req.query?.scope || '').toString().toLowerCase();
  const wantShared = !requestedScope || requestedScope === 'shared';
  const wantPersonal = !requestedScope || requestedScope === 'personal';

  if (requestedScope && !wantShared && !wantPersonal) {
    return res.status(400).json({ error: 'scope must be "shared" or "personal"' });
  }

  try {
    let shared = [];
    let personal = [];

    if (wantShared) {
      let sharedQuery = supabase
        .from('dashboard_widget')
        .select('*')
        .eq('scope', 'shared')
        .order('display_order', { ascending: true });
      sharedQuery = tenantFilter(sharedQuery, actor.tenantId);
      const { data, error } = await sharedQuery;
      if (error) throw error;
      shared = data || [];
    }

    if (wantPersonal) {
      let personalQuery = supabase
        .from('dashboard_widget')
        .select('*')
        .eq('scope', 'personal')
        .eq('owner_member_id', actor.memberId)
        .order('display_order', { ascending: true });
      personalQuery = tenantFilter(personalQuery, actor.tenantId);
      const { data, error } = await personalQuery;
      if (error) throw error;
      personal = data || [];
    }

    const body = {
      permissions: actor.permissions,
      palette: await getDashboardWidgetPalette(actor.tenantId),
    };
    if (wantShared) body.shared = shared;
    if (wantPersonal) body.personal = personal;
    return res.status(200).json(body);
  } catch (err) {
    console.error('[Dashboard Widgets] List failed:', err);
    return res.status(500).json({ error: err.message || 'Failed to list widgets' });
  }
}

async function createWidget(req, res, actor) {
  const parsed = widgetCreateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid widget payload', details: parsed.error.flatten() });
  }
  const payload = parsed.data;

  if (payload.scope === 'shared' && !actor.permissions.manageShared) {
    return res.status(403).json({ error: 'No permission to manage shared widgets' });
  }
  if (payload.scope === 'personal' && !actor.permissions.managePersonal) {
    return res.status(403).json({ error: 'No permission to manage personal widgets' });
  }

  try {
    // Place new widget at the end of its zone.
    let orderQuery = supabase
      .from('dashboard_widget')
      .select('display_order')
      .eq('scope', payload.scope)
      .order('display_order', { ascending: false })
      .limit(1);
    if (payload.scope === 'personal') {
      orderQuery = orderQuery.eq('owner_member_id', actor.memberId);
    }
    orderQuery = tenantFilter(orderQuery, actor.tenantId);
    const { data: lastRows } = await orderQuery;
    const nextOrder = (lastRows?.[0]?.display_order ?? -1) + 1;

    const insertRow = {
      tenant_id: actor.tenantId || null,
      scope: payload.scope,
      owner_member_id: payload.scope === 'personal' ? actor.memberId : null,
      title: payload.title,
      widget_type: payload.widget_type,
      width: payload.width,
      height: payload.height,
      config: payload.config,
      display_order: nextOrder,
      created_by: actor.memberId,
    };

    const { data, error } = await supabase
      .from('dashboard_widget')
      .insert(insertRow)
      .select()
      .single();

    if (error) throw error;
    return res.status(201).json({ widget: data });
  } catch (err) {
    console.error('[Dashboard Widgets] Create failed:', err);
    return res.status(500).json({ error: err.message || 'Failed to create widget' });
  }
}
