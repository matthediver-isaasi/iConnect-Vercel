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

import { chunkMemberContent } from './memberContentChunker.js';
import { getDefaultOpenAIClient, EMBEDDING_MODEL } from './helpArticleIndexer.js';
import { CONTENT_TYPES, PUBLIC_CANVAS_LAYOUT_TYPES } from './memberContentVisibility.js';
import { isPublicSimpleEventStatus } from '../../shared/eventTiming.js';
import { writeMemberContentGeneration } from './memberContentGenerationWriter.js';
import {
  sweepMemberContentGenerationTombstones,
  deleteMemberContentGenerationTombstone,
} from './memberContentGenerationTombstones.js';
import { buildCanvasGenerationSnapshot } from './memberContentCanvasGeneration.js';

export { getDefaultOpenAIClient, EMBEDDING_MODEL };

// Per-type config: the source table, its RBAC feature key, and the columns we
// need to build text + visibility metadata.
export const CONTENT_TYPE_CONFIG = {
  resource: {
    table: 'resource',
    feature: 'content.resources',
    columns:
      'id, tenant_id, title, description, target_url, resource_type, author_name, tags, subcategories, status, member_group_id, allowed_role_ids, is_public, linked_events',
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
      'id, tenant_id, title, slug, canvas_design, status, layout_type, builder_type, microsite_id',
    // Only Canvas Builder pages (never legacy iEdit element pages) are indexed;
    // applied to every generic fetch / existence check for this type.
    filterEq: { builder_type: 'canvas' },
  },
};

const MAX_RESOURCE_PDF_BYTES = 10 * 1024 * 1024;
const MAX_RESOURCE_PDF_PAGES = 40;
const MAX_RESOURCE_PDF_PAGE_CHARS = 6000;
const RESOURCE_PDF_TIMEOUT_MS = 12_000;

function pdfIndexError(code) {
  const error = new Error(`Resource PDF could not be indexed: ${code}`);
  error.code = code;
  return error;
}

// Read incrementally: arrayBuffer()/blob() allocate the entire remote object
// before checking its length, so a false Content-Length bypasses a memory cap.
export async function readBoundedPdfStream(stream, {
  maxBytes = MAX_RESOURCE_PDF_BYTES,
  signal = AbortSignal.timeout(RESOURCE_PDF_TIMEOUT_MS),
} = {}) {
  if (!stream?.getReader) throw pdfIndexError('PDF_MISSING_BODY');
  const reader = stream.getReader();
  const parts = [];
  let size = 0;
  const cancel = () => { reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    for (;;) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw pdfIndexError('PDF_SIZE_LIMIT');
      parts.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
    return bytes;
  } finally {
    signal.removeEventListener('abort', cancel);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function downloadPdfStream(bucket, path, signal) {
  const pending = Promise.resolve(bucket.download(path).asStream());
  // The storage SDK does not accept an AbortSignal for download headers.
  // Bound waiting, and cancel a late response rather than consume its bytes.
  let abort;
  const stopped = new Promise((_, reject) => {
    abort = () => reject(pdfIndexError('PDF_DOWNLOAD_TIMEOUT'));
    signal.addEventListener('abort', abort, { once: true });
  });
  pending.then(({ data }) => {
    if (signal.aborted) data?.cancel().catch(() => {});
  }, () => {});
  try {
    signal.throwIfAborted();
    return await Promise.race([pending, stopped]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

/**
 * Only index a PDF when it is a tenant-owned media-library object. Resource
 * target_url can also be an iframe, a form route, or an arbitrary external
 * link; fetching those would create an SSRF boundary and prove no file access.
 */
export function isTrustedTenantStoragePdf(targetUrl, file, storageUrl = process.env.SUPABASE_URL) {
  if (!targetUrl || !file || file.file_url !== targetUrl) return false;
  const filename = String(file.file_name || targetUrl).toLowerCase();
  const declaredType = String(file.file_type || file.mime_type || '').toLowerCase();
  if (!filename.endsWith('.pdf') && declaredType !== 'pdf' && declaredType !== 'application/pdf') {
    return false;
  }
  // Private repository files are represented by our secure-url route. The
  // bytes are fetched through the service client from the exact recorded
  // bucket/path below — never by dereferencing a caller-provided URL.
  if (file.bucket && file.storage_path && targetUrl.startsWith('/api/storage/secure-url?')) {
    try {
      const reference = new URL(targetUrl, 'https://portal.local');
      return (
        reference.origin === 'https://portal.local' &&
        reference.pathname === '/api/storage/secure-url' &&
        reference.searchParams.get('bucket') === file.bucket &&
        reference.searchParams.get('path') === file.storage_path
      );
    } catch {
      return false;
    }
  }
  try {
    const target = new URL(targetUrl);
    const storage = new URL(storageUrl || 'https://invalid.local');
    const publicObject = target.pathname.match(/^\/storage\/v1\/object\/public\/([^/]+)\/(.+)$/);
    if (!publicObject) return false;
    // Public repository records also carry bucket/storage_path. They are not
    // private secure-url references: validate their exact stored object instead
    // of rejecting every migrated public PDF with storage metadata.
    if (file.bucket && decodeURIComponent(publicObject[1]) !== file.bucket) return false;
    if (file.storage_path && decodeURIComponent(publicObject[2]) !== file.storage_path) return false;
    return (
      target.protocol === 'https:' &&
      target.username === '' &&
      target.password === '' &&
      target.search === '' &&
      target.hash === '' &&
      target.origin === storage.origin &&
      !decodeURIComponent(publicObject[2]).split('/').some((part) => part === '..' || part === '.')
    );
  } catch {
    return false;
  }
}

function normalizeGeneration(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value)) return Number(value);
  return null;
}

/**
 * Dependency records are versioned by the same registry as primary content.
 * We persist only ids/generations, never file paths or private URLs. Missing
 * registry rows deliberately produce no dependency entry; the retrieval
 * authorizer fails such a legacy/provenance-incomplete chunk closed.
 */
async function getDependencyGenerations(supabase, tenantId, dependencies) {
  const wanted = (dependencies || []).filter((entry) => entry?.contentType && entry?.sourceId);
  if (!wanted.length) return [];
  const ids = [...new Set(wanted.map((entry) => entry.sourceId))];
  const { data, error } = await supabase
    .from('member_content_source')
    .select('content_type, source_id, generation')
    .eq('tenant_id', tenantId)
    .in('source_id', ids);
  if (error) throw error;
  const versions = new Map(
    (data || []).map((row) => [`${row.content_type}:${row.source_id}`, normalizeGeneration(row.generation)])
  );
  return wanted.flatMap((entry) => {
    const generation = versions.get(`${entry.contentType}:${entry.sourceId}`);
    return generation === null || generation === undefined
      ? []
      : [{ contentType: entry.contentType, sourceId: entry.sourceId, generation }];
  });
}

/**
 * A source trigger increments its registry generation before this worker starts.
 * Claiming that exact generation serializes same-generation workers. If a source
 * changes during embeddings, activation rejects this worker's stale claim.
 */
export async function claimMemberContentGeneration(contentType, item, { supabase } = {}) {
  const { data, error } = await supabase.rpc('claim_member_content_generation', {
    p_tenant_id: item.tenant_id,
    p_content_type: contentType,
    p_source_id: item.id,
  });
  if (error) throw error;
  const claim = Array.isArray(data) ? data[0] : data;
  const generation = normalizeGeneration(claim?.generation);
  if (!claim?.claim_token || generation === null) {
    return null;
  }
  return {
    generation,
    claimToken: claim.claim_token,
    alreadyActive: claim.already_active === true,
  };
}

export async function scheduleMemberContentReindex(contentType, item, { supabase } = {}) {
  const { error } = await supabase
    .from('member_content_reindex_job')
    .upsert({
      tenant_id: item.tenant_id,
      content_type: contentType,
      source_id: item.id,
      attempts: 0,
      available_at: new Date().toISOString(),
      last_error: null,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'tenant_id,content_type,source_id' });
  if (error) throw error;
}

async function deferMemberContentReindexJob(contentType, item, error, { supabase } = {}) {
  const attempts = Math.min(Number(item?._reindexAttempts || 0) + 1, 20);
  const delaySeconds = Math.min(60 * (2 ** Math.min(attempts, 8)), 6 * 60 * 60);
  const { error: writeError } = await supabase
    .from('member_content_reindex_job')
    .upsert({
      tenant_id: item.tenant_id,
      content_type: contentType,
      source_id: item.id,
      attempts,
      available_at: new Date(Date.now() + delaySeconds * 1000).toISOString(),
      last_error: String(error?.message || error || 'reindex failed').slice(0, 1000),
      updated_at: new Date().toISOString(),
    }, { onConflict: 'tenant_id,content_type,source_id' });
  if (writeError) throw writeError;
}

export async function extractResourcePdfChunks(item, supabase) {
  if (item?.resource_type !== 'download' || !item?.target_url || !item?.tenant_id) return [];
  const fileColumns = 'id, tenant_id, file_url, file_name, file_type, mime_type, file_size, bucket, storage_path, updated_at';
  const { data: file, error } = await supabase
    .from('file_repository')
    .select(fileColumns)
    .eq('tenant_id', item.tenant_id)
    .eq('file_url', item.target_url)
    .maybeSingle();
  if (error) throw error;
  // Use the injected client's destination, not the unrelated legacy workspace
  // SUPABASE_URL. CLI backfills deliberately inject a DEST client.
  if (!isTrustedTenantStoragePdf(item.target_url, file, supabase.supabaseUrl || process.env.SUPABASE_URL)) return [];
  const declaredSize = Number(file.file_size);
  if (Number.isFinite(declaredSize) && declaredSize > MAX_RESOURCE_PDF_BYTES) throw pdfIndexError('PDF_SIZE_LIMIT');
  const fileDependencies = await getDependencyGenerations(
    supabase,
    item.tenant_id,
    [{ contentType: 'file_repository', sourceId: file.id }]
  );

  if (fileDependencies.length !== 1) throw pdfIndexError('PDF_MISSING_DEPENDENCY');
  const { data: currentFile, error: currentError } = await supabase.from('file_repository')
    .select(fileColumns).eq('tenant_id', item.tenant_id).eq('id', file.id).maybeSingle();
  if (currentError) throw currentError;
  if (JSON.stringify(currentFile) !== JSON.stringify(file)) throw pdfIndexError('PDF_SOURCE_CHANGED');
  const signal = AbortSignal.timeout(RESOURCE_PDF_TIMEOUT_MS);
  let bytes;
  if (file.bucket && file.storage_path) {
    const { data: stream, error: downloadError } = await downloadPdfStream(
      supabase.storage.from(file.bucket), file.storage_path, signal
    );
    if (downloadError || !stream) throw pdfIndexError('PDF_DOWNLOAD_FAILED');
    bytes = await readBoundedPdfStream(stream, { signal });
  } else {
    const response = await fetch(item.target_url, {
      redirect: 'error',
      signal,
    });
    const contentType = response.headers.get('content-type') || '';
    const length = Number(response.headers.get('content-length'));
    if (
      !response.ok ||
      (!/application\/pdf/i.test(contentType) && !String(file.file_name).toLowerCase().endsWith('.pdf')) ||
      (Number.isFinite(length) && length > MAX_RESOURCE_PDF_BYTES)
    ) {
      await response.body?.cancel();
      throw pdfIndexError('PDF_RESPONSE_REJECTED');
    }
    bytes = await readBoundedPdfStream(response.body, { signal });
  }
  if (!new TextDecoder().decode(bytes.subarray(0, 5)).startsWith('%PDF-')) {
    throw pdfIndexError('PDF_INVALID_SIGNATURE');
  }

  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({ data: bytes, useWorkerFetch: false, isEvalSupported: false });
  const destroy = () => { task.destroy().catch(() => {}); };
  signal.addEventListener('abort', destroy, { once: true });
  try {
    signal.throwIfAborted();
    const pdf = await task.promise;
    if (pdf.numPages > MAX_RESOURCE_PDF_PAGES) throw pdfIndexError('PDF_PAGE_LIMIT');
    const chunks = [];
    for (let pageNo = 1; pageNo <= pdf.numPages; pageNo++) {
      const page = await pdf.getPage(pageNo);
      signal.throwIfAborted();
      const text = (await page.getTextContent()).items
        .map((part) => (typeof part?.str === 'string' ? part.str : ''))
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (text.length > MAX_RESOURCE_PDF_PAGE_CHARS) throw pdfIndexError('PDF_PAGE_TEXT_LIMIT');
      if (text) {
        chunks.push({
          chunkIndex: 20000 + pageNo,
          content: `${item.title || 'Resource'}\n\nDocument: ${file.file_name || 'PDF'} • Page ${pageNo}\n${text}`,
          accessScope: 'public',
          provenance: {
            kind: 'resource_pdf',
            fileId: file.id,
            dependencies: fileDependencies,
            page: pageNo,
          },
        });
      }
    }
    if (!chunks.length) throw pdfIndexError('PDF_NO_TEXT');
    return chunks;
  } finally {
    signal.removeEventListener('abort', destroy);
    await task.destroy();
  }
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
      // Microsite pages never resolve at a bare tenant-root slug.
      if (item._micrositePrefix) {
        return slug
          ? `/${encodeURIComponent(item._micrositePrefix)}/${encodeURIComponent(slug)}`
          : `/${encodeURIComponent(item._micrositePrefix)}`;
      }
      return slug ? `/${encodeURIComponent(slug)}` : null;
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
      // publicly-viewable or member layout.  Chunk access scope controls
      // retrieval of member-only projections.
      return (
        item.builder_type === 'canvas' &&
        item.status === 'published' &&
        (PUBLIC_CANVAS_LAYOUT_TYPES.includes(item.layout_type) || item.layout_type === 'member')
      );
    default:
      return false;
  }
}

export function buildMemberContentMetadata(contentType, item) {
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
    linked_events: Array.isArray(item.linked_events) ? item.linked_events : null,
    subcategories: Array.isArray(item.subcategories) ? item.subcategories : null,
    layout_type: item.layout_type ?? null,
    microsite_id: item.microsite_id ?? null,
    published_date: item.published_date ?? null,
    start_date: item.start_date ?? null,
    feature_key: cfg?.feature || null,
  };
}

export async function deleteMemberContentChunks(contentType, sourceId, { supabase, tenantId = null } = {}) {
  if (!tenantId) {
    const { data, error } = await supabase.from('member_content_source')
      .select('tenant_id').eq('content_type', contentType).eq('source_id', sourceId).limit(2);
    if (error) throw error;
    if (data?.length !== 1) throw new Error('A unique tenant is required for knowledge deletion');
    tenantId = data[0].tenant_id;
  }
  return deleteMemberContentGenerationTombstone({
    contentType, sourceId, tenantId, supabase, writeGeneration: reindexMemberContentItem,
  });
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
export async function sweepOrphanedMemberContentChunks(options = {}) {
  const result = await sweepMemberContentGenerationTombstones({
    ...options, writeGeneration: reindexMemberContentItem,
  });
  return { ...result, removedSources: result.tombstoned || 0 };
}

/**
 * Re-index a single source row.
 *
 * @param {string} contentType
 * @param {object} item        source row (must include tenant_id + id)
 * @param {object} deps        { supabase, openai }
 * @returns {Promise<object>}  summary
 */
export async function reindexMemberContentItem(contentType, item, { supabase, openai, embeddingBudget = null } = {}) {
  if (!supabase) throw new Error('reindexMemberContentItem requires a supabase client');
  if (!CONTENT_TYPE_CONFIG[contentType]) {
    throw new Error(`Unknown content type: ${contentType}`);
  }
  const sourceId = item?.id;
  if (!sourceId) throw new Error('reindexMemberContentItem requires item.id');
  if (!item?.tenant_id) throw new Error('reindexMemberContentItem requires item.tenant_id');

  return writeMemberContentGeneration(contentType, item, {
    supabase, openai, embeddingBudget,
    buildSnapshot: async ({ tenantId, sourceId, claim }) => {
      let canonical;
      let canvas;
      if (contentType === 'canvas_page') {
        canvas = await buildCanvasGenerationSnapshot({
          supabase, tenantId, sourceId, claim, includeMemberContent: true,
        });
        canonical = canvas.indexable ? canvas.item : null;
      } else {
        const { data, error } = await supabase.from(CONTENT_TYPE_CONFIG[contentType].table)
          .select(CONTENT_TYPE_CONFIG[contentType].columns)
          .eq('tenant_id', tenantId).eq('id', sourceId).maybeSingle();
        if (error) throw error;
        canonical = isIndexable(contentType, data) ? data : null;
      }
      if (!canonical) return { item: null, chunks: [] };
      let chunks = chunkMemberContent(canonical, contentType);
      if (contentType === 'resource') chunks.push(...await extractResourcePdfChunks(canonical, supabase));
      chunks = chunks.map((chunk, index) => ({
        ...chunk, chunkIndex: index,
        provenance: {
          ...(chunk.provenance || {}), kind: chunk.provenance?.kind || 'knowledge',
          dependencies: [...(canvas?.dependencies || []), ...(chunk.provenance?.dependencies || [])],
        },
      }));
      return {
        item: canonical, chunks,
        metadata: canvas?.metadata || buildMemberContentMetadata(contentType, canonical),
      };
    },
  });
}

/**
 * Drain mutation jobs ahead of the broad reconciliation scan. We intentionally
 * take at most one due source per tenant in a slice so a noisy tenant cannot
 * monopolise embedding capacity; later invocations rotate through the remaining
 * due rows. Failed rows get durable exponential backoff instead of being lost
 * behind a keyset cursor.
 */
export async function processDueMemberContentReindexJobs({
  supabase,
  openai,
  limit = 12,
  embeddingBudget = null,
  deadlineMs = null,
} = {}) {
  if (!supabase || !openai) return { processed: 0, errors: 0 };
  const { data, error } = await supabase
    .from('member_content_reindex_job')
    .select('tenant_id, content_type, source_id, attempts')
    .lte('available_at', new Date().toISOString())
    .order('available_at', { ascending: true })
    .limit(Math.max(limit * 8, 32));
  if (error) throw error;
  const selected = [];
  const tenants = new Set();
  for (const job of data || []) {
    if (!job?.tenant_id || !job?.content_type || !job?.source_id || tenants.has(job.tenant_id)) continue;
    tenants.add(job.tenant_id);
    selected.push(job);
    if (selected.length >= limit) break;
  }
  const result = { processed: 0, errors: 0 };
  for (const job of selected) {
    if (deadlineMs != null && Date.now() >= deadlineMs) break;
    const cfg = CONTENT_TYPE_CONFIG[job.content_type];
    if (!cfg) continue;
    try {
      let query = supabase
        .from(cfg.table)
        .select(cfg.columns)
        .eq('tenant_id', job.tenant_id)
        .eq('id', job.source_id);
      if (cfg.filterEq) {
        for (const [column, value] of Object.entries(cfg.filterEq)) query = query.eq(column, value);
      }
      const { data: item, error: itemError } = await query.maybeSingle();
      if (itemError) throw itemError;
      if (item) {
        await reindexMemberContentItem(job.content_type, {
          ...item,
          _reindexAttempts: job.attempts,
        }, { supabase, openai, embeddingBudget });
      } else {
        await deleteMemberContentChunks(job.content_type, job.source_id, {
          supabase,
          tenantId: job.tenant_id,
        });
      }
      result.processed++;
    } catch (err) {
      result.errors++;
      await deferMemberContentReindexJob(job.content_type, {
        tenant_id: job.tenant_id,
        id: job.source_id,
        _reindexAttempts: job.attempts,
      }, err, { supabase });
      console.error(
        `[processDueMemberContentReindexJobs] ${job.content_type}/${job.source_id} error:`,
        err?.message || err
      );
    }
  }
  return result;
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
  maxItems = 50,
  maxEmbeddingChunks = 20,
  embeddingBudget = null,
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
  const budget = embeddingBudget && typeof embeddingBudget === 'object'
    ? embeddingBudget : { maxEmbeddingChunks: typeof embeddingBudget === 'number' ? embeddingBudget : maxEmbeddingChunks };
  const initialBudget = budget.maxEmbeddingChunks;
  if (!Number.isInteger(maxItems) || maxItems < 1 || maxItems > 50 ||
      !Number.isInteger(initialBudget) || initialBudget < 0 || initialBudget > 100) {
    throw new Error('Knowledge indexing requires maxItems 1–50 and maxEmbeddingChunks 0–100');
  }
  const finish = (result) => ({ ...result, embeddingChunksSpent: initialBudget - budget.maxEmbeddingChunks });

  // A scoped operator rebuild is intentional and should not consume unrelated
  // tenants' retry queue. The scheduled/global pass drains durable mutations
  // first, retaining a fair tenant spread before the broad keyset scan.
  if (!tenantId && !contentType && !cursor && maxItems > 0) {
    const retries = await processDueMemberContentReindexJobs({
      supabase, openai, embeddingBudget: budget, limit: Math.min(12, maxItems), deadlineMs,
    });
    results.items += retries.processed;
    results.items += retries.errors;
    results.errors += retries.errors;
  }

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
        if (overBudget() || results.items >= maxItems) {
          return finish({ ...results, nextCursor: { type, lastId }, done: false });
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
            const summary = await reindexMemberContentItem(type, item, { supabase, openai, embeddingBudget: budget });
            results.items++;
            results.chunks += summary.chunks;
            results.embedded += summary.embedded;
            results.reused += summary.reused;
            if (summary.removed) results.removed++;
          } catch (err) {
            results.errors++;
            results.items++;
            if (err.code === 'MEMBER_CONTENT_EMBEDDING_BUDGET') {
              return finish({ ...results, nextCursor: { type, lastId }, done: false,
                stopReason: 'embedding_budget', errorCode: err.code });
            }
            try {
              await deferMemberContentReindexJob(type, item, err, { supabase });
            } catch (queueError) {
              console.error(
                `[reindexAllMemberContent] failed to persist retry for ${type}/${item.id}:`,
                queueError?.message || queueError
              );
            }
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
          if (overBudget() || results.items >= maxItems) {
            return finish({ ...results, nextCursor: { type, lastId }, done: false });
          }
        }

        if (rows.length < PAGE) break;
      }
    }

    // Indexing complete for the scoped pass. Hand the orphan sweep its own slice
    // if the budget is already spent, so a large index pass never crowds it out.
    if (overBudget()) {
      return finish({ ...results, nextCursor: { phase: 'sweep' }, done: false });
    }
  }

  // Reconcile: purge chunks whose source row was hard-deleted outside the
  // on-save hooks (retrieval is the security boundary — stale chunks must go).
  try {
    const swept = await sweepOrphanedMemberContentChunks({
      supabase, tenantId, contentType, deadlineMs, maxItems: Math.max(1, maxItems - results.items),
      cursor: cursor?.phase === 'sweep' ? cursor.sweepCursor : null,
    });
    results.orphansRemoved = swept.removedSources;
    results.orphanChunksRemoved = swept.removedChunks;
    results.removed += swept.removedSources;
    results.errors += swept.errors || 0;
    if (!swept.done) return finish({ ...results,
      nextCursor: { phase: 'sweep', sweepCursor: swept.nextCursor }, done: false });
  } catch (err) {
    results.errors++;
    results.details.push({ contentType: 'orphan-sweep', sourceId: null, error: err?.message || String(err) });
    console.error('[reindexAllMemberContent] orphan sweep error:', err?.message || err);
  }

  return finish({ ...results, nextCursor: null, done: true });
}
