import { supabase } from '../../../_lib/database.js';
import { performance } from 'node:perf_hooks';
import {
  getDashboardActor,
  isCanvasDashboardEmbed,
  isSharedTenantWidget,
  setCanvasDashboardNoStore,
  tenantFilter,
  canAccessMembershipValue,
  isMembershipValueConfig,
  setMembershipValueNoStore,
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
    const started = performance.now();
    const timings = [];
    const measure = async (name, operation) => {
      const start = performance.now();
      try {
        return await operation();
      } finally {
        timings.push(`${name};dur=${Math.round(performance.now() - start)}`);
      }
    };
    const reply = (status, body) => {
      res.setHeader('Server-Timing', [
        ...timings,
        `total;dur=${Math.round(performance.now() - started)}`,
      ].join(', '));
      return res.status(status).json(body);
    };
    setCanvasDashboardNoStore(req, res);
    const refresh = overrides.refresh === true;
    if ((refresh && req.method !== 'POST') || (req.method !== 'POST' && req.method !== 'GET')) {
      res.setHeader('Allow', refresh ? 'POST' : 'GET, POST');
      return reply(405, { error: 'Method not allowed' });
    }

    let actor;
    try {
      actor = await measure('access', () => deps.getDashboardActor(req));
    } catch {
      return reply(503, { error: 'Unable to verify dashboard access' });
    }
    if (!actor) {
      return reply(401, { error: 'Authentication required' });
    }
    if (!actor.permissions.view) {
      return reply(403, { error: 'Dashboard not available for this role' });
    }
    if (!deps.supabase) {
      return reply(500, { error: 'Database not configured' });
    }

    const { id } = req.query || {};
    if (!id) return reply(400, { error: 'Widget id is required' });

    let query = deps.supabase.from('dashboard_widget').select('*').eq('id', id);
    query = tenantFilter(query, actor.tenantId);
    const { data: widget, error } = await measure('widget', () => query.single());
    if (error || !widget) {
      return reply(404, { error: 'Widget not found' });
    }
    if ((widget.tenant_id ?? null) !== (actor.tenantId ?? null)
        || !['personal', 'shared'].includes(widget.scope)) {
      return reply(404, { error: 'Widget not found' });
    }
    if (widget.scope === 'personal' && widget.owner_member_id !== actor.memberId) {
      return reply(404, { error: 'Widget not found' });
    }
    if (isCanvasDashboardEmbed(req) && !isSharedTenantWidget(widget, actor)) {
      return reply(404, { error: 'Widget not found' });
    }
    setMembershipValueNoStore(widget.config, res);
    if (isMembershipValueConfig(widget.config) && !canAccessMembershipValue(actor)) {
      return reply(403, { error: 'Membership Payment Report permission required' });
    }

    try {
      validateMemberGroupWidgetType(widget.config, widget.widget_type);
      const result = await measure('cache', () => deps.readWidgetCache(deps.supabase, widget, actor, {
        refresh, run: deps.runWidgetConfig,
      }));
      return reply(200, { widget, ...result });
    } catch (err) {
      console.error('[Dashboard Widgets] Data failed:', err);
      if (err.message?.includes('Refresh limit')) {
        res.setHeader('Retry-After', '60');
        return reply(429, { error: 'Refresh limit reached; try again in one minute' });
      }
      if (err.message?.includes('Widget changed')) {
        return reply(409, { error: 'Widget changed; reload and try again' });
      }
      return reply(503, { error: 'Widget cache unavailable. Please try again later.' });
    }
  };
}
