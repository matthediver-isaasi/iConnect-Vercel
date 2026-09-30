import { getDashboardActor } from '../_lib/permissions.js';
import { runWidgetConfig, MAX_LIST_GROUPS } from '../_lib/aggregation.js';
import { validateMembershipValueWidgetType, widgetConfigSchema } from '../_lib/validation.js';
import {
  canAccessMembershipValue,
  isMembershipValueConfig,
  setMembershipValueNoStore,
} from '../_lib/permissions.js';
import { validateMemberGroupWidgetType } from '../_lib/memberGroupContract.js';
import { normalizeWidgetConfigDateFilters } from '../_lib/widgetFilterDates.js';

export default async function handler(req, res) {
  return createHandler()(req, res);
}

export function createHandler(overrides = {}) {
  const deps = {
    getDashboardActor,
    runWidgetConfig,
    normalizeWidgetConfigDateFilters,
    ...overrides,
  };
  return (req, res) => previewHandler(req, res, deps);
}

async function previewHandler(req, res, deps) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const actor = await deps.getDashboardActor(req);
  if (!actor) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  if (!actor.permissions.view) {
    return res.status(403).json({ error: 'Dashboard not available for this role' });
  }
  setMembershipValueNoStore(req.body?.config, res);
  if (isMembershipValueConfig(req.body?.config) && !canAccessMembershipValue(actor, req.body.config)) {
    return res.status(403).json({ error: req.body.config.source === 'event_revenue'
      ? 'Event Registration Report permission required' : 'Membership Payment Report permission required' });
  }

  const parsed = widgetConfigSchema.safeParse(req.body?.config);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid widget config', details: parsed.error.flatten() });
  }

  try {
    const config = await deps.normalizeWidgetConfigDateFilters(parsed.data, actor.tenantId);
    validateMemberGroupWidgetType(config, req.body?.widgetType);
    validateMembershipValueWidgetType(config, req.body?.widgetType);
    // List widgets can display far more groups than a chart, so the builder
    // sends the draft widget type alongside the config.
    const isList = req.body?.widgetType === 'list';
    const result = await deps.runWidgetConfig(config, actor.tenantId, {
      maxGroups: isList ? MAX_LIST_GROUPS : undefined,
    });
    return res.status(200).json({ data: result });
  } catch (err) {
    console.error('[Dashboard Widgets] Preview failed:', err);
    return res.status(400).json({ error: err.message || 'Failed to run preview' });
  }
}
