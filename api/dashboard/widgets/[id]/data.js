import { supabase } from '../../../_lib/database.js';
import {
  getDashboardActor,
  isCanvasDashboardEmbed,
  isSharedTenantWidget,
  setCanvasDashboardNoStore,
  tenantFilter,
} from '../../_lib/permissions.js';
import { runWidgetConfig } from '../../_lib/aggregation.js';
import { readWidgetCache } from '../../_lib/resultCache.js';
import { validateMemberGroupWidgetType } from '../../_lib/memberGroupContract.js';

export default async function handler(req, res) {
  return createHandler()(req, res);
}

export function createHandler(overrides = {}) {
  const deps = {
    supabase,
    getDashboardActor,
    runWidgetConfig,
    readWidgetCache,
    ...overrides,
  };
  return async function dashboardWidgetDataHandler(req, res) {
    setCanvasDashboardNoStore(req, res);
    const refresh = overrides.refresh === true;
    if ((refresh && req.method !== 'POST') || (req.method !== 'POST' && req.method !== 'GET')) {
      res.setHeader('Allow', refresh ? 'POST' : 'GET, POST');
      return res.status(405).json({ error: 'Method not allowed' });
    }

    let actor;
    try {
      actor = await deps.getDashboardActor(req);
    } catch {
      return res.status(503).json({ error: 'Unable to verify dashboard access' });
    }
    if (!actor) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    if (!actor.permissions.view) {
      return res.status(403).json({ error: 'Dashboard not available for this role' });
    }
    if (!deps.supabase) {
      return res.status(500).json({ error: 'Database not configured' });
    }

    const { id } = req.query || {};
    if (!id) return res.status(400).json({ error: 'Widget id is required' });

    let query = deps.supabase.from('dashboard_widget').select('*').eq('id', id);
    query = tenantFilter(query, actor.tenantId);
    const { data: widget, error } = await query.single();
    if (error || !widget) {
      return res.status(404).json({ error: 'Widget not found' });
    }
    if ((widget.tenant_id ?? null) !== (actor.tenantId ?? null)
        || !['personal', 'shared'].includes(widget.scope)) {
      return res.status(404).json({ error: 'Widget not found' });
    }
    if (widget.scope === 'personal' && widget.owner_member_id !== actor.memberId) {
      return res.status(404).json({ error: 'Widget not found' });
    }
    if (isCanvasDashboardEmbed(req) && !isSharedTenantWidget(widget, actor)) {
      return res.status(404).json({ error: 'Widget not found' });
    }

    try {
      validateMemberGroupWidgetType(widget.config, widget.widget_type);
      const result = await deps.readWidgetCache(deps.supabase, widget, actor, {
        refresh, run: deps.runWidgetConfig,
      });
      return res.status(200).json({ widget, ...result });
    } catch (err) {
      console.error('[Dashboard Widgets] Data failed:', err);
      if (err.message?.includes('Refresh limit')) {
        res.setHeader('Retry-After', '60');
        return res.status(429).json({ error: 'Refresh limit reached; try again in one minute' });
      }
      if (err.message?.includes('Widget changed')) {
        return res.status(409).json({ error: 'Widget changed; reload and try again' });
      }
      return res.status(503).json({ error: 'Widget cache unavailable. Please try again later.' });
    }
  };
}
