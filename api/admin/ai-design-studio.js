/**
 * /api/admin/ai-design-studio — AI Design Studio governance (Task #2852).
 *
 * GET  ?report=usage&month=YYYY-MM   → usage report (events + summary)
 * GET                                → effective settings + this month's summary
 * PUT  { settings }                  → save sanitized settings
 *
 * Configure permission (spec §29): tenant-user/admin sessions bypass
 * per-feature RBAC (like other admin endpoints); member sessions must hold
 * the `admin.ai-design-studio` feature on their role.
 */

import { supabase } from '../_lib/database.js';
import { getTenantContext, hasAdminAccess, hasFeatureAccess } from '../_lib/tenantContext.js';
import { AI_FEATURE_CONFIGURE } from '../_lib/aiStudioAccess.js';
import {
  AI_STUDIO_DEFAULT_SETTINGS,
  loadStudioSettings,
  saveStudioSettings,
} from '../_lib/aiDesignStudioSettings.js';
import { summarizeUsageRows, monthWindow, COST_ESTIMATES } from '../_lib/aiUsage.js';

function parseMonth(raw) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(raw || ''));
  if (!m) return monthWindow();
  const y = Number(m[1]);
  const mo = Number(m[2]) - 1;
  if (mo < 0 || mo > 11) return monthWindow();
  return {
    start: new Date(Date.UTC(y, mo, 1)).toISOString(),
    end: new Date(Date.UTC(y, mo + 1, 1)).toISOString(),
  };
}

export default async function handler(req, res) {
  if (!supabase) return res.status(503).json({ error: 'Database not configured' });

  const ctx = await getTenantContext(req);
  if (!ctx?.tenantId || !ctx.isAuthenticated) return res.status(401).json({ error: 'Authentication required' });
  // Feature-level RBAC: platform/tenant-admin sessions bypass; member roles
  // must hold the admin.ai-design-studio feature.
  if (!(await hasAdminAccess(ctx))) {
    const allowed = ctx.roleId ? await hasFeatureAccess(ctx.roleId, AI_FEATURE_CONFIGURE) : false;
    if (!allowed) return res.status(403).json({ error: 'Access denied' });
  }
  const tenantId = ctx.tenantId;

  try {
    if (req.method === 'GET') {
      const settings = await loadStudioSettings(supabase, tenantId);
      const window = parseMonth(req.query?.month);
      const { data: rows } = await supabase
        .from('ai_usage_event')
        .select('id, member_id, operation, model, units, estimated_cost, status, created_at, composition_id, page_id')
        .eq('tenant_id', tenantId)
        .gte('created_at', window.start)
        .lt('created_at', window.end)
        .order('created_at', { ascending: false })
        .limit(2000);
      const summary = summarizeUsageRows(rows || []);
      const blockedCount = (rows || []).filter((r) => r.status === 'blocked').length;

      if (req.query?.report === 'usage') {
        // Resolve member names for the report (best-effort).
        const memberIds = [...new Set((rows || []).map((r) => r.member_id).filter(Boolean))].slice(0, 200);
        let members = {};
        if (memberIds.length) {
          const { data: memberRows } = await supabase
            .from('member')
            .select('id, first_name, last_name, email')
            .eq('tenant_id', tenantId)
            .in('id', memberIds);
          for (const m of memberRows || []) {
            members[m.id] = [m.first_name, m.last_name].filter(Boolean).join(' ') || m.email || m.id;
          }
        }
        return res.status(200).json({
          window,
          summary,
          blockedCount,
          costEstimates: COST_ESTIMATES,
          members,
          events: (rows || []).slice(0, 500),
        });
      }

      return res.status(200).json({
        settings,
        defaults: AI_STUDIO_DEFAULT_SETTINGS,
        window,
        summary,
        blockedCount,
      });
    }

    if (req.method === 'PUT') {
      const saved = await saveStudioSettings(
        supabase,
        tenantId,
        req.body?.settings || {},
        ctx.memberId || null,
      );
      return res.status(200).json({ settings: saved });
    }

    res.setHeader('Allow', 'GET, PUT');
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'AI Design Studio settings request failed' });
  }
}
