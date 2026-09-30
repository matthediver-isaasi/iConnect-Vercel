// Bulk page-management meta for /IEditPageManagement (Task #2749)
//
// GET /api/admin/page-management-meta
//
// Returns, in a single request, everything the Page Management screen needs
// beyond the raw page list:
//   * Per page (keyed by page id): the latest audit's error/warning/info
//     counts + timestamp, and the latest saved version's saver name + time.
//   * Tenant-wide stats: total pages, microsite count, pages-in-microsites,
//     average errors/warnings per audited page, and the previous-period
//     averages used to render the trend arrows.
//
// Auth mirrors the canvas audit/version endpoints: tenant admin OR a portal
// role holding the `site-builder.page-editor` feature. 404 (not 403) on a
// failed gate to avoid leaking anything to non-editors.

import { supabase } from '../_lib/database.js';
import { getTenantContext, hasFeatureAccess } from '../_lib/tenantContext.js';
import { isMissingMicrositeSchema } from '../_lib/microsites.js';

// ~30-day comparison window for the trend arrows.
const TREND_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

// Resolve a set of member ids to human-readable display names.
// Falls back name → first/last → email; unresolved ids are simply absent.
// (Mirrors resolveSaverNames in api/canvas-versions/[pageId].js.)
async function resolveSaverNames(memberIds, tenantId) {
  const ids = [...new Set(memberIds.filter(Boolean))];
  if (ids.length === 0) return {};
  const { data, error } = await supabase
    .from('member')
    .select('id, first_name, last_name, email')
    .eq('tenant_id', tenantId)
    .in('id', ids);
  if (error || !Array.isArray(data)) return {};
  const map = {};
  for (const m of data) {
    const full = [m.first_name, m.last_name].filter(Boolean).join(' ').trim();
    map[m.id] = full || m.email || null;
  }
  return map;
}

// Fetch every row for a query, paging past PostgREST's 1000-row cap. The
// builder factory MUST apply a deterministic .order() so pages don't skip or
// repeat rows across ranges.
async function fetchAllRows(buildQuery) {
  const PAGE = 1000;
  const out = [];
  let from = 0;
  for (;;) {
    const { data, error } = await buildQuery().range(from, from + PAGE - 1);
    if (error) return { error };
    if (!data || data.length === 0) break;
    out.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return { data: out };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

export default async function handler(req, res) {
  if (!supabase) return res.status(503).json({ error: 'Database not configured' });

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  let context;
  try { context = await getTenantContext(req); }
  catch (err) { return res.status(500).json({ error: 'Failed to resolve tenant context' }); }
  if (!context?.tenantId) return res.status(403).json({ error: 'Tenant context required' });
  if (!context.isAuthenticated) return res.status(401).json({ error: 'Authentication required' });

  let canEditCanvasPages = !!context.tenantUserId;
  if (!canEditCanvasPages && context.roleId) {
    canEditCanvasPages = await hasFeatureAccess(context.roleId, 'site-builder.page-editor');
  }
  if (!canEditCanvasPages) return res.status(404).json({ error: 'Not found' });

  const tenantId = context.tenantId;

  try {
    // --- Tenant-wide page counts (head-only, no row transfer) ---
    const [
      totalPagesRes,
      pagesInMicrositesRes,
      micrositeCountRes,
    ] = await Promise.all([
      supabase
        .from('i_edit_page')
        .select('id', { count: 'exact', head: true })
        .eq('tenant_id', tenantId),
      supabase
        .from('i_edit_page')
        .select('id', { count: 'exact', head: true })
        .eq('tenant_id', tenantId)
        .not('microsite_id', 'is', null),
      supabase
        .from('microsite')
        .select('id', { count: 'exact', head: true })
        .eq('tenant_id', tenantId),
    ]);

    // Core page counts must be trustworthy — fail loudly rather than reporting
    // a misleading zero if the query errored.
    if (totalPagesRes.error) throw totalPagesRes.error;
    if (pagesInMicrositesRes.error) throw pagesInMicrositesRes.error;
    const totalPages = totalPagesRes.count || 0;
    const pagesInMicrosites = pagesInMicrositesRes.count || 0;

    // Microsites are an optional schema on some tenants: a missing-schema error
    // legitimately means "zero microsites", but any other error should fail.
    let micrositeCount = 0;
    if (micrositeCountRes.error) {
      if (!isMissingMicrositeSchema(micrositeCountRes.error)) {
        throw micrositeCountRes.error;
      }
    } else {
      micrositeCount = micrositeCountRes.count || 0;
    }

    // --- Latest version saver per page ---
    // Ordered newest-first so the first row seen per page is its latest save.
    const versionsResult = await fetchAllRows(() =>
      supabase
        .from('canvas_page_version')
        .select('page_id, created_by, created_at')
        .eq('tenant_id', tenantId)
        .order('created_at', { ascending: false })
        .order('id', { ascending: false }),
    );
    if (versionsResult.error) throw versionsResult.error;

    const latestVersionByPage = new Map();
    for (const v of versionsResult.data) {
      if (!latestVersionByPage.has(v.page_id)) latestVersionByPage.set(v.page_id, v);
    }

    // --- Audit runs per page (latest overall + latest before the window) ---
    const auditsResult = await fetchAllRows(() =>
      supabase
        .from('canvas_page_audit_run')
        .select('page_id, error_count, warning_count, info_count, created_at')
        .eq('tenant_id', tenantId)
        .order('created_at', { ascending: false })
        .order('id', { ascending: false }),
    );
    if (auditsResult.error) throw auditsResult.error;

    const cutoffMs = Date.now() - TREND_WINDOW_MS;
    const latestAuditByPage = new Map();
    const prevAuditByPage = new Map(); // latest run older than the cutoff
    for (const a of auditsResult.data) {
      if (!latestAuditByPage.has(a.page_id)) latestAuditByPage.set(a.page_id, a);
      const ts = a.created_at ? new Date(a.created_at).getTime() : NaN;
      if (Number.isFinite(ts) && ts < cutoffMs && !prevAuditByPage.has(a.page_id)) {
        prevAuditByPage.set(a.page_id, a);
      }
    }

    // --- Resolve saver names ---
    const nameMap = await resolveSaverNames(
      [...latestVersionByPage.values()].map((v) => v.created_by),
      tenantId,
    );

    // --- Assemble per-page meta ---
    const pageIds = new Set([
      ...latestVersionByPage.keys(),
      ...latestAuditByPage.keys(),
    ]);
    const pagesMeta = {};
    for (const pid of pageIds) {
      const version = latestVersionByPage.get(pid) || null;
      const audit = latestAuditByPage.get(pid) || null;
      pagesMeta[pid] = {
        savedByName: version && version.created_by ? (nameMap[version.created_by] || null) : null,
        savedAt: version ? version.created_at : null,
        audited: !!audit,
        errorCount: audit ? (audit.error_count || 0) : 0,
        warningCount: audit ? (audit.warning_count || 0) : 0,
        infoCount: audit ? (audit.info_count || 0) : 0,
        auditedAt: audit ? audit.created_at : null,
      };
    }

    // --- Tenant-wide averages + trend ---
    const avgOf = (runs, key) => {
      if (runs.length === 0) return null;
      const sum = runs.reduce((acc, r) => acc + (r[key] || 0), 0);
      return round2(sum / runs.length);
    };
    const latestRuns = [...latestAuditByPage.values()];
    const prevRuns = [...prevAuditByPage.values()];

    const stats = {
      totalPages,
      micrositeCount,
      pagesInMicrosites,
      auditedPageCount: latestRuns.length,
      avgErrors: avgOf(latestRuns, 'error_count'),
      avgWarnings: avgOf(latestRuns, 'warning_count'),
      prevAvgErrors: avgOf(prevRuns, 'error_count'),
      prevAvgWarnings: avgOf(prevRuns, 'warning_count'),
    };

    return res.status(200).json({ pages: pagesMeta, stats });
  } catch (error) {
    console.error('[page-management-meta] Error:', error);
    return res.status(500).json({ error: 'Failed to load page management meta' });
  }
}
