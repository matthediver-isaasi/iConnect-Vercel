// Task #2363: Member AI Knowledge Assistant — indexing pipeline.
//
// Chunks member-facing content (resources, events, complex_events, news_post,
// blog_post), embeds new/changed chunks, and upserts them into
// member_content_chunk with the visibility metadata the ask endpoint re-checks
// at retrieval time. Shared by:
//   - scripts/reindex-member-content.mjs      (backfill / bulk re-index)
//   - api/cron/reindex-member-content.js      (nightly reconcile)
//   - api/_lib/memberContentReindexHook.js    (re-index on save / delete)
//
// Clients (supabase, openai) are injected so scripts can target DEST directly
// while serverless endpoints use the server-scoped clients. Reuses the exact
// key resolution + embedding model as the Help pipeline.

import crypto from 'node:crypto';
import { chunkMemberContent } from './memberContentChunker.js';
import { getDefaultOpenAIClient, embedTexts, EMBEDDING_MODEL } from './helpArticleIndexer.js';
import { CONTENT_TYPES, PUBLIC_CANVAS_LAYOUT_TYPES } from './memberContentVisibility.js';
import { collectCanvasSymbolIds } from '../../client/src/lib/canvasText.js';
import { isPublicSimpleEventStatus } from '../../shared/eventTiming.js';

export { getDefaultOpenAIClient, EMBEDDING_MODEL };

// Per-type config: the source table, its RBAC feature key, and the columns we
// need to build text + visibility metadata.
export const CONTENT_TYPE_CONFIG = {
  resource: {
    table: 'resource',
    feature: 'content.resources',
    columns:
      'id, tenant_id, title, description, resource_type, author_name, tags, subcategories, status, member_group_id, allowed_role_ids, is_public, linked_events',
  },
  event: {
    table: 'event',
    feature: 'events.browse-events',
    columns:
      'id, tenant_id, title, slug, summary, description, location, start_date, event_type, is_online, status, event_state, member_group_id, group_event_public',
  },
  complex_event: {
    table: 'complex_event',
    feature: 'events.browse-events',
    columns:
      'id, tenant_id, title, slug, summary, description, location, start_date, event_type, is_online, status, event_state, member_group_id, group_event_public',
  },
  news_post: {
    table: 'news_post',
    feature: 'content.news',
    columns:
      'id, tenant_id, title, slug, summary, content, author_name, tags, status, published_date',
  },
  blog_post: {
    table: 'blog_post',
    feature: 'content.articles',
    columns:
      'id, tenant_id, title, slug, summary, content, tags, status, published_date',
  },
  canvas_page: {
    table: 'i_edit_page',
    // Public-facing content: no member RBAC feature gates page viewing.
    feature: null,
    columns:
      'id, tenant_id, title, slug, canvas_design, status, layout_type, builder_type',
    // Only Canvas Builder pages (never legacy iEdit element pages) are indexed;
    // applied to every generic fetch / existence check for this type.
    filterEq: { builder_type: 'canvas' },
  },
};

function hashChunk(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * In-portal route to a source row, used to render clickable citations.
 * Mirrors the routes the portal global search links to.
 */
export function buildMemberContentLink(contentType, item) {
  const id = item.id;
  const slug = item.slug;
  switch (contentType) {
    case 'resource':
      return `/Resources?resourceId=${id}`;
    case 'event':
      return `/EventDetails?id=${id}`;
    case 'complex_event':
      return slug ? `/session-events/${slug}` : `/session-events/${id}`;
    case 'news_post':
      return `/NewsView?slug=${encodeURIComponent(slug || id)}`;
    case 'blog_post':
      return `/ArticleView?slug=${encodeURIComponent(slug || id)}`;
    case 'canvas_page':
      // Canvas Builder pages render at the tenant-root slug via DynamicPage.
      return slug ? `/${slug}` : null;
    default:
      return null;
  }
}

/**
 * Whether a source row is currently INDEXABLE (has a visible status). Non-
 * indexable rows get their chunks deleted so drafts/archived content can never
 * surface in AI answers. published_date being in the future is intentionally
 * NOT excluded here (it's still "published"); the ask endpoint enforces the
 * <= now check so scheduled posts index ahead of time without re-surfacing.
 */
export function isIndexable(contentType, item) {
  if (!item) return false;
  switch (contentType) {
    case 'resource':
      // Public/browse rules also hide resources tied to events.
      if (
        Array.isArray(item.linked_events) &&
        item.linked_events.length > 0
      ) {
        return false;
      }
      return item.status === 'active';
    case 'event':
      return isPublicSimpleEventStatus(item.status) && item.event_state !== 'draft';
    case 'complex_event':
      // complex events: immutable allowlist — no 'immediate'
      return ['published', 'tbc'].includes(item.status) && item.event_state !== 'draft';
    case 'news_post':
      return item.status === 'published';
    case 'blog_post':
      return item.status === 'published';
    case 'canvas_page':
      // Mirror the public page renderer: Canvas Builder page, published, and a
      // publicly-viewable layout_type. 'member'-only pages are never indexed.
      return (
        item.builder_type === 'canvas' &&
        item.status === 'published' &&
        PUBLIC_CANVAS_LAYOUT_TYPES.includes(item.layout_type)
      );
    default:
      return false;
  }
}

function buildMetadata(contentType, item) {
  const cfg = CONTENT_TYPE_CONFIG[contentType];
  return {
    tenant_id: item.tenant_id,
    content_type: contentType,
    source_id: item.id,
    slug: item.slug || null,
    title: item.title || '(untitled)',
    link: buildMemberContentLink(contentType, item),
    status: item.status || null,
    event_state: item.event_state ?? null,
    member_group_id: item.member_group_id ?? null,
    group_event_public: item.group_event_public ?? null,
    allowed_role_ids: Array.isArray(item.allowed_role_ids)
      ? item.allowed_role_ids
      : null,
    is_public: item.is_public ?? null,
    published_date: item.published_date ?? null,
    start_date: item.start_date ?? null,
    feature_key: cfg?.feature || null,
  };
}

/**
 * Canvas pages resolve referenced symbols at render time; the chunker's text
 * extraction needs those symbol designs to capture text a member would see.
 * Fetch the (top-level) referenced symbol designs and stash them on the item so
 * buildMemberContentText can resolve them. Best-effort scope matches the public
 * page endpoint: only symbols used by THIS page, within the same tenant.
 */
async function attachCanvasSymbols(item, supabase) {
  item.__symbols = {};
  if (!item?.canvas_design || !item?.tenant_id) return;
  const ids = collectCanvasSymbolIds(item.canvas_design);
  if (ids.size === 0) return;
  const { data, error } = await supabase
    .from('canvas_symbol')
    .select('id, design')
    .eq('tenant_id', item.tenant_id)
    .in('id', Array.from(ids));
  if (error) throw error;
  const map = {};
  for (const row of data || []) map[row.id] = row;
  item.__symbols = map;
}

export async function deleteMemberContentChunks(contentType, sourceId, { supabase, tenantId = null } = {}) {
  let query = supabase
    .from('member_content_chunk')
    .delete()
    .eq('content_type', contentType)
    .eq('source_id', sourceId);
  if (tenantId) query = query.eq('tenant_id', tenantId);
  const { error } = await query;
  if (error) throw error;
}

/**
 * Reconcile the index against reality: drop every member_content_chunk row whose
 * source row no longer exists (hard-deleted outside the on-save hooks — e.g. the
 * multi-step event deletion flow). member_content_chunk is polymorphic
 * (content_type + source_id) with no FK cascade, so nothing purges these
 * automatically. Retrieval IS the security boundary, so an orphaned chunk that
 * still passes the visibility check would let the assistant cite content that no
 * longer exists — this sweep closes that window.
 *
 * @param {object} deps { supabase, tenantId?, contentType? }
 * @returns {Promise<object>} per-type orphan removal counts
 */
export async function sweepOrphanedMemberContentChunks({ supabase, tenantId = null, contentType = null } = {}) {
  if (!supabase) throw new Error('sweepOrphanedMemberContentChunks requires a supabase client');

  const types = contentType ? [contentType] : CONTENT_TYPES;
  const summary = { removedChunks: 0, removedSources: 0, byType: {} };
  const PAGE = 1000;

  for (const type of types) {
    const cfg = CONTENT_TYPE_CONFIG[type];
    if (!cfg) continue;

    // 1. Collect every source_id currently represented in the index for this type.
    const chunkSourceIds = new Set();
    let from = 0;
    for (;;) {
      let q = supabase
        .from('member_content_chunk')
        .select('source_id')
        .eq('content_type', type)
        .order('source_id', { ascending: true })
        .range(from, from + PAGE - 1);
      if (tenantId) q = q.eq('tenant_id', tenantId);
      const { data, error } = await q;
      if (error) throw error;
      if (!data || data.length === 0) break;
      for (const r of data) if (r.source_id) chunkSourceIds.add(r.source_id);
      if (data.length < PAGE) break;
      from += PAGE;
    }

    let removedChunks = 0;
    let removedSources = 0;

    if (chunkSourceIds.size > 0) {
      // 2. Of those, find which source ids still exist in the source table.
      const existing = new Set();
      const ids = [...chunkSourceIds];
      const BATCH = 200;
      for (let i = 0; i < ids.length; i += BATCH) {
        const batch = ids.slice(i, i + BATCH);
        let sq = supabase.from(cfg.table).select('id').in('id', batch);
        if (tenantId) sq = sq.eq('tenant_id', tenantId);
        if (cfg.filterEq) {
          for (const [k, v] of Object.entries(cfg.filterEq)) sq = sq.eq(k, v);
        }
        const { data, error } = await sq;
        if (error) throw error;
        for (const r of data || []) existing.add(r.id);
      }

      // 3. Delete chunks for source ids that no longer exist.
      const orphans = ids.filter((id) => !existing.has(id));
      for (const orphanId of orphans) {
        const delQuery = supabase
          .from('member_content_chunk')
          .delete({ count: 'exact' })
          .eq('content_type', type)
          .eq('source_id', orphanId);
        const scoped = tenantId ? delQuery.eq('tenant_id', tenantId) : delQuery;
        const { error, count } = await scoped;
        if (error) throw error;
        removedSources += 1;
        removedChunks += count || 0;
      }
    }

    summary.byType[type] = { removedChunks, removedSources };
    summary.removedChunks += removedChunks;
    summary.removedSources += removedSources;
  }

  return summary;
}

/**
 * Re-index a single source row.
 *
 * @param {string} contentType
 * @param {object} item        source row (must include tenant_id + id)
 * @param {object} deps        { supabase, openai }
 * @returns {Promise<object>}  summary
 */
export async function reindexMemberContentItem(contentType, item, { supabase, openai } = {}) {
  if (!supabase) throw new Error('reindexMemberContentItem requires a supabase client');
  if (!CONTENT_TYPE_CONFIG[contentType]) {
    throw new Error(`Unknown content type: ${contentType}`);
  }
  const sourceId = item?.id;
  if (!sourceId) throw new Error('reindexMemberContentItem requires item.id');

  if (!isIndexable(contentType, item)) {
    await deleteMemberContentChunks(contentType, sourceId, { supabase });
    return { contentType, sourceId, chunks: 0, embedded: 0, reused: 0, removed: true };
  }

  if (contentType === 'canvas_page') {
    await attachCanvasSymbols(item, supabase);
  }

  const built = chunkMemberContent(item, contentType);
  if (!built.length) {
    await deleteMemberContentChunks(contentType, sourceId, { supabase });
    return { contentType, sourceId, chunks: 0, embedded: 0, reused: 0, removed: true };
  }

  const meta = buildMetadata(contentType, item);

  const { data: existing, error: exErr } = await supabase
    .from('member_content_chunk')
    .select('chunk_index, content_hash, embedding')
    .eq('content_type', contentType)
    .eq('source_id', sourceId);
  if (exErr) throw exErr;
  const existingByIdx = new Map((existing || []).map((r) => [r.chunk_index, r]));

  const rows = [];
  const toEmbedIdx = [];
  const toEmbedInput = [];
  const nowIso = new Date().toISOString();

  for (const ch of built) {
    const hash = hashChunk(ch.content);
    const prev = existingByIdx.get(ch.chunkIndex);
    const reuse = prev && prev.content_hash === hash && prev.embedding != null;

    const row = {
      ...meta,
      chunk_index: ch.chunkIndex,
      content: ch.content,
      content_hash: hash,
      updated_at: nowIso,
    };

    if (reuse) {
      row.embedding = prev.embedding;
    } else {
      toEmbedIdx.push(ch.chunkIndex);
      toEmbedInput.push(`${meta.title}\n\n${ch.content}`);
    }
    rows.push(row);
  }

  let embedded = 0;
  if (toEmbedInput.length) {
    if (!openai) {
      throw new Error('reindexMemberContentItem needs an OpenAI client to embed new/changed chunks');
    }
    const embeddings = await embedTexts(openai, toEmbedInput);
    toEmbedIdx.forEach((idx, k) => {
      const row = rows.find((r) => r.chunk_index === idx);
      row.embedding = embeddings[k];
    });
    embedded = embeddings.length;
  }

  // Remove now-stale trailing chunks (content shrank), then upsert.
  const { error: delErr } = await supabase
    .from('member_content_chunk')
    .delete()
    .eq('content_type', contentType)
    .eq('source_id', sourceId)
    .gte('chunk_index', built.length);
  if (delErr) throw delErr;

  const { error: upErr } = await supabase
    .from('member_content_chunk')
    .upsert(rows, { onConflict: 'content_type,source_id,chunk_index' });
  if (upErr) throw upErr;

  return {
    contentType,
    sourceId,
    chunks: rows.length,
    embedded,
    reused: rows.length - embedded,
    removed: false,
  };
}

/**
 * Re-index every INDEXABLE source row, optionally scoped to a single tenant
 * and/or content type. Requires an OpenAI client to embed new/changed chunks.
 *
 * Resumable / time-budgeted so the Vercel cron never times out on large
 * tenants (functions are capped at 60s). Pass `deadlineMs` (an absolute
 * `Date.now()` epoch) to stop starting new work once the budget is spent, and
 * `cursor` to resume where the previous slice stopped. When the pass is not
 * finished the return value carries `done: false` and a `nextCursor` the caller
 * feeds back in to continue; when everything (including the orphan sweep) is
 * complete it returns `done: true` and `nextCursor: null`.
 *
 * Cursor shapes:
 *   { type, lastId }   — still indexing `type`, resume from id > lastId.
 *   { phase: 'sweep' } — indexing done, only the orphan sweep remains.
 *
 * Indexing uses keyset pagination (id > lastId) rather than offset ranges so a
 * slice can resume mid-type across invocations without a stable offset (rows
 * can appear/disappear between slices). Re-indexing is idempotent (unchanged
 * chunks reuse their embedding), so a dropped/restarted chain still makes
 * progress off the persisted chunk state.
 */
export async function reindexAllMemberContent({
  supabase,
  openai,
  tenantId = null,
  contentType = null,
  deadlineMs = null,
  cursor = null,
} = {}) {
  if (!supabase) throw new Error('reindexAllMemberContent requires a supabase client');

  const allTypes = contentType ? [contentType] : CONTENT_TYPES;
  const results = {
    items: 0,
    chunks: 0,
    embedded: 0,
    reused: 0,
    removed: 0,
    errors: 0,
    details: [],
  };

  const overBudget = () => deadlineMs != null && Date.now() >= deadlineMs;

  // Resume state derived from the incoming cursor.
  const startInSweep = cursor?.phase === 'sweep';
  const resumeType = !startInSweep && cursor?.type ? cursor.type : null;
  const resumeAfterId = !startInSweep && cursor ? (cursor.lastId ?? null) : null;

  if (!startInSweep) {
    const startIdx = resumeType ? allTypes.indexOf(resumeType) : 0;
    const typesToRun = startIdx >= 0 ? allTypes.slice(startIdx) : allTypes;

    for (let ti = 0; ti < typesToRun.length; ti++) {
      const type = typesToRun[ti];
      const cfg = CONTENT_TYPE_CONFIG[type];
      if (!cfg) continue;

      const PAGE = 500;
      // Only the first (resumed) type inherits the incoming lastId; later types
      // start from the beginning.
      let lastId = ti === 0 && resumeType === type ? resumeAfterId : null;

      for (;;) {
        if (overBudget()) {
          return { ...results, nextCursor: { type, lastId }, done: false };
        }

        let query = supabase
          .from(cfg.table)
          .select(cfg.columns)
          .order('id', { ascending: true })
          .limit(PAGE);
        if (tenantId) query = query.eq('tenant_id', tenantId);
        if (cfg.filterEq) {
          for (const [k, v] of Object.entries(cfg.filterEq)) query = query.eq(k, v);
        }
        if (lastId != null) query = query.gt('id', lastId);

        const { data: rows, error } = await query;
        if (error) throw error;
        if (!rows || rows.length === 0) break;

        for (const item of rows) {
          try {
            const summary = await reindexMemberContentItem(type, item, { supabase, openai });
            results.items++;
            results.chunks += summary.chunks;
            results.embedded += summary.embedded;
            results.reused += summary.reused;
            if (summary.removed) results.removed++;
          } catch (err) {
            results.errors++;
            results.details.push({
              contentType: type,
              sourceId: item.id,
              error: err?.message || String(err),
            });
            console.error(
              `[reindexAllMemberContent] ${type}/${item.id} error:`,
              err?.message || err
            );
          }
          lastId = item.id;
          if (overBudget()) {
            return { ...results, nextCursor: { type, lastId }, done: false };
          }
        }

        if (rows.length < PAGE) break;
      }
    }

    // Indexing complete for the scoped pass. Hand the orphan sweep its own slice
    // if the budget is already spent, so a large index pass never crowds it out.
    if (overBudget()) {
      return { ...results, nextCursor: { phase: 'sweep' }, done: false };
    }
  }

  // Reconcile: purge chunks whose source row was hard-deleted outside the
  // on-save hooks (retrieval is the security boundary — stale chunks must go).
  try {
    const swept = await sweepOrphanedMemberContentChunks({ supabase, tenantId, contentType });
    results.orphansRemoved = swept.removedSources;
    results.orphanChunksRemoved = swept.removedChunks;
    results.removed += swept.removedSources;
  } catch (err) {
    results.errors++;
    results.details.push({ contentType: 'orphan-sweep', sourceId: null, error: err?.message || String(err) });
    console.error('[reindexAllMemberContent] orphan sweep error:', err?.message || err);
  }

  return { ...results, nextCursor: null, done: true };
}
