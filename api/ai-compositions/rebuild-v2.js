// AI Design Studio V2 — Phase 5 "Rebuild with the new renderer" (Task #2909).
//
// GET /api/ai-compositions/rebuild-v2?compositionId=… → the stored V1
// generation context (brief, direction, creativity, style reference, page)
// so the client can seed a brand-new V2 generation from it.
//
// ADMIN-ONLY and strictly read-only over the V1 record: rebuilding NEVER
// mutates or deletes the V1 composition — the client starts a normal
// /generate-v2 run (user reviews + inserts explicitly, never automatic).
// 404 (not 403) on missing access so composition existence never leaks.

import { supabase } from '../_lib/database.js';
import { getTenantContext, hasAdminAccess } from '../_lib/tenantContext.js';

// Walk the V1 scene-graph document and pull out the durable content the V2
// rebuild must preserve: copy (headings/paragraphs/labels), links, protected
// values and generated/library imagery. Everything is read-only over V1.
function extractV1Content(doc) {
  const copy = [];
  const links = [];
  const walk = (el) => {
    if (!el || typeof el !== 'object') return;
    const text = el.content?.text || el.content?.label || null;
    const html = el.content?.html || null;
    if (text || html) {
      copy.push({
        elementId: el.id,
        type: el.type,
        role: el.content?.role || null,
        text: text || String(html).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
      });
    }
    if (el.link) links.push({ elementId: el.id, link: el.link, label: text || null });
    (el.children || []).forEach(walk);
  };
  (doc?.sections || []).forEach((s) => (s.elements || []).forEach(walk));
  return {
    sections: (doc?.sections || []).map((s) => ({ id: s.id, name: s.name || null, type: s.type || null })),
    copy: copy.slice(0, 120),
    links: links.slice(0, 60),
    protectedValues: doc?.protectedValues || [],
    assets: (doc?.generatedAssets || []).map((a) => ({
      elementId: a.elementId || null,
      fileRepositoryId: a.fileRepositoryId || null,
      url: a.url || null,
      alt: a.altText || a.alt || null,
    })),
  };
}

export default async function handler(req, res) {
  if (!supabase) return res.status(503).json({ error: 'Database not configured' });
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  let context;
  try { context = await getTenantContext(req); }
  catch { return res.status(500).json({ error: 'Failed to resolve tenant context' }); }
  if (!context?.tenantId) return res.status(403).json({ error: 'Tenant context required' });
  if (!context.isAuthenticated) return res.status(404).json({ error: 'Not found' });
  if (!(await hasAdminAccess(context))) return res.status(404).json({ error: 'Not found' });
  const tenantId = context.tenantId;

  const compositionId = req.query?.compositionId;
  if (!compositionId || typeof compositionId !== 'string') {
    return res.status(400).json({ error: 'compositionId required' });
  }

  const { data: comp } = await supabase
    .from('ai_composition')
    .select('id, tenant_id, page_id, name, composition_type, renderer_version, current_version_id')
    .eq('id', compositionId)
    .eq('tenant_id', tenantId)
    .maybeSingle();
  if (!comp) return res.status(404).json({ error: 'Not found' });
  if (comp.renderer_version === 2) {
    return res.status(400).json({ error: 'This composition already uses the new renderer.' });
  }

  // Original generation context: the most recent completed generation job for
  // this composition carries the brief + options the user actually ran with.
  const [{ data: jobs }, { data: version }, { data: convo }] = await Promise.all([
    supabase
      .from('ai_composition_job')
      .select('id, brief, options, created_at')
      .eq('tenant_id', tenantId)
      .eq('composition_id', comp.id)
      .order('created_at', { ascending: false })
      .limit(5),
    comp.current_version_id
      ? supabase
          .from('ai_composition_version')
          .select('id, document')
          .eq('id', comp.current_version_id)
          .eq('tenant_id', tenantId)
          .maybeSingle()
      : Promise.resolve({ data: null }),
    supabase
      .from('ai_composition_conversation')
      .select('instruction, summary, kind, status, created_at')
      .eq('tenant_id', tenantId)
      .eq('composition_id', comp.id)
      .order('created_at', { ascending: false })
      .limit(20),
  ]);
  const job = (jobs || []).find((j) => j?.brief) || null;

  // Fallback brief when no job survives (pruned/legacy imports): rebuild from
  // what we know about the composition itself so the field is never empty.
  const opts = job?.options || {};
  const brief = job?.brief
    || `Rebuild the existing "${comp.name || 'AI section'}" design with the same content and purpose.`;

  // Full V1 context for a faithful rebuild: current-document copy, links,
  // protected values + assets, reference analysis (stored on the job options)
  // and the edit-conversation history (what the user asked for over time).
  const content = version?.document ? extractV1Content(version.document) : null;
  const conversation = (convo || [])
    .filter((c) => c?.instruction)
    .reverse()
    .map((c) => ({
      instruction: c.instruction,
      summary: c.summary || null,
      kind: c.kind || null,
      status: c.status || null,
    }));

  return res.status(200).json({
    composition: {
      id: comp.id,
      name: comp.name,
      pageId: comp.page_id,
      compositionType: comp.composition_type === 'page' ? 'page_body' : 'section',
      rendererVersion: comp.renderer_version,
    },
    seed: {
      brief,
      briefFromJob: !!job?.brief,
      direction: opts.direction || null,
      creativity: opts.creativity || 'brand_led',
      styleReference: opts.styleReference || null,
      referenceAnalysis: opts.referenceAnalysis || null,
      content,
      conversation,
    },
  });
}
