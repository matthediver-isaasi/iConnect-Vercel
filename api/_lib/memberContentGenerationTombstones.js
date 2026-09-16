// Generation-safe hard-delete processing for the member-content index.
//
// A member_content_source row outlives the source row it represents.  The
// legacy delete path cannot be used for those rows once member_content_chunk
// has generation-aware publication: deleting a chunk directly can race a
// publisher and can also leave the source queue row behind.  This module only
// ever removes a source through writeMemberContentGeneration(..., []), whose
// claim/generation/token CAS is the database transaction boundary.

import { supabase as defaultSupabase } from './database.js';
import {
  writeMemberContentGeneration,
  GENERATION_MEMBER_CONTENT_TYPES,
  MEMBER_CONTENT_GENERATION_STALE,
  MEMBER_CONTENT_PROVENANCE_CONFLICT,
  MEMBER_CONTENT_UNSUPPORTED,
  MEMBER_CONTENT_EMBEDDING_BUDGET,
} from './memberContentGenerationWriter.js';

export const MEMBER_CONTENT_TOMBSTONE_MAX_ITEMS = 50;
export const MEMBER_CONTENT_TOMBSTONE_PAGE_SIZE =
  MEMBER_CONTENT_TOMBSTONE_MAX_ITEMS;
export const MEMBER_CONTENT_TOMBSTONE_DEFERRED =
  'MEMBER_CONTENT_TOMBSTONE_DEFERRED';
export const MEMBER_CONTENT_TOMBSTONE_INVALID_OPTIONS =
  'MEMBER_CONTENT_TOMBSTONE_INVALID_OPTIONS';
export const MEMBER_CONTENT_TOMBSTONE_KEYSET_INVALID =
  'MEMBER_CONTENT_TOMBSTONE_KEYSET_INVALID';

// Keep Canvas in the same generation-safe tombstone sweep as authored content.
// Its writer performs the public guest projection and dependency fencing before
// publishing an empty snapshot for a missing or non-public page.
const ALL_MEMBER_CONTENT_TYPES = Object.freeze([
  ...GENERATION_MEMBER_CONTENT_TYPES,
  'canvas_page',
]);

const SOURCE_TABLES = Object.freeze({
  resource: 'resource',
  event: 'event',
  complex_event: 'complex_event',
  news_post: 'news_post',
  blog_post: 'blog_post',
  canvas_page: 'i_edit_page',
});

const DEFERRED_WRITER_CODES = new Set([
  MEMBER_CONTENT_GENERATION_STALE,
  MEMBER_CONTENT_PROVENANCE_CONFLICT,
  MEMBER_CONTENT_UNSUPPORTED,
  MEMBER_CONTENT_EMBEDDING_BUDGET,
]);

function errorWithCode(code, message) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  return error;
}

function valueMessage(error) {
  if (typeof error === 'string') return error;
  if (error && typeof error.message === 'string') return error.message;
  return String(error);
}

function codeOf(error) {
  return typeof error?.code === 'string' ? error.code : null;
}

function invalidOptions(message) {
  throw errorWithCode(MEMBER_CONTENT_TOMBSTONE_INVALID_OPTIONS, message);
}

function invalidCursor(message) {
  throw errorWithCode(MEMBER_CONTENT_TOMBSTONE_KEYSET_INVALID, message);
}

function assertSupabase(client, operation) {
  if (!client) throw new Error(`${operation} requires a supabase client`);
}

function assertContentType(contentType, { allowNull = false } = {}) {
  if (allowNull && contentType == null) return;
  if (!ALL_MEMBER_CONTENT_TYPES.includes(contentType)) {
    invalidOptions(`unknown content type: ${String(contentType)}`);
  }
}

function assertRequiredIdentity(tenantId, sourceId) {
  if (typeof tenantId !== 'string' || tenantId.length === 0) {
    invalidOptions('tenantId is required for generation-safe tombstone processing');
  }
  if (typeof sourceId !== 'string' || sourceId.length === 0) {
    invalidOptions('sourceId is required for generation-safe tombstone processing');
  }
}

function validateDeadline(deadlineMs) {
  if (deadlineMs == null) return null;
  const value = Number(deadlineMs);
  if (!Number.isFinite(value) || value <= 0) {
    invalidOptions('deadlineMs must be a finite positive timestamp');
  }
  return value;
}

function validateMaxItems(maxItems) {
  const value = maxItems == null ? MEMBER_CONTENT_TOMBSTONE_MAX_ITEMS : Number(maxItems);
  if (
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > MEMBER_CONTENT_TOMBSTONE_MAX_ITEMS
  ) {
    invalidOptions(
      `maxItems must be a finite integer between 1 and ${MEMBER_CONTENT_TOMBSTONE_MAX_ITEMS}`
    );
  }
  return value;
}

/**
 * UUIDs are the production registry key types.  The deliberately wider
 * alphabet also keeps this helper usable with the short IDs used by local
 * fixtures, while rejecting every character with meaning in PostgREST's
 * filter grammar.
 */
function keysetValue(value, label) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 200 ||
    !/^[A-Za-z0-9_.-]+$/.test(value)
  ) {
    invalidCursor(`${label} is not a safe registry key`);
  }
  return value;
}

function cursorPart(cursor, name, legacyName, snakeName) {
  if (cursor == null) return null;
  return cursor[name] ?? cursor[legacyName] ?? cursor[snakeName] ?? null;
}

/**
 * Normalize the composite keyset cursor.  The three values are intentionally
 * named after the registry's natural unique key rather than its incidental
 * surrogate id: tenant_id + content_type + source_id.
 */
export function normalizeMemberContentTombstoneCursor(cursor) {
  if (cursor == null) return null;
  if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor)) {
    invalidCursor('cursor must be an object');
  }

  const tenantId = cursorPart(cursor, 'tenantId', 'lastTenantId', 'tenant_id');
  const contentType = cursorPart(
    cursor,
    'contentType',
    'lastContentType',
    'content_type'
  );
  const sourceId = cursorPart(cursor, 'sourceId', 'lastSourceId', 'source_id');
  if (tenantId == null || contentType == null || sourceId == null) {
    invalidCursor('cursor needs tenantId, contentType, and sourceId');
  }

  return {
    tenantId: keysetValue(tenantId, 'cursor tenantId'),
    contentType: keysetValue(contentType, 'cursor contentType'),
    sourceId: keysetValue(sourceId, 'cursor sourceId'),
  };
}

function tupleFromRow(row) {
  if (
    !row ||
    typeof row.tenant_id !== 'string' ||
    typeof row.content_type !== 'string' ||
    typeof row.source_id !== 'string'
  ) {
    return null;
  }
  return {
    tenantId: row.tenant_id,
    contentType: row.content_type,
    sourceId: row.source_id,
  };
}

function tupleCompare(left, right) {
  if (left.tenantId !== right.tenantId) {
    return left.tenantId < right.tenantId ? -1 : 1;
  }
  if (left.contentType !== right.contentType) {
    return left.contentType < right.contentType ? -1 : 1;
  }
  if (left.sourceId === right.sourceId) return 0;
  return left.sourceId < right.sourceId ? -1 : 1;
}

function rowMatchesScope(row, tenantId, contentType) {
  return (
    (!tenantId || row.tenant_id === tenantId) &&
    (!contentType || row.content_type === contentType)
  );
}

function afterCursor(row, cursor, tenantId, contentType) {
  if (!cursor) return true;
  const tuple = tupleFromRow(row);
  if (!tuple) return false;
  if (!rowMatchesScope(row, tenantId, contentType)) return false;

  // The database query already applies the same keyset predicate.  Keeping
  // this local check is intentional: it prevents a permissive test double,
  // a stale proxy, or a malformed row from crossing a tenant boundary.
  return tupleCompare(tuple, cursor) > 0;
}

function keysetFilter(cursor, tenantId, contentType) {
  if (!cursor) return null;

  const t = keysetValue(cursor.tenantId, 'cursor tenantId');
  const c = keysetValue(cursor.contentType, 'cursor contentType');
  const s = keysetValue(cursor.sourceId, 'cursor sourceId');

  if (tenantId && contentType) {
    return `source_id.gt.${s}`;
  }
  if (tenantId) {
    return `content_type.gt.${c},and(content_type.eq.${c},source_id.gt.${s})`;
  }
  if (contentType) {
    return `tenant_id.gt.${t},and(tenant_id.eq.${t},source_id.gt.${s})`;
  }
  return (
    `tenant_id.gt.${t},` +
    `and(tenant_id.eq.${t},content_type.gt.${c}),` +
    `and(tenant_id.eq.${t},content_type.eq.${c},source_id.gt.${s})`
  );
}

/**
 * Read only the source identity needed to distinguish a hard delete from a
 * source that merely changed status.  The generation writer performs the
 * authoritative canonical reread after claiming the registry row.
 */
export async function readMemberContentSourceIdentity(
  contentType,
  sourceId,
  tenantId,
  { supabase = defaultSupabase } = {}
) {
  assertSupabase(supabase, 'readMemberContentSourceIdentity');
  assertContentType(contentType);
  assertRequiredIdentity(tenantId, sourceId);

  const table = SOURCE_TABLES[contentType];
  let query = supabase
    .from(table)
    .select('id, tenant_id')
    .eq('tenant_id', tenantId)
    .eq('id', sourceId)
    .limit(1);
  const { data, error } = await query;
  if (error) throw error;

  const row = Array.isArray(data) ? data[0] || null : data || null;
  // Never treat an unexpectedly unscoped response as proof that a source
  // exists.  In particular, a cross-tenant row must not be passed to a
  // writer with the caller's tenant id.
  if (
    !row ||
    row.id !== sourceId ||
    (row.tenant_id != null && row.tenant_id !== tenantId)
  ) {
    return null;
  }
  return { id: row.id, tenant_id: row.tenant_id };
}

function deferredResult({
  contentType,
  sourceId,
  tenantId,
  missing = false,
  code = MEMBER_CONTENT_TOMBSTONE_DEFERRED,
  reason,
  error = null,
}) {
  return {
    contentType,
    sourceId,
    tenantId,
    missing,
    verifiedMissing: missing,
    sourceExists: !missing,
    tombstoned: false,
    removed: false,
    deferred: true,
    code,
    reason: reason || code,
    ...(error ? { error: valueMessage(error) } : {}),
  };
}

function isDeferredWriterError(error) {
  return DEFERRED_WRITER_CODES.has(codeOf(error));
}

/**
 * Process one source identity through the generation publisher.
 *
 * No OpenAI client is passed, and the embedding budget is always zero.  A
 * deletion must never turn a race-resurfaced indexable source into a paid
 * embedding request.  Existing unpublished sources still publish an empty
 * snapshot, while a rich/provenance-protected source is returned as deferred
 * and left unchanged.
 */
export async function processMemberContentGenerationTombstone({
  contentType,
  sourceId,
  tenantId,
  supabase = defaultSupabase,
  writeGeneration = writeMemberContentGeneration,
  publisherReady = false,
} = {}) {
  assertSupabase(supabase, 'processMemberContentGenerationTombstone');
  assertContentType(contentType);
  assertRequiredIdentity(tenantId, sourceId);
  if (typeof writeGeneration !== 'function') {
    invalidOptions('writeGeneration must be a function');
  }

  const canonical = await readMemberContentSourceIdentity(
    contentType,
    sourceId,
    tenantId,
    { supabase }
  );
  const missing = canonical == null;

  try {
    // Do not pass the result of the identity read as canonical content.  The
    // writer must claim first and reread the source itself, closing both the
    // "deleted after verification" and "resurfaced before claim" races.
    const summary = await writeGeneration(
      contentType,
      { id: sourceId, tenant_id: tenantId },
      {
        supabase,
        tenantId,
        // A zero budget is a second line of defence if a race makes a live,
        // indexable source reappear after the identity probe.
        embeddingBudget: { maxEmbeddingChunks: 0 },
        publisherReady,
      }
    );

    if (summary?.busy || summary?.deferred) {
      return {
        ...summary,
        contentType,
        sourceId,
        tenantId,
        missing,
        verifiedMissing: missing,
        sourceExists: !missing,
        tombstoned: false,
        deferred: true,
      };
    }

    return {
      ...summary,
      contentType,
      sourceId,
      tenantId,
      missing,
      verifiedMissing: missing,
      sourceExists: !missing,
      // `removed` is the writer's CAS publication of an empty snapshot.  Do
      // not claim a tombstone was processed if the writer did not publish.
      tombstoned: missing && summary?.removed === true,
      deferred: false,
    };
  } catch (error) {
    if (isDeferredWriterError(error)) {
      return deferredResult({
        contentType,
        sourceId,
        tenantId,
        missing,
        code: codeOf(error),
        reason:
          codeOf(error) === MEMBER_CONTENT_PROVENANCE_CONFLICT
            ? 'rich provenance is protected from destructive repair'
            : 'generation publication was not safe to complete',
        error,
      });
    }
    throw error;
  }
}

function positionalDeleteArgs(contentTypeOrOptions, sourceId, options) {
  if (
    contentTypeOrOptions &&
    typeof contentTypeOrOptions === 'object' &&
    !Array.isArray(contentTypeOrOptions)
  ) {
    return { ...contentTypeOrOptions };
  }
  return {
    ...(options || {}),
    contentType: contentTypeOrOptions,
    sourceId,
  };
}

/**
 * Source-delete-hook friendly wrapper.  It deliberately has the same
 * positional shape as deleteMemberContentChunks, but unlike that legacy
 * helper it verifies tenant-scoped source absence and delegates deletion to
 * the generation writer.
 */
export async function deleteMemberContentGenerationTombstone(
  contentTypeOrOptions,
  sourceId,
  options = {}
) {
  return processMemberContentGenerationTombstone(
    positionalDeleteArgs(contentTypeOrOptions, sourceId, options)
  );
}

/**
 * Read one bounded page from the source registry.  The registry's stable
 * identity is (tenant_id, content_type, source_id); do not use an incidental
 * registry id because deployed schemas do not guarantee one.
 */
export async function readMemberContentTombstoneRegistryPage({
  supabase = defaultSupabase,
  tenantId = null,
  contentType = null,
  cursor = null,
  limit = MEMBER_CONTENT_TOMBSTONE_PAGE_SIZE,
} = {}) {
  assertSupabase(supabase, 'readMemberContentTombstoneRegistryPage');
  assertContentType(contentType, { allowNull: true });
  const pageSize = validateMaxItems(limit);
  const normalizedCursor = normalizeMemberContentTombstoneCursor(cursor);

  if (tenantId != null && typeof tenantId !== 'string') {
    invalidOptions('tenantId must be a string when provided');
  }
  if (tenantId && normalizedCursor && normalizedCursor.tenantId !== tenantId) {
    invalidCursor('cursor tenantId does not match the requested tenant');
  }
  if (
    contentType &&
    normalizedCursor &&
    normalizedCursor.contentType !== contentType
  ) {
    invalidCursor('cursor contentType does not match the requested content type');
  }

  let query = supabase
    .from('member_content_source')
    .select('tenant_id, content_type, source_id')
    .order('tenant_id', { ascending: true })
    .order('content_type', { ascending: true })
    .order('source_id', { ascending: true })
    .limit(pageSize);
  if (tenantId) query = query.eq('tenant_id', tenantId);
  if (contentType) query = query.eq('content_type', contentType);
  // The registry also carries Canvas symbol dependency fences. They are
  // intentionally not sweep sources: the Canvas writer reads them as
  // dependencies while processing a canvas_page and they must remain intact.
  // Apply the allowlist in SQL for unscoped passes so dependency rows cannot
  // become synthetic unknown-type errors.
  if (!contentType) {
    if (typeof query.in !== 'function') {
      throw errorWithCode(
        MEMBER_CONTENT_TOMBSTONE_KEYSET_INVALID,
        'registry query builder does not support content type allowlisting'
      );
    }
    query = query.in('content_type', Object.keys(SOURCE_TABLES));
  }

  const filter = keysetFilter(normalizedCursor, tenantId, contentType);
  if (filter) {
    if (typeof query.or !== 'function') {
      throw errorWithCode(
        MEMBER_CONTENT_TOMBSTONE_KEYSET_INVALID,
        'registry query builder does not support composite keyset filtering'
      );
    }
    query = query.or(filter);
  }

  const { data, error } = await query;
  if (error) throw error;
  return {
    rows: Array.isArray(data) ? data : data ? [data] : [],
    cursor: normalizedCursor,
    limit: pageSize,
  };
}

function initialSummary({ tenantId, contentType, cursor }) {
  return {
    items: 0,
    scanned: 0,
    tombstoned: 0,
    removed: 0,
    resurfaced: 0,
    deferred: 0,
    errors: 0,
    details: [],
    tenantId: tenantId || null,
    contentType: contentType || null,
    nextCursor: cursor,
    done: false,
  };
}

function appendError(summary, row, error) {
  summary.errors += 1;
  summary.details.push({
    tenantId: row?.tenant_id ?? null,
    contentType: row?.content_type ?? null,
    sourceId: row?.source_id ?? null,
    code: codeOf(error) || 'MEMBER_CONTENT_TOMBSTONE_ITEM_ERROR',
    error: valueMessage(error),
  });
}

/**
 * Bounded, resumable sweep over member_content_source.  It scans the
 * generation registry rather than existing chunks, so hard-deleted sources
 * are visible to the sweep.  Every row is processed with a tenant-qualified
 * identity and the writer's source-generation/claim-token CAS.
 */
export async function sweepMemberContentGenerationTombstones({
  supabase = defaultSupabase,
  tenantId = null,
  contentType = null,
  cursor = null,
  maxItems = MEMBER_CONTENT_TOMBSTONE_MAX_ITEMS,
  deadlineMs = null,
  now = () => Date.now(),
  writeGeneration = writeMemberContentGeneration,
  publisherReady = false,
} = {}) {
  assertSupabase(supabase, 'sweepMemberContentGenerationTombstones');
  assertContentType(contentType, { allowNull: true });
  const itemLimit = validateMaxItems(maxItems);
  const deadline = validateDeadline(deadlineMs);
  if (typeof now !== 'function') invalidOptions('now must be a function');
  if (typeof writeGeneration !== 'function') {
    invalidOptions('writeGeneration must be a function');
  }
  if (tenantId != null && typeof tenantId !== 'string') {
    invalidOptions('tenantId must be a string when provided');
  }

  let normalizedCursor = normalizeMemberContentTombstoneCursor(cursor);
  if (tenantId && normalizedCursor && normalizedCursor.tenantId !== tenantId) {
    invalidCursor('cursor tenantId does not match the requested tenant');
  }
  if (
    contentType &&
    normalizedCursor &&
    normalizedCursor.contentType !== contentType
  ) {
    invalidCursor('cursor contentType does not match the requested content type');
  }

  const summary = initialSummary({
    tenantId,
    contentType,
    cursor: normalizedCursor,
  });
  const overDeadline = () => deadline != null && Number(now()) >= deadline;
  if (overDeadline()) return summary;

  let pageCursor = normalizedCursor;
  // The writer performs a readiness RPC unless told that the publisher was
  // already probed. Reuse that result for the rest of this bounded invocation;
  // unlike a module-global cache this cannot survive a schema change between
  // runs.
  let writerPublisherReady = publisherReady;
  for (;;) {
    if (summary.items >= itemLimit || overDeadline()) {
      summary.nextCursor = pageCursor;
      summary.done = false;
      return summary;
    }

    const page = await readMemberContentTombstoneRegistryPage({
      supabase,
      tenantId,
      contentType,
      cursor: pageCursor,
      limit: Math.min(itemLimit - summary.items, MEMBER_CONTENT_TOMBSTONE_PAGE_SIZE),
    });
    const rows = page.rows;
    if (rows.length === 0) {
      summary.nextCursor = null;
      summary.done = true;
      return summary;
    }

    for (const row of rows) {
      const tuple = tupleFromRow(row);
      if (!tuple) {
        // A malformed registry row cannot be safely claimed, and there is no
        // composite cursor to advance to. End this bounded invocation rather
        // than repeatedly asking for the same malformed page forever.
        summary.items += 1;
        summary.scanned += 1;
        appendError(
          summary,
          row,
          errorWithCode(
            MEMBER_CONTENT_TOMBSTONE_KEYSET_INVALID,
            'registry row is missing tenant_id, content_type, or source_id'
          )
        );
        summary.nextCursor = pageCursor;
        summary.done = false;
        return summary;
      }

      // A defensive local filter protects against a stale/mock response that
      // ignored the PostgREST predicates.  Its tuple still advances the
      // ordered scan, preventing a repeated page.
      if (!afterCursor(row, pageCursor, tenantId, contentType)) {
        pageCursor = tuple;
        summary.nextCursor = pageCursor;
        continue;
      }
      if (summary.items >= itemLimit || overDeadline()) {
        summary.nextCursor = pageCursor;
        summary.done = false;
        return summary;
      }

      summary.items += 1;
      summary.scanned += 1;
      try {
        const result = await processMemberContentGenerationTombstone({
          contentType: row.content_type,
          sourceId: row.source_id,
          tenantId: row.tenant_id,
          supabase,
          writeGeneration,
          publisherReady: writerPublisherReady,
        });
        if (GENERATION_MEMBER_CONTENT_TYPES.includes(row.content_type)) {
          writerPublisherReady = true;
        }
        if (result.missing) summary.tombstoned += result.tombstoned ? 1 : 0;
        if (!result.missing) summary.resurfaced += 1;
        if (result.removed) summary.removed += 1;
        if (result.deferred) {
          summary.deferred += 1;
          summary.details.push({
            tenantId: row.tenant_id,
            contentType: row.content_type,
            sourceId: row.source_id,
            code: result.code || MEMBER_CONTENT_TOMBSTONE_DEFERRED,
            reason: result.reason || null,
          });
        }
      } catch (error) {
        if (
          GENERATION_MEMBER_CONTENT_TYPES.includes(row.content_type) &&
          isDeferredWriterError(error)
        ) {
          writerPublisherReady = true;
        }
        appendError(summary, row, error);
      }

      pageCursor = tuple;
      summary.nextCursor = pageCursor;
      if (summary.items >= itemLimit || overDeadline()) {
        summary.done = false;
        return summary;
      }
    }

    // A short page is the only safe indication that the registry has been
    // exhausted.  The next query otherwise uses the exact composite keyset.
    if (rows.length < page.limit) {
      summary.nextCursor = null;
      summary.done = true;
      return summary;
    }
  }
}

// Descriptive aliases make the helper convenient to call from either the
// generic delete hook or a maintenance job without exposing the legacy raw
// chunk-delete function.
export const handleMemberContentGenerationTombstone =
  processMemberContentGenerationTombstone;
export const deleteMemberContentChunksGenerationSafe =
  deleteMemberContentGenerationTombstone;
export const sweepMissingMemberContentSources =
  sweepMemberContentGenerationTombstones;
