import { supabase } from '../_lib/database.js';
import { getTenantContext, hasAdminAccess } from '../_lib/tenantContext.js';
import {
  DASHBOARD_SOURCES,
  getCustomFieldsForSource,
  getHiddenGroupFields,
  HIDDEN_GROUP_FIELDS_KEY,
} from './_lib/sources.js';
import {
  getDashboardWidgetPalette,
  saveDashboardWidgetPalette,
} from './_lib/palette.js';
import { validateDashboardWidgetPalette } from '../../shared/dashboardWidgetPalette.js';

/**
 * Admin-only management surface for per-tenant hidden grouping fields.
 *
 * GET  -> the UNFILTERED field catalog per source (so admins can re-show a
 *         field they previously hid) plus the current hidden map.
 * PUT  -> replace the hidden map ({ [sourceId]: ["system:name", "custom:id"] }),
 *         persisted as a JSON system_settings row for the tenant.
 *
 * Note: getTenantIdFromSession only checks membership; admin gating must go
 * through getTenantContext + hasAdminAccess.
 */
export default async function handler(req, res) {
  const ctx = await getTenantContext(req);
  if (!ctx?.isAuthenticated) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  if (!(await hasAdminAccess(ctx))) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  const tenantId = ctx.tenantId || null;

  try {
    if (req.method === 'GET') {
      const sources = [];
      for (const def of Object.values(DASHBOARD_SOURCES)) {
        const customFields = await getCustomFieldsForSource(def, tenantId);
        sources.push({
          id: def.id,
          label: def.label,
          fields: [
            ...def.systemFields.map(f => ({
              key: `system:${f.name}`,
              label: f.label,
            })),
            ...customFields.map(f => ({
              key: `custom:${f.id}`,
              label: `${f.label} (custom)`,
            })),
          ],
        });
      }
      const [hidden, palette] = await Promise.all([
        getHiddenGroupFields(tenantId),
        getDashboardWidgetPalette(tenantId),
      ]);
      return res.status(200).json({ sources, hidden, palette });
    }

    if (req.method === 'PUT') {
      const body = req.body || {};
      if (body.palette !== undefined) {
        const parsed = validateDashboardWidgetPalette(body.palette);
        if (!parsed.success) {
          return res.status(400).json({ error: parsed.error });
        }
        await saveDashboardWidgetPalette(tenantId, parsed.palette);
        return res.status(200).json({ success: true, palette: parsed.palette });
      }

      const input = body.hidden;
      if (!input || typeof input !== 'object' || Array.isArray(input)) {
        return res.status(400).json({
          error: 'palette or hidden settings are required',
        });
      }
      // Validate against the registry: only known sources and well-formed
      // field keys are persisted.
      const clean = {};
      for (const [sourceId, keys] of Object.entries(input)) {
        if (!DASHBOARD_SOURCES[sourceId]) continue;
        if (!Array.isArray(keys)) continue;
        const valid = keys.filter(
          k => typeof k === 'string' && /^(system|custom):.+$/.test(k),
        );
        if (valid.length > 0) clean[sourceId] = Array.from(new Set(valid));
      }
      const serialized = JSON.stringify(clean);

      let query = supabase
        .from('system_settings')
        .select('id')
        .eq('setting_key', HIDDEN_GROUP_FIELDS_KEY);
      query = tenantId ? query.eq('tenant_id', tenantId) : query.is('tenant_id', null);
      const { data: existing, error: selErr } = await query;
      if (selErr) throw selErr;

      if (existing && existing.length > 0) {
        const { error } = await supabase
          .from('system_settings')
          .update({ setting_value: serialized })
          .eq('id', existing[0].id);
        if (error) throw error;
      } else {
        const { error } = await supabase.from('system_settings').insert({
          tenant_id: tenantId,
          setting_key: HIDDEN_GROUP_FIELDS_KEY,
          setting_value: serialized,
          setting_type: 'json',
          description: 'Per-tenant hidden dashboard grouping fields, keyed by source',
        });
        if (error) throw error;
      }
      return res.status(200).json({ success: true, hidden: clean });
    }

    res.setHeader('Allow', 'GET, PUT');
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('[Dashboard Hidden Fields] Failed:', err);
    return res.status(500).json({ error: err.message || 'Request failed' });
  }
}
