// Canvas page version history: list, snapshot, and restore.
//
// Routes:
//   GET    /api/canvas-versions/:pageId            → list versions (no design payload)
//   GET    /api/canvas-versions/:pageId?full=1     → list versions with full design payloads
//   GET    /api/canvas-versions/:pageId?versionId= → single version with design
//   POST   /api/canvas-versions/:pageId            → snapshot the current design (body: {label, source})
//   POST   /api/canvas-versions/:pageId?restore=1  → restore (body: {versionId}) - copies version.design onto the page
//
// Tenant hard-fail on every request — version data is authoring-only.

import { supabase } from '../_lib/database.js';
import { getTenantContext, hasFeatureAccess } from '../_lib/tenantContext.js';

const MAX_KEEP = 10;
const MAX_LOCKED = 3;

// Resolve a set of member ids to human-readable display names.
// Falls back name → first/last → email; unresolved ids are simply absent.
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

// Prune version history so only the MAX_KEEP most recent UNLOCKED snapshots
// remain. Locked versions are never deleted and never counted toward the limit,
// so they sit outside the pot of 10 rolling versions (Task #2759).
// Called after every snapshot insert (manual, publish, and pre-restore).
async function pruneVersions(pageId, tenantId) {
  const { data: unlocked } = await supabase
    .from('canvas_page_version')
    .select('id, created_at')
    .eq('page_id', pageId)
    .eq('tenant_id', tenantId)
    .eq('is_locked', false)
    .order('created_at', { ascending: false });
  if (Array.isArray(unlocked) && unlocked.length > MAX_KEEP) {
    const toDelete = unlocked.slice(MAX_KEEP).map((r) => r.id);
    if (toDelete.length > 0) {
      await supabase.from('canvas_page_version').delete().in('id', toDelete);
    }
  }
}

async function loadCanvasPage(pageId, tenantId) {
  const { data, error } = await supabase
    .from('i_edit_page')
    .select('id, tenant_id, builder_type, canvas_design')
    .eq('id', pageId)
    .eq('tenant_id', tenantId)
    .maybeSingle();
  if (error) return { error };
  if (!data) return { notFound: true };
  if (data.builder_type !== 'canvas') return { wrongBuilder: true };
  return { page: data };
}

export default async function handler(req, res) {
  if (!supabase) return res.status(503).json({ error: 'Database not configured' });
  const { pageId } = req.query;
  if (!pageId || typeof pageId !== 'string') return res.status(400).json({ error: 'pageId required' });

  let context;
  try { context = await getTenantContext(req); }
  catch (err) { return res.status(500).json({ error: 'Failed to resolve tenant context' }); }
  if (!context?.tenantId) return res.status(403).json({ error: 'Tenant context required' });
  if (!context.isAuthenticated) return res.status(401).json({ error: 'Authentication required' });

  // SECURITY: Canvas version snapshots contain full draft authoring
  // payloads. Require tenant admin OR `site-builder.page-editor`. Return
  // 404 (not 403) to avoid leaking page-id existence to non-editors.
  let canEditCanvasPages = !!context.tenantUserId;
  if (!canEditCanvasPages && context.roleId) {
    canEditCanvasPages = await hasFeatureAccess(context.roleId, 'site-builder.page-editor');
  }
  if (!canEditCanvasPages) return res.status(404).json({ error: 'Page not found' });

  const tenantId = context.tenantId;

  const pageCheck = await loadCanvasPage(pageId, tenantId);
  if (pageCheck.error) return res.status(500).json({ error: 'Failed to load page' });
  if (pageCheck.notFound) return res.status(404).json({ error: 'Page not found' });
  if (pageCheck.wrongBuilder) return res.status(409).json({ error: 'Page is not a Canvas Builder page' });

  if (req.method === 'GET') {
    const versionId = req.query.versionId;
    const full = req.query.full === '1';
    if (versionId) {
      const { data, error } = await supabase
        .from('canvas_page_version')
        .select('*')
        .eq('id', versionId)
        .eq('page_id', pageId)
        .eq('tenant_id', tenantId)
        .maybeSingle();
      if (error) return res.status(500).json({ error: 'Failed to load version' });
      if (!data) return res.status(404).json({ error: 'Version not found' });
      return res.status(200).json({ version: data });
    }
    const cols = full
      ? 'id, page_id, design, label, source, created_by, created_at, is_locked'
      : 'id, page_id, label, source, created_by, created_at, is_locked';
    // Locked versions sit OUTSIDE the pot of 10 rolling versions, so they must
    // always be returned in addition to the (up to) 10 most-recent unlocked
    // ones — up to 13 rows total (Task #2759). Two queries keep the caps
    // independent; if we simply limited a combined query the locked rows could
    // starve the unlocked rolling window (or vice versa).
    const [{ data: lockedData, error: lockedErr }, { data: unlockedData, error: unlockedErr }] =
      await Promise.all([
        supabase
          .from('canvas_page_version')
          .select(cols)
          .eq('page_id', pageId)
          .eq('tenant_id', tenantId)
          .eq('is_locked', true)
          .order('created_at', { ascending: false }),
        supabase
          .from('canvas_page_version')
          .select(cols)
          .eq('page_id', pageId)
          .eq('tenant_id', tenantId)
          .eq('is_locked', false)
          .order('created_at', { ascending: false })
          .limit(MAX_KEEP),
      ]);
    if (lockedErr || unlockedErr) return res.status(500).json({ error: 'Failed to load versions' });
    // Merge and present newest-first regardless of lock state.
    const versions = [...(lockedData || []), ...(unlockedData || [])]
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    const nameMap = await resolveSaverNames(versions.map((v) => v.created_by), tenantId);
    const withNames = versions.map((v) => ({
      ...v,
      saved_by_name: v.created_by ? (nameMap[v.created_by] || null) : null,
    }));
    return res.status(200).json({ versions: withNames, lockedCount: (lockedData || []).length, maxLocked: MAX_LOCKED });
  }

  if (req.method === 'POST') {
    const restore = req.query.restore === '1';
    const lock = req.query.lock === '1';
    const body = req.body || {};

    if (lock) {
      // Toggle a single version's lock state (Task #2759). Enforces the
      // max-3-locked-per-page cap server-side; the UI mirrors it but the
      // server is the source of truth.
      if (!body.versionId) return res.status(400).json({ error: 'versionId required' });
      const locked = body.locked === true;
      const { data: version, error: vErr } = await supabase
        .from('canvas_page_version')
        .select('id, is_locked')
        .eq('id', body.versionId)
        .eq('page_id', pageId)
        .eq('tenant_id', tenantId)
        .maybeSingle();
      if (vErr) return res.status(500).json({ error: 'Failed to load version' });
      if (!version) return res.status(404).json({ error: 'Version not found' });

      if (locked && !version.is_locked) {
        const { count, error: cErr } = await supabase
          .from('canvas_page_version')
          .select('id', { count: 'exact', head: true })
          .eq('page_id', pageId)
          .eq('tenant_id', tenantId)
          .eq('is_locked', true);
        if (cErr) return res.status(500).json({ error: 'Failed to count locked versions' });
        if ((count || 0) >= MAX_LOCKED) {
          return res.status(409).json({ error: `You can lock at most ${MAX_LOCKED} versions. Unlock one first.` });
        }
      }

      const { data: updated, error: uErr } = await supabase
        .from('canvas_page_version')
        .update({ is_locked: locked })
        .eq('id', body.versionId)
        .eq('page_id', pageId)
        .eq('tenant_id', tenantId)
        .select('id, is_locked')
        .single();
      if (uErr) return res.status(500).json({ error: 'Failed to update lock state' });

      // Unlocking returns the version to the pot of 10, which may push the
      // unlocked count over the limit — prune the oldest unlocked as normal.
      if (!locked) await pruneVersions(pageId, tenantId);

      return res.status(200).json({ version: updated });
    }

    if (restore) {
      if (!body.versionId) return res.status(400).json({ error: 'versionId required' });
      const { data: version, error: vErr } = await supabase
        .from('canvas_page_version')
        .select('id, design')
        .eq('id', body.versionId)
        .eq('page_id', pageId)
        .eq('tenant_id', tenantId)
        .maybeSingle();
      if (vErr) return res.status(500).json({ error: 'Failed to load version' });
      if (!version) return res.status(404).json({ error: 'Version not found' });

      // Snapshot the current design first so the rollback itself is undoable.
      await supabase.from('canvas_page_version').insert({
        page_id: pageId,
        tenant_id: tenantId,
        design: pageCheck.page.canvas_design || { version: 1, root: { sections: [{ id: 'root-section', children: [] }] } },
        label: 'Auto-snapshot before restore',
        source: 'pre-restore',
        created_by: context.memberId || null,
      });
      // Keep history within the retention limit after the pre-restore snapshot.
      await pruneVersions(pageId, tenantId);

      const { data: updated, error: uErr } = await supabase
        .from('i_edit_page')
        .update({ canvas_design: version.design })
        .eq('id', pageId)
        .eq('tenant_id', tenantId)
        .select('id, canvas_design')
        .single();
      if (uErr) return res.status(500).json({ error: 'Failed to restore version' });
      return res.status(200).json({ page: updated });
    }

    // Plain snapshot — captures the current page design with a label.
    const design = body.design ?? pageCheck.page.canvas_design;
    if (!design || typeof design !== 'object') {
      return res.status(400).json({ error: 'No design to snapshot' });
    }
    const { data, error } = await supabase
      .from('canvas_page_version')
      .insert({
        page_id: pageId,
        tenant_id: tenantId,
        design,
        label: body.label || null,
        source: body.source || 'manual',
        created_by: context.memberId || null,
      })
      .select('id, label, source, created_at, created_by')
      .single();
    if (error) return res.status(500).json({ error: 'Failed to snapshot version' });

    // Trim history beyond MAX_KEEP to keep the table tidy.
    await pruneVersions(pageId, tenantId);

    return res.status(201).json({ version: data });
  }

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'Method not allowed' });
}
