// Generation-aware member-content writer.
//
// The generation schema is intentionally written through the two RPCs owned by
// the database migration.  In particular, this module must never delete or
// upsert member_content_chunk directly: publication is a compare-and-swap
// against the source row and the RPC is the transaction boundary.

import crypto from 'node:crypto';
import { chunkMemberContent } from './memberContentChunker.js';
import {
  embedTexts as defaultEmbedTexts,
  EMBEDDING_MODEL,
} from './helpArticleIndexer.js';
import {
  CONTENT_TYPES,
} from './memberContentVisibility.js';
import { isPublicSimpleEventStatus } from '../../shared/eventTiming.js';
import { buildCanvasGenerationSnapshot } from './memberContentCanvasGeneration.js';

export const GENERATION_MEMBER_CONTENT_TYPES = CONTENT_TYPES;
export const MAX_GENERATION_CHUNKS = 100;
export const MAX_GENERATION_CONTENT_BYTES = 500 * 1024;
export const DEFAULT_SINGLE_ITEM_EMBEDDING_CHUNKS = 10;
export const DEFAULT_BULK_EMBEDDING_CHUNKS = 100;

export const MEMBER_CONTENT_GENERATION_STALE = 'MEMBER_CONTENT_GENERATION_STALE';
export const MEMBER_CONTENT_UNSUPPORTED = 'MEMBER_CONTENT_UNSUPPORTED';
export const MEMBER_CONTENT_PROVENANCE_CONFLICT =
  'MEMBER_CONTENT_PROVENANCE_CONFLICT';
export const MEMBER_CONTENT_EMBEDDING_BUDGET =
  'MEMBER_CONTENT_EMBEDDING_BUDGET';
export const MEMBER_CONTENT_INVALID_OPTIONS = 'MEMBER_CONTENT_INVALID_OPTIONS';
export const MEMBER_CONTENT_PUBLISHER_UNAVAILABLE =
  'MEMBER_CONTENT_PUBLISHER_UNAVAILABLE';

const SOURCE_CONFIG = {
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
    feature: null,
    columns:
      'id, tenant_id, title, slug, status, layout_type, builder_type',
    filterEq: { builder_type: 'canvas' },
  },
};

function buildMemberContentLink(contentType, item) {
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
    default:
      return null;
  }
}

function isIndexable(contentType, item) {
  if (!item) return false;
  switch (contentType) {
    case 'resource':
      return item.status === 'active' &&
        !(Array.isArray(item.linked_events) && item.linked_events.length > 0);
    case 'event':
      return isPublicSimpleEventStatus(item.status) && item.event_state !== 'draft';
    case 'complex_event':
      return ['published', 'tbc'].includes(item.status) && item.event_state !== 'draft';
    case 'news_post':
    case 'blog_post':
      return item.status === 'published';
    default:
      return false;
  }
}

function errorWithCode(code, message) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  return error;
}

function hashChunk(title, content) {
  // The title is part of the embedding input.  It must consequently be part of
  // the hash too; hashing only the body would incorrectly reuse a stale vector
  // after a title edit.
  return crypto
    .createHash('sha256')
    .update(JSON.stringify({ title: title || '', content }))
    .digest('hex');
}

function hashLegacyChunk(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function vectorForRpc(value) {
  if (value == null) return null;
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return String(value);
  // p_rows is jsonb and the publish RPC casts this textual representation to a
  // pgvector value.  JSON arrays happen to work with some Postgres versions but
  // are not accepted consistently by the vector input parser.
  return `[${value.map((v) => Number(v)).join(',')}]`;
}

function normaliseClaim(data) {
  if (Array.isArray(data)) return data[0] || null;
  return data || null;
}

function normalisePublishResult(data) {
  if (data === true) return true;
  if (Array.isArray(data)) return normalisePublishResult(data[0]);
  if (!data || typeof data !== 'object') return false;
  if (typeof data.published === 'boolean') return data.published;
  if (typeof data.published_member_content_repair === 'boolean') {
    return data.published_member_content_repair;
  }
  if (typeof data.ok === 'boolean') return data.ok;
  if (typeof data.result === 'boolean') return data.result;
  return false;
}

function isAcceptedExistingProvenance(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (Object.keys(value).length === 0) return true;
  return value.kind === 'authored_repair';
}

function normaliseArray(value) {
  return Array.isArray(value) ? value : [];
}

function buildMetadata(contentType, item) {
  const cfg = SOURCE_CONFIG[contentType];
  const linkedEvents = normaliseArray(item.linked_events);
  const subcategories = normaliseArray(item.subcategories);
  const sourceMetadata = {
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
    linked_events: linkedEvents,
    subcategories,
  };
  // `access_scope` is a deliberate generation-schema column: member AI is
  // authenticated. Do not emit non-schema source/metadata decoration fields;
  // provenance carries source identity/generation.
  return {
    ...sourceMetadata,
    access_scope: 'authenticated',
  };
}

async function readCanonicalSource(
  supabase,
  contentType,
  tenantId,
  sourceId
) {
  const cfg = SOURCE_CONFIG[contentType];
  let query = supabase
    .from(cfg.table)
    .select(cfg.columns)
    .eq('tenant_id', tenantId)
    .eq('id', sourceId)
    .limit(1);
  if (cfg.filterEq) {
    for (const [column, value] of Object.entries(cfg.filterEq)) {
      query = query.eq(column, value);
    }
  }
  const { data, error } = await query;
  if (error) throw error;
  if (Array.isArray(data)) return data[0] || null;
  return data || null;
}

async function readExistingRows(supabase, contentType, tenantId, sourceId) {
  const { data, error } = await supabase
    .from('member_content_chunk')
    .select(
      'chunk_index, title, content_hash, embedding, embedding_model, provenance, source_generation'
    )
    .eq('tenant_id', tenantId)
    .eq('content_type', contentType)
    .eq('source_id', sourceId);
  if (error) throw error;
  return data || [];
}

async function releaseClaim(
  supabase,
  contentType,
  tenantId,
  sourceId,
  generation,
  claimToken
) {
  /*
   * Claims live in the polymorphic member_content_source queue, not in the
   * resource/event source tables.  Keep every identity component in the CAS
   * predicate, including generation, so a late worker cannot release a newer
   * lease for the same source.
   */
  const result = await supabase
    .from('member_content_source')
    .update({ claim_token: null, claim_started_at: null })
    .eq('tenant_id', tenantId)
    .eq('content_type', contentType)
    .eq('source_id', sourceId)
    .eq('generation', generation)
    .eq('claim_token', claimToken);
  if (result?.error) throw result.error;
  return { released: true };
}

async function claimGeneration(supabase, tenantId, contentType, sourceId) {
  const { data, error } = await supabase.rpc(
    'claim_member_content_generation',
    {
      p_tenant_id: tenantId,
      p_content_type: contentType,
      p_source_id: sourceId,
    }
  );
  if (error) throw error;
  const claim = normaliseClaim(data);
  if (!claim || claim.claim_token == null) {
    return {
      busy: true,
      claim: claim || { generation: null, claim_token: null },
    };
  }
  if (claim.generation == null) {
    throw new Error(
      'claim_member_content_generation returned a token without a generation'
    );
  }
  return { busy: false, claim };
}

async function probePublisher(supabase) {
  const { data, error } = await supabase.rpc('publish_member_content_repair', {
    p_tenant_id: null,
    p_content_type: null,
    p_source_id: null,
    p_generation: null,
    p_claim_token: null,
    p_rows: [],
  });
  if (error) throw error;
  if (data !== false) {
    throw errorWithCode(
      MEMBER_CONTENT_PUBLISHER_UNAVAILABLE,
      'publish_member_content_repair readiness probe did not return false'
    );
  }
}

function embeddingBudgetValue(embeddingBudget, fallback) {
  if (
    embeddingBudget != null &&
    (typeof embeddingBudget !== 'object' ||
      Array.isArray(embeddingBudget)) &&
    !(typeof embeddingBudget === 'number' && embeddingBudget === 0)
  ) {
    invalidOption(
      'embeddingBudget',
      embeddingBudget,
      'be an object with maxEmbeddingChunks (numeric zero is the legacy exception)'
    );
  }
  const value =
    embeddingBudget == null
      ? null
      : typeof embeddingBudget === 'number'
        ? embeddingBudget
        : embeddingBudget.maxEmbeddingChunks;
  return nonnegativeIntegerOption(
    'maxEmbeddingChunks',
    value,
    fallback
  );
}

function invalidOption(name, value, detail) {
  throw errorWithCode(
    MEMBER_CONTENT_INVALID_OPTIONS,
    `${name} must ${detail}; received ${String(value)}`
  );
}

function errorMessage(error) {
  if (typeof error === 'string') return error;
  if (error && typeof error.message === 'string') return error.message;
  if (error && typeof error.detail === 'string') return error.detail;
  try {
    const serialized = JSON.stringify(error);
    return typeof serialized === 'string' ? serialized : String(error);
  } catch {
    return String(error);
  }
}

function nonnegativeIntegerOption(name, value, defaultValue) {
  const candidate = value == null ? defaultValue : Number(value);
  if (
    !Number.isFinite(candidate) ||
    !Number.isInteger(candidate) ||
    candidate < 0
  ) {
    invalidOption(name, value, 'be a finite integer >= 0');
  }
  return candidate;
}

function bulkOptions({ maxItems, maxEmbeddingChunks, embeddingBudget, deadlineMs }) {
  const itemLimit = maxItems == null ? 50 : Number(maxItems);
  if (
    !Number.isFinite(itemLimit) ||
    !Number.isInteger(itemLimit) ||
    itemLimit < 1 ||
    itemLimit > 500
  ) {
    invalidOption('maxItems', maxItems, 'be a finite integer between 1 and 500');
  }
  if (
    embeddingBudget != null &&
    (typeof embeddingBudget !== 'object' || Array.isArray(embeddingBudget)) &&
    !(typeof embeddingBudget === 'number' && embeddingBudget === 0)
  ) {
    invalidOption(
      'embeddingBudget',
      embeddingBudget,
      'be an object with maxEmbeddingChunks (numeric zero is the legacy exception)'
    );
  }
  const requestedBudget =
    maxEmbeddingChunks != null
      ? maxEmbeddingChunks
      : typeof embeddingBudget === 'number'
        ? embeddingBudget
        : embeddingBudget?.maxEmbeddingChunks;
  const budget = nonnegativeIntegerOption(
    'maxEmbeddingChunks',
    requestedBudget,
    DEFAULT_BULK_EMBEDDING_CHUNKS
  );
  if (deadlineMs != null) {
    const deadline = Number(deadlineMs);
    if (!Number.isFinite(deadline) || deadline <= 0) {
      invalidOption('deadlineMs', deadlineMs, 'be a finite positive timestamp');
    }
  }
  return { itemLimit, budget };
}

function generationRows({
  contentType,
  item,
  generation,
  chunks,
  existingRows,
  metadataOverride = null,
  provenanceOverride = null,
}) {
  const metadata = metadataOverride || buildMetadata(contentType, item);
  const provenance =
    provenanceOverride || {
      kind: 'authored_repair',
      tenant_id: item.tenant_id,
      content_type: contentType,
      source_id: item.id,
      generation,
    };
  const existingByIndex = new Map(
    existingRows.map((row) => [row.chunk_index, row])
  );
  const rows = [];
  const toEmbed = [];
  const nowIso = new Date().toISOString();

  for (const chunk of chunks) {
    const hash = hashChunk(metadata.title, chunk.content);
    const previous = existingByIndex.get(chunk.chunkIndex);
    const modelCompatible =
      previous &&
      (previous.embedding_model == null ||
        previous.embedding_model === EMBEDDING_MODEL);
    const legacyHashMatches =
      previous &&
      previous.title === metadata.title &&
      previous.content_hash === hashLegacyChunk(chunk.content);
    const reuse =
      modelCompatible &&
      (previous.content_hash === hash || legacyHashMatches) &&
      previous.embedding != null;
    const row = {
      ...metadata,
      chunk_index: chunk.chunkIndex,
      content: chunk.content,
      content_hash: hash,
      source_generation: generation,
      embedding_model: EMBEDDING_MODEL,
      provenance,
      updated_at: nowIso,
    };
    if (reuse) {
      row.embedding = vectorForRpc(previous.embedding);
    } else {
      toEmbed.push({
        chunkIndex: chunk.chunkIndex,
        input: `${metadata.title}\n\n${chunk.content}`,
      });
    }
    rows.push(row);
  }
  return { rows, toEmbed };
}

async function publishRows(
  supabase,
  tenantId,
  contentType,
  sourceId,
  generation,
  claimToken,
  rows
) {
  const { data, error } = await supabase.rpc('publish_member_content_repair', {
    p_tenant_id: tenantId,
    p_content_type: contentType,
    p_source_id: sourceId,
    p_generation: generation,
    p_claim_token: claimToken,
    p_rows: rows,
  });
  if (error) throw error;
  if (!normalisePublishResult(data)) {
    throw errorWithCode(
      MEMBER_CONTENT_GENERATION_STALE,
      'publish_member_content_repair rejected a stale generation or claim token'
    );
  }
  return true;
}

function validateBuiltChunks(chunks) {
  if (chunks.length > MAX_GENERATION_CHUNKS) {
    throw errorWithCode(
      MEMBER_CONTENT_UNSUPPORTED,
      `generation writer accepts at most ${MAX_GENERATION_CHUNKS} chunks`
    );
  }
  const contentBytes = chunks.reduce(
    (sum, chunk) => sum + Buffer.byteLength(chunk.content || '', 'utf8'),
    0
  );
  if (contentBytes > MAX_GENERATION_CONTENT_BYTES) {
    throw errorWithCode(
      MEMBER_CONTENT_UNSUPPORTED,
      `generation writer accepts at most ${MAX_GENERATION_CONTENT_BYTES} content bytes`
    );
  }
  return contentBytes;
}

async function runGenerationTombstoneSweep(options) {
  // Keep this import lazy: the tombstone helper delegates back to this writer,
  // and a static import would turn that safe one-way dependency into a cycle.
  const { sweepMemberContentGenerationTombstones } = await import(
    './memberContentGenerationTombstones.js'
  );
  return sweepMemberContentGenerationTombstones(options);
}

/**
 * Write one canonical source through the generation-aware publication contract.
 *
 * The caller may pass `embeddingBudget: { maxEmbeddingChunks }`; a direct
 * operational invocation defaults to ten new embeddings.  Bulk callers pass a
 * shared budget object so one bounded invocation cannot issue an unbounded
 * number of embedding requests.
 */
export async function writeMemberContentGeneration(
  contentType,
  item,
  {
    supabase,
    openai,
    tenantId = item?.tenant_id,
    embeddingBudget = null,
    embedTexts: embedTextsFn = defaultEmbedTexts,
    capabilityProbe = null,
    publisherReady = false,
  } = {}
) {
  if (!supabase) {
    throw new Error('writeMemberContentGeneration requires a supabase client');
  }
  if (!SOURCE_CONFIG[contentType] || !GENERATION_MEMBER_CONTENT_TYPES.includes(contentType)) {
    throw errorWithCode(
      MEMBER_CONTENT_UNSUPPORTED,
      `${contentType === 'canvas_page' ? 'canvas_page is not supported by the generation writer' : `unsupported content type: ${contentType}`}`
    );
  }
  if (!tenantId) {
    throw new Error('writeMemberContentGeneration requires item.tenant_id');
  }
  if (!item?.id) {
    throw new Error('writeMemberContentGeneration requires item.id');
  }

  // Deployments may expose the generation columns before the publish function
  // has been installed.  A caller can inject a harmless catalog/RPC
  // capability probe so this fails before claiming or embedding.
  if (capabilityProbe != null) {
    if (typeof capabilityProbe !== 'function') {
      throw new Error('capabilityProbe must be a function when provided');
    }
    await capabilityProbe(supabase);
  }
  if (!publisherReady) await probePublisher(supabase);

  // Claim first.  No caller-supplied source values are used for canonical
  // content or visibility metadata after this point.
  const claimed = await claimGeneration(
    supabase,
    tenantId,
    contentType,
    item.id
  );
  if (claimed.busy) {
    return {
      contentType,
      sourceId: item.id,
      tenantId,
      chunks: 0,
      embedded: 0,
      reused: 0,
      removed: false,
      deferred: true,
      busy: true,
      claim: claimed.claim,
      embeddingChunksSpent: 0,
    };
  }

  const { generation, claim_token: claimToken, already_active: alreadyActive } =
    claimed.claim;
  let embeddingChunksSpent = 0;
  let released = false;
  const fail = async (error) => {
    // A release is itself compare-and-set.  It cannot clear another worker's
    // lease, even if this worker timed out while embedding.
    try {
      await releaseClaim(
        supabase,
        contentType,
        tenantId,
        item.id,
        generation,
        claimToken
      );
      released = true;
    } catch (releaseError) {
      error.releaseError = releaseError;
    }
    throw error;
  };

  try {
    const existing = await readExistingRows(
      supabase,
      contentType,
      tenantId,
      item.id
    );
    const invalidExisting = existing.find(
      (row) => !isAcceptedExistingProvenance(row.provenance)
    );
    if (invalidExisting) {
      throw errorWithCode(
        MEMBER_CONTENT_PROVENANCE_CONFLICT,
        `existing member content rows for ${contentType}/${item.id} have unsupported provenance`
      );
    }

    // This is intentionally after claimGeneration: both the authored source
    // reread and the Canvas projection compare this snapshot against the
    // claimed source generation.
    let canonical;
    let chunks;
    let metadataOverride = null;
    let provenanceOverride = null;
    if (contentType === 'canvas_page') {
      const canvas = await buildCanvasGenerationSnapshot({
        supabase,
        tenantId,
        sourceId: item.id,
        claim: claimed.claim,
      });
      if (!canvas.indexable) {
        await publishRows(
          supabase,
          tenantId,
          contentType,
          item.id,
          generation,
          claimToken,
          []
        );
        return {
          contentType,
          sourceId: item.id,
          tenantId,
          chunks: 0,
          embedded: 0,
          reused: 0,
          removed: true,
          deferred: false,
          alreadyActive: !!alreadyActive,
          embeddingChunksSpent,
        };
      }
      canonical = canvas.item;
      chunks = canvas.chunks;
      metadataOverride = canvas.metadata;
      provenanceOverride = canvas.provenance;
    } else {
      canonical = await readCanonicalSource(
        supabase,
        contentType,
        tenantId,
        item.id
      );
    }

    // Rich PDFs and private Canvas pages are intentionally not silently
    // replaced by the authored extractor.  A resource linked to an event is
    // the same unsupported extension as the historical event-linked resource
    // path and must defer rather than publish zero rows.
    if (canonical && Array.isArray(canonical.linked_events) && canonical.linked_events.length) {
      throw errorWithCode(
        MEMBER_CONTENT_UNSUPPORTED,
        `event-linked resource ${contentType}/${item.id} is not supported by authored repair`
      );
    }
    if (!canonical || (contentType !== 'canvas_page' && !isIndexable(contentType, canonical))) {
      await publishRows(
        supabase,
        tenantId,
        contentType,
        item.id,
        generation,
        claimToken,
        []
      );
      return {
        contentType,
        sourceId: item.id,
        tenantId,
        chunks: 0,
        embedded: 0,
        reused: 0,
        removed: true,
        deferred: false,
        alreadyActive: !!alreadyActive,
        embeddingChunksSpent,
      };
    }

    const built = chunks || chunkMemberContent(canonical, contentType);
    validateBuiltChunks(built);
    if (!built.length) {
      await publishRows(
        supabase,
        tenantId,
        contentType,
        item.id,
        generation,
        claimToken,
        []
      );
      return {
        contentType,
        sourceId: item.id,
        tenantId,
        chunks: 0,
        embedded: 0,
        reused: 0,
        removed: true,
        deferred: false,
        alreadyActive: !!alreadyActive,
        embeddingChunksSpent,
      };
    }

    const generated = generationRows({
      contentType,
      item: canonical,
      generation,
      chunks: built,
      existingRows: existing,
      metadataOverride,
      provenanceOverride,
    });
    const maxEmbeddings = embeddingBudgetValue(
      embeddingBudget,
      DEFAULT_SINGLE_ITEM_EMBEDDING_CHUNKS
    );
    if (
      embeddingBudget &&
      typeof embeddingBudget === 'object' &&
      embeddingBudget.maxEmbeddingChunks == null
    ) {
      embeddingBudget.maxEmbeddingChunks = maxEmbeddings;
    }
    if (generated.toEmbed.length > maxEmbeddings) {
      throw errorWithCode(
        MEMBER_CONTENT_EMBEDDING_BUDGET,
        `embedding budget ${maxEmbeddings} is smaller than ${generated.toEmbed.length} new chunks`
      );
    }

    let embedded = 0;
    if (generated.toEmbed.length) {
      if (!openai) {
        throw new Error(
          'writeMemberContentGeneration needs an OpenAI client to embed new/changed chunks'
        );
      }
      // Debit before calling the provider.  A provider failure or a later CAS
      // publication error must not make this bounded invocation spend the same
      // allowance again on its next item.
      if (embeddingBudget && typeof embeddingBudget === 'object') {
        embeddingBudget.maxEmbeddingChunks -= generated.toEmbed.length;
      }
      embeddingChunksSpent = generated.toEmbed.length;
      const embeddings = await embedTextsFn(
        openai,
        generated.toEmbed.map((entry) => entry.input)
      );
      if (!Array.isArray(embeddings) || embeddings.length !== generated.toEmbed.length) {
        throw new Error(
          `embedding provider returned ${embeddings?.length ?? 0} vectors for ${generated.toEmbed.length} chunks`
        );
      }
      generated.toEmbed.forEach((entry, index) => {
        const row = generated.rows.find(
          (candidate) => candidate.chunk_index === entry.chunkIndex
        );
        row.embedding = vectorForRpc(embeddings[index]);
      });
      embedded = embeddings.length;
    }

    await publishRows(
      supabase,
      tenantId,
      contentType,
      item.id,
      generation,
      claimToken,
      generated.rows
    );
    return {
      contentType,
      sourceId: item.id,
      tenantId,
      chunks: generated.rows.length,
      embedded,
      reused: generated.rows.length - embedded,
      removed: false,
      deferred: false,
      alreadyActive: !!alreadyActive,
      embeddingChunksSpent,
    };
  } catch (error) {
    if (error && (typeof error === 'object' || typeof error === 'function')) {
      error.embeddingChunksSpent = embeddingChunksSpent;
    }
    await fail(error);
  }
  // `fail` always throws.  This keeps static analysers from treating the
  // release flag as dead while documenting that successful publication does
  // not perform a source-row update.
  return { released };
}

/**
 * Generation-aware bulk dispatcher.  This is kept in the writer module so it
 * can be tested without invoking the legacy indexer's orphan sweep.
 */
export async function reindexAllMemberContentGeneration({
  supabase,
  openai,
  tenantId = null,
  contentType = null,
  deadlineMs = null,
  cursor = null,
  maxItems = 50,
  embeddingBudget = {},
  maxEmbeddingChunks = null,
  embedTexts: embedTextsFn = defaultEmbedTexts,
  capabilityProbe = null,
} = {}) {
  if (!supabase) {
    throw new Error('reindexAllMemberContentGeneration requires a supabase client');
  }
  const allTypes = contentType ? [contentType] : CONTENT_TYPES;
  for (const type of allTypes) {
    if (!CONTENT_TYPES.includes(type)) {
      throw new Error(`Unknown content type: ${type}`);
    }
    if (type !== 'canvas_page' && !SOURCE_CONFIG[type]) {
      throw new Error(`Unknown content type: ${type}`);
    }
  }
  const results = {
    items: 0,
    chunks: 0,
    embedded: 0,
    reused: 0,
    removed: 0,
    deferred: 0,
    errors: 0,
    details: [],
    orphanSweep: { done: false, pending: true },
  };
  const { itemLimit: max, budget } = bulkOptions({
    maxItems,
    maxEmbeddingChunks,
    embeddingBudget,
    deadlineMs,
  });
  const sharedBudget = { maxEmbeddingChunks: budget };
  const withBudgetSpent = (value) => ({
    ...value,
    embeddingChunksSpent: budget - sharedBudget.maxEmbeddingChunks,
  });
  const finishSweep = (swept, sweepCursor) => {
    results.items += swept.items || 0;
    results.removed += swept.removed || 0;
    results.deferred += swept.deferred || 0;
    results.errors += swept.errors || 0;
    if (Array.isArray(swept.details) && swept.details.length) {
      results.details.push(...swept.details);
    }
    results.orphanSweep = {
      deferred: false,
      done: !!swept.done,
      items: swept.items || 0,
      tombstoned: swept.tombstoned || 0,
      resurfaced: swept.resurfaced || 0,
    };
    return withBudgetSpent({
      ...results,
      nextCursor: swept.done
        ? null
        : {
            phase: 'sweep',
            ...(swept.nextCursor || sweepCursor || {}),
          },
      done: !!swept.done,
    });
  };
  if (capabilityProbe != null) {
    if (typeof capabilityProbe !== 'function') {
      throw new Error('capabilityProbe must be a function when provided');
    }
    await capabilityProbe(supabase);
  }
  // Probe once per bounded run. Direct single-item calls probe independently;
  // the private publisherReady flag below is never cached globally.
  await probePublisher(supabase);
  const overBudget = () =>
    deadlineMs != null && Date.now() >= Number(deadlineMs);
  const startInSweep = cursor?.phase === 'sweep';
  // A legacy cursor can contain phase=sweep.  There is no sweep in this mode,
  // but retaining a terminal cursor makes an accidentally replayed cursor
  // explicit rather than silently running a second unbounded pass.
  if (startInSweep) {
    const sweepCursor = cursor.cursor || (
      cursor.tenantId ? {
        tenantId: cursor.tenantId,
        contentType: cursor.contentType,
        sourceId: cursor.sourceId,
      } : null
    );
    const swept = await runGenerationTombstoneSweep({
      supabase,
      tenantId,
      contentType,
      cursor: sweepCursor,
      maxItems: Math.min(50, max),
      deadlineMs,
      publisherReady: true,
    });
    return finishSweep(swept, sweepCursor);
  }
  const resumeType = cursor?.type || null;
  const resumeAfterId = cursor?.lastId ?? null;
  const startIndex = resumeType ? allTypes.indexOf(resumeType) : 0;
  const typesToRun = startIndex >= 0 ? allTypes.slice(startIndex) : allTypes;

  for (let typeIndex = 0; typeIndex < typesToRun.length; typeIndex += 1) {
    const type = typesToRun[typeIndex];
    const cfg = SOURCE_CONFIG[type];
    let lastId =
      typeIndex === 0 && resumeType === type ? resumeAfterId : null;
    const pageSize = Math.max(1, Math.min(500, max || 1));
    for (;;) {
      if (results.items >= max || overBudget()) {
        return withBudgetSpent({
          ...results,
          nextCursor: { type, lastId },
          done: false,
        });
      }
      let query = supabase
        .from(cfg.table)
        .select(cfg.columns)
        .order('id', { ascending: true })
        .limit(pageSize);
      if (tenantId) query = query.eq('tenant_id', tenantId);
      if (cfg.filterEq) {
        for (const [column, value] of Object.entries(cfg.filterEq)) {
          query = query.eq(column, value);
        }
      }
      if (lastId != null) query = query.gt('id', lastId);
      const { data, error } = await query;
      if (error) throw error;
      const rows = data || [];
      if (!rows.length) break;

      for (const source of rows) {
        if (results.items >= max || overBudget()) {
          return withBudgetSpent({
            ...results,
            nextCursor: { type, lastId },
            done: false,
          });
        }
        try {
          const summary = await writeMemberContentGeneration(type, source, {
            supabase,
            openai,
            tenantId: tenantId || source.tenant_id,
            embeddingBudget: sharedBudget,
            embedTexts: embedTextsFn,
            publisherReady: true,
          });
          results.items += 1;
          results.chunks += summary.chunks;
          results.embedded += summary.embedded;
          results.reused += summary.reused;
          if (summary.removed) results.removed += 1;
          if (summary.deferred) results.deferred += 1;
          lastId = source.id;
        } catch (error) {
          if (error?.code === MEMBER_CONTENT_EMBEDDING_BUDGET) {
            // This source was not started from the caller's point of view:
            // releaseClaim has already run, so resume at the same id.
            const detail = {
              contentType: type,
              sourceId: source.id,
              code: error?.code || null,
              error: errorMessage(error),
            };
            results.errors += 1;
            results.details.push(detail);
            return withBudgetSpent({
              ...results,
              nextCursor: { type, lastId },
              done: false,
              stopReason: 'embedding_budget',
              errorCode: error.code,
              error: detail.error,
              stopDetail: detail,
            });
          }
          results.items += 1;
          results.errors += 1;
          results.details.push({
            contentType: type,
            sourceId: source.id,
            code: error?.code || null,
            error: errorMessage(error),
          });
          lastId = source.id;
        }
        if (results.items >= max || overBudget()) {
          return withBudgetSpent({
            ...results,
            nextCursor: { type, lastId },
            done: false,
          });
        }
      }
      if (rows.length < pageSize) break;
    }
  }
  const swept = await runGenerationTombstoneSweep({
    supabase,
    tenantId,
    contentType,
    maxItems: Math.min(50, Math.max(1, max - results.items)),
    deadlineMs,
    publisherReady: true,
  });
  return finishSweep(swept, null);
}

