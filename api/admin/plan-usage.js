/**
 * GET /api/admin/plan-usage
 *
 * Read-only Plan & Usage payload for the admin "Plan & usage" page.
 * Returns the tenant's current plan + quotas + live counts so the page can
 * render progress bars without doing N round-trips of its own.
 */

import { supabase } from '../_lib/database.js';
import { getTenantContext, hasAdminAccess } from '../_lib/tenantContext.js';

async function countRows(tenantId, table, extraFilter) {
  let q = supabase.from(table).select('id', { count: 'exact', head: true }).eq('tenant_id', tenantId);
  if (extraFilter) q = extraFilter(q);
  const { count } = await q;
  return count || 0;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!supabase) return res.status(503).json({ error: 'Database not configured' });

  const ctx = await getTenantContext(req);
  if (!ctx?.tenantId) return res.status(401).json({ error: 'Authentication required' });
  if (!(await hasAdminAccess(ctx))) return res.status(403).json({ error: 'Admin access required' });

  const tenantId = ctx.tenantId;

  const { data: tenant } = await supabase
    .from('tenant').select('id, name, plan_code').eq('id', tenantId).single();
  if (!tenant) return res.status(404).json({ error: 'Tenant not found' });

  const { data: plan } = await supabase
    .from('plan').select('code, name, quotas').eq('code', tenant.plan_code || 'free').single();

  // Live usage counters
  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);

  const [members, eventsThisMonth] = await Promise.all([
    countRows(tenantId, 'member', q => q.eq('is_sample', false)),
    countRows(tenantId, 'event', q => q.gte('created_at', monthStart.toISOString())),
  ]);

  const usage = {
    members,
    events_per_month: eventsThisMonth,
    storage_mb: null,        // Not tracked yet — surface as "—" in UI
    emails_per_month: null,  // Same
  };

  return res.status(200).json({
    tenant: { id: tenant.id, name: tenant.name },
    plan: plan || { code: tenant.plan_code, name: tenant.plan_code, quotas: {} },
    usage,
  });
}
