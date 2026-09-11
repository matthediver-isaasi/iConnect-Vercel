import { supabase } from '../../_lib/database.js';
import {
  getDashboardActor,
  isCanvasDashboardEmbed,
  setCanvasDashboardNoStore,
  tenantFilter,
} from '../_lib/permissions.js';
import { widgetCreateSchema } from '../_lib/validation.js';
import { getDashboardWidgetPalette } from '../_lib/palette.js';

export default async function handler(req, res) {
  return createHandler()(req, res);
}

/**
 * The optional dependency overrides keep the endpoint behavior testable
 * without changing the production handler's auth/database path.
 */
export function createHandler(overrides = {}) {
  const deps = {
    supabase,
    getDashboardActor,
    getDashboardWidgetPalette,
    widgetCreateSchema,
    ...overrides,
  };
  return async function dashboardWidgetsHandler(req, res) {
    setCanvasDashboardNoStore(req, res);
    const actor = await deps.getDashboardActor(req);
    if (!actor) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    if (!actor.permissions.view) {
      return res.status(403).json({ error: 'Dashboard not available for this role' });
    }
    if (!deps.supabase) {
      return res.status(500).json({ error: 'Database not configured' });
    }

    if (req.method === 'GET') {
      return listWidgets(req, res, actor, deps);
    }
    if (req.method === 'POST') {
      return createWidget(req, res, actor, deps);
    }
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  };
}

async function listWidgets(req, res, actor, deps) {
  const canvasEmbed = isCanvasDashboardEmbed(req);
  // Optional ?scope=shared|personal narrows the response. The default returns
  // both lists so the dashboard page can render in a single round trip.
  const requestedScope = (req.query?.scope || '').toString().toLowerCase();
  if (requestedScope && requestedScope !== 'shared' && requestedScope !== 'personal') {
    return res.status(400).json({ error: 'scope must be "shared" or "personal"' });
  }
  if (canvasEmbed && requestedScope === 'personal') {
    return res.status(400).json({ error: 'Canvas embeds can only use shared widgets' });
  }

  const wantShared = canvasEmbed || !requestedScope || requestedScope === 'shared';
  const wantPersonal = !canvasEmbed && (!requestedScope || requestedScope === 'personal');

  try {
    let shared = [];
    let personal = [];
    let pagination = null;

    if (wantShared) {
      let sharedQuery = deps.supabase.from('dashboard_widget');
      sharedQuery = canvasEmbed
        ? sharedQuery.select('*', { count: 'exact' })
        : sharedQuery.select('*');
      sharedQuery = sharedQuery
        .eq('scope', 'shared')
        .order('display_order', { ascending: true });
      if (canvasEmbed) {
        // display_order is editable and is not unique.  A stable id tie-break
        // keeps page boundaries deterministic when widgets share an order.
        sharedQuery = sharedQuery.order('id', { ascending: true });
      }
      sharedQuery = tenantFilter(sharedQuery, actor.tenantId);

      if (canvasEmbed) {
        const parsedPage = parseCanvasPage(req.query?.page);
        const parsedPageSize = parseCanvasPageSize(
          req.query?.pageSize ?? req.query?.page_size ?? req.query?.limit,
        );
        if (!parsedPage || !parsedPageSize) {
          return res.status(400).json({
            error: 'page must be a positive integer and pageSize must be between 1 and 100',
          });
        }
        const offset = (parsedPage - 1) * parsedPageSize;
        sharedQuery = sharedQuery.range(offset, offset + parsedPageSize - 1);
        const { data, error, count } = await sharedQuery;
        if (error) throw error;
        shared = data || [];
        const total = Number.isInteger(count) ? count : offset + shared.length;
        pagination = {
          page: parsedPage,
          pageSize: parsedPageSize,
          total,
          pages: Math.max(1, Math.ceil(total / parsedPageSize)),
          hasMore: offset + shared.length < total,
        };
      } else {
        const { data, error } = await sharedQuery;
        if (error) throw error;
        shared = data || [];
      }
    }

    if (wantPersonal) {
      let personalQuery = deps.supabase
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
      palette: await deps.getDashboardWidgetPalette(actor.tenantId),
    };
    if (wantShared) body.shared = shared;
    if (wantPersonal) body.personal = personal;
    if (pagination) body.pagination = pagination;
    return res.status(200).json(body);
  } catch (err) {
    console.error('[Dashboard Widgets] List failed:', err);
    return res.status(500).json({ error: err.message || 'Failed to list widgets' });
  }
}

function parseCanvasPage(value) {
  if (value === undefined || value === null || value === '') return 1;
  if (Array.isArray(value)) return null;
  const page = Number(value);
  return Number.isInteger(page) && page > 0 ? page : null;
}

function parseCanvasPageSize(value) {
  if (value === undefined || value === null || value === '') return 50;
  if (Array.isArray(value)) return null;
  const pageSize = Number(value);
  return Number.isInteger(pageSize) && pageSize > 0 && pageSize <= 100
    ? pageSize
    : null;
}

async function createWidget(req, res, actor, deps) {
  const parsed = deps.widgetCreateSchema.safeParse(req.body);
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
    let orderQuery = deps.supabase
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

    const { data, error } = await deps.supabase
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
