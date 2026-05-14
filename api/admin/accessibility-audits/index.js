import { supabase } from '../../_lib/database.js';
import { getTenantContext, hasFeatureAccess, hasAdminAccess } from '../../_lib/tenantContext.js';
import {
  runAxeAudit,
  summarizeAxeResult,
  validateAuditUrl,
  isBrowserlessConfigured,
  MAX_URLS_PER_RUN,
} from '../../_lib/browserlessAxe.js';

const FEATURE_ID = 'admin.accessibility-audits';

async function authorize(req, res) {
  const context = await getTenantContext(req);
  if (!context.isAuthenticated) {
    res.status(401).json({ error: 'Authentication required' });
    return null;
  }
  if (!context.tenantId) {
    res.status(400).json({ error: 'Tenant context not found' });
    return null;
  }
  // Platform/admin (tenant_user) sessions bypass per-feature RBAC the same
  // way other admin endpoints do (they are tenant-wide admins). Member
  // sessions must hold the `admin.accessibility-audits` feature on their
  // role.
  if (await hasAdminAccess(context)) {
    return context;
  }
  if (!context.roleId) {
    res.status(403).json({ error: 'Access denied' });
    return null;
  }
  const allowed = await hasFeatureAccess(context.roleId, FEATURE_ID);
  if (!allowed) {
    res.status(403).json({ error: 'Access denied' });
    return null;
  }
  return context;
}

function aggregateSummary(perUrl) {
  const totals = {
    critical_count: 0,
    serious_count: 0,
    moderate_count: 0,
    minor_count: 0,
    pass_count: 0,
    violation_count: 0,
  };
  for (const r of perUrl) {
    totals.critical_count += r.critical_count || 0;
    totals.serious_count += r.serious_count || 0;
    totals.moderate_count += r.moderate_count || 0;
    totals.minor_count += r.minor_count || 0;
    totals.pass_count += r.pass_count || 0;
    totals.violation_count += r.violation_count || 0;
  }
  const totalChecks = totals.pass_count + totals.violation_count;
  const score = totalChecks > 0 ? Math.round((totals.pass_count / totalChecks) * 100) : null;
  return { ...totals, score };
}

async function listAudits(req, res, context) {
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const pageSize = Math.min(Math.max(parseInt(req.query.pageSize, 10) || 25, 1), 100);
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  const { data, error, count } = await supabase
    .from('accessibility_audit')
    .select('*', { count: 'exact' })
    .eq('tenant_id', context.tenantId)
    .order('created_at', { ascending: false })
    .range(from, to);

  if (error) {
    return res.status(500).json({ error: error.message });
  }
  return res.json({ data: data || [], total: count || 0, page, pageSize });
}

async function createAudit(req, res, context) {
  if (!isBrowserlessConfigured()) {
    return res.status(503).json({
      error: 'Accessibility audits are not configured. BROWSERLESS_API_TOKEN is missing.',
    });
  }

  const rawUrls = Array.isArray(req.body?.urls) ? req.body.urls : [];
  if (rawUrls.length === 0) {
    return res.status(400).json({ error: 'At least one URL is required' });
  }
  if (rawUrls.length > MAX_URLS_PER_RUN) {
    return res.status(400).json({ error: `A run is limited to ${MAX_URLS_PER_RUN} URLs.` });
  }

  let normalizedUrls;
  try {
    normalizedUrls = rawUrls.map((u) => validateAuditUrl(u));
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  const requestedByName =
    [req.body?.requestedByName].find(Boolean) ||
    (context.tenantUserId ? 'Admin user' : 'Member');

  const { data: audit, error: insertErr } = await supabase
    .from('accessibility_audit')
    .insert({
      tenant_id: context.tenantId,
      requested_by_member_id: context.memberId || null,
      requested_by_tenant_user_id: context.tenantUserId || null,
      requested_by_name: requestedByName,
      status: 'running',
      urls: normalizedUrls,
      started_at: new Date().toISOString(),
    })
    .select()
    .single();

  if (insertErr || !audit) {
    return res.status(500).json({ error: insertErr?.message || 'Failed to create audit' });
  }

  const perUrl = [];
  let anyFailed = false;

  for (const url of normalizedUrls) {
    const startedAt = new Date().toISOString();
    try {
      const axeResult = await runAxeAudit(url);
      const summary = summarizeAxeResult(axeResult);
      const completedAt = new Date().toISOString();
      const { data: resultRow } = await supabase
        .from('accessibility_audit_result')
        .insert({
          audit_id: audit.id,
          tenant_id: context.tenantId,
          url,
          status: 'complete',
          started_at: startedAt,
          completed_at: completedAt,
          ...summary,
          axe_result: axeResult,
        })
        .select()
        .single();
      perUrl.push(resultRow || { ...summary });
    } catch (err) {
      anyFailed = true;
      const completedAt = new Date().toISOString();
      const { data: resultRow } = await supabase
        .from('accessibility_audit_result')
        .insert({
          audit_id: audit.id,
          tenant_id: context.tenantId,
          url,
          status: 'failed',
          started_at: startedAt,
          completed_at: completedAt,
          error_message: err.message || String(err),
        })
        .select()
        .single();
      perUrl.push(resultRow || {});
    }
  }

  const totals = aggregateSummary(perUrl);
  const allFailed = perUrl.every((r) => r.status === 'failed');
  const finalStatus = allFailed ? 'failed' : (anyFailed ? 'complete_with_errors' : 'complete');

  const { data: updated } = await supabase
    .from('accessibility_audit')
    .update({
      status: finalStatus,
      completed_at: new Date().toISOString(),
      ...totals,
    })
    .eq('id', audit.id)
    .eq('tenant_id', context.tenantId)
    .select()
    .single();

  return res.status(201).json({ data: updated || audit, results: perUrl });
}

export default async function handler(req, res) {
  const context = await authorize(req, res);
  if (!context) return;

  if (!supabase) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  try {
    if (req.method === 'GET') {
      return await listAudits(req, res, context);
    }
    if (req.method === 'POST') {
      return await createAudit(req, res, context);
    }
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('[AccessibilityAudits] handler error', err);
    return res.status(500).json({ error: err.message || 'Internal error' });
  }
}
