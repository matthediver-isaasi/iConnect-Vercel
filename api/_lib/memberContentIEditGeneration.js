// Canonical element-page snapshots. No page search_text or arbitrary config is
// accepted as evidence. Database generation invalidation fences every selected
// dependency; live resolution independently checks selection and audience.
import crypto from 'node:crypto';
import { extractIEditElement } from './memberContentIEditExtraction.js';
import { resolveIEditDynamic } from './memberContentIEditDynamic.js';
import { PUBLIC_CANVAS_LAYOUT_TYPES } from './memberContentVisibility.js';

export const IEDIT_PAGE_COLUMNS = 'id,tenant_id,title,slug,status,layout_type,builder_type,microsite_id';
const MAX_ELEMENTS = 500;
const PAGE_SIZE = 100;
const MAX_CHARS = 1500;

export function isIndexableIEditPage(page) {
  return page?.builder_type === 'iedit' && page.status === 'published' &&
    (PUBLIC_CANVAS_LAYOUT_TYPES.includes(page.layout_type) || page.layout_type === 'member');
}

function digest(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function bounded(query, budget) {
  if (budget.remaining-- <= 0 || Date.now() >= budget.deadlineMs) throw new Error('IEDIT_READ_BUDGET');
  return typeof query.abortSignal === 'function'
    ? query.abortSignal(AbortSignal.timeout(Math.max(1, Math.min(5000, budget.deadlineMs - Date.now()))))
    : query;
}

async function readElements(supabase, tenantId, pageId, budget) {
  const elements = [];
  let expected;
  for (let offset = 0; offset <= MAX_ELEMENTS; offset += PAGE_SIZE) {
    const { data, error, count } = await bounded(supabase.from('i_edit_page_element')
      .select('id,page_id,tenant_id,element_type,display_order,content,settings', { count: 'exact' })
      .eq('tenant_id', tenantId).eq('page_id', pageId)
      .order('display_order', { ascending: true }).order('id', { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1), budget);
    if (error) throw error;
    if (!Array.isArray(data) || !Number.isInteger(count) || count > MAX_ELEMENTS ||
        (expected !== undefined && expected !== count)) {
      throw new Error('IEDIT_ELEMENTS_INCOMPLETE: element count changed or exceeded the limit');
    }
    expected = count;
    elements.push(...data);
    if (new Set(elements.map(e => e.id)).size !== elements.length) throw new Error('IEDIT_ELEMENTS_UNSTABLE');
    if (elements.length === count) return elements;
    if (data.length !== PAGE_SIZE || elements.length > count) throw new Error('IEDIT_ELEMENTS_INCOMPLETE');
  }
  throw new Error('IEDIT_ELEMENTS_LIMIT');
}

function pieces(text, maxChars = MAX_CHARS) {
  const result = [];
  let rest = text.trim();
  while (rest.length > maxChars) {
    let end = rest.lastIndexOf('\n', maxChars);
    if (end < maxChars / 2) end = rest.lastIndexOf(' ', maxChars);
    if (end < maxChars / 2) end = maxChars;
    result.push(rest.slice(0, end).trim());
    rest = rest.slice(end).trim();
  }
  if (rest) result.push(rest);
  return result;
}

export async function buildIEditGenerationSnapshot({
  supabase, tenantId, sourceId, claim, visibilityCtx = null,
  extract = extractIEditElement, resolveDynamic = resolveIEditDynamic,
  readBudget = { remaining: 200, deadlineMs: Date.now() + 25000 },
} = {}) {
  if (!supabase || !tenantId || !sourceId || !Number.isSafeInteger(Number(claim?.generation)) ||
      Number(claim.generation) < 1) throw new Error('IEDIT_CLAIM_REQUIRED');
  const empty = { item: null, chunks: [], coverage: [], dependencies: [] };
  const { data: page, error } = await bounded(supabase.from('i_edit_page')
    .select(IEDIT_PAGE_COLUMNS).eq('tenant_id', tenantId).eq('id', sourceId)
    .eq('builder_type', 'iedit').maybeSingle(), readBudget);
  if (error) throw error;
  if (!isIndexableIEditPage(page)) return empty;
  if (visibilityCtx && page.layout_type === 'member' && visibilityCtx.isAuthenticated !== true) return empty;
  let prefix = null;
  if (page.microsite_id) {
    const { data: site, error: siteError } = await bounded(supabase.from('microsite')
      .select('id,path_prefix,is_active').eq('tenant_id', tenantId)
      .eq('id', page.microsite_id).eq('is_active', true).maybeSingle(), readBudget);
    if (siteError) throw siteError;
    if (!site?.path_prefix) return empty;
    prefix = site.path_prefix;
  }
  const elements = await readElements(supabase, tenantId, page.id, readBudget);
  const chunks = [], coverage = [];
  const append = (section, element, context = '') => {
    const scope = page.layout_type === 'member' || section.accessScope === 'authenticated' ? 'authenticated' : 'public';
    if (visibilityCtx && scope === 'authenticated' && visibilityCtx.isAuthenticated !== true) return;
    const displayDependencies = (section.provenance?.dependencies || []).map(({ table, id, tenantId: owner }) => ({
      table, id, tenantId: owner,
    }));
    // Identity, order and source selection remain significant even if two
    // different records happen to have identical visible text.
    const sectionKey = digest({ elementId: element?.id || null, order: element?.display_order ?? null,
      text: section.text, context, scope, displayDependencies });
    const heading = [...new Set([page.title, context].filter(Boolean))].join('\n').slice(0, 500);
    const body = section.text === heading ? '' : section.text;
    const segments = body ? pieces(body, MAX_CHARS - heading.length - 2) : [''];
    for (const segment of segments) {
      // Repeat authored section context on continuation chunks, not just the
      // first paragraph of a long section.
      const content = [heading, segment].filter(Boolean).join('\n\n');
      chunks.push({
        chunkIndex: chunks.length, content, accessScope: scope,
        provenance: { kind: 'knowledge', adapter: 'iedit_page', dependencies: [],
          iedit: { sectionKey, contentHash: digest(content), elementId: element?.id || null, displayDependencies } },
      });
    }
  };
  if (page.title) append({ text: page.title }, null);
  for (const element of elements) {
    if (Date.now() >= readBudget.deadlineMs) throw new Error('IEDIT_READ_BUDGET: page resolution timed out');
    const authored = extract(element); // unknown renderer fails whole source
    const context = authored.sections.map(s => s.text).filter(Boolean).join('\n').slice(0, 500);
    for (const section of authored.sections) append(section, element);
    if (authored.dynamic) {
      const dynamic = await resolveDynamic({ supabase, tenantId, element, visibilityCtx, readBudget });
      for (const section of dynamic.sections) append(section, element, context);
      coverage.push(...dynamic.coverage);
    }
    coverage.push({ elementId: element.id, elementType: element.element_type,
      code: 'extraction_policy_applied', authoredSections: authored.sections.length, dynamic: authored.dynamic });
  }
  // Include the extraction report in source provenance, not embedding text.
  // Publication remains all-or-nothing if any loader failed or exceeded limits.
  const metadata = {
    tenant_id: tenantId, content_type: 'iedit_page', source_id: page.id,
    title: page.title || '(untitled)', slug: page.slug || null, status: page.status,
    layout_type: page.layout_type, microsite_id: page.microsite_id ?? null,
    feature_key: null, access_scope: page.layout_type === 'member' ? 'authenticated' : 'public',
    link: page.slug ? `${prefix ? `/${encodeURIComponent(prefix)}` : ''}/${encodeURIComponent(page.slug)}` : null,
  };
  for (const chunk of chunks) chunk.provenance.iedit.coverage = coverage;
  return { item: { ...page, _micrositePrefix: prefix }, chunks, metadata, coverage, dependencies: [] };
}

export function isCurrentIEditChunk(candidate, snapshot) {
  const proof = candidate?.provenance?.iedit;
  if (!proof?.sectionKey || !proof.contentHash || !snapshot?.item) return false;
  if (candidate.content != null && digest(candidate.content) !== proof.contentHash) return false;
  return snapshot.chunks.some(chunk =>
    chunk.provenance.iedit.sectionKey === proof.sectionKey &&
    chunk.provenance.iedit.contentHash === proof.contentHash &&
    // A signed page citation can combine public and protected supporting
    // chunks; its source-level scope is then authenticated for all supports.
    // That may narrow a public section, never broaden a protected section.
    (chunk.accessScope === 'public' || candidate.access_scope === 'authenticated'));
}
