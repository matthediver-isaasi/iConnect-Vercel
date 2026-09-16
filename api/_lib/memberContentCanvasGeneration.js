// Generation-aware Canvas page adapter.
//
// This module deliberately stops at the adapter boundary.  It reads a
// canonical, already-claimed page, applies the same guest projection used by
// the public Canvas renderer, and returns chunks plus the dependency metadata
// that the generation publisher must carry into provenance.  It does not
// claim generations, publish chunks, or mutate any table.
//
// The current foundation is intentionally public-layout-only.  A `member`
// layout (or a future layout not in PUBLIC_CANVAS_LAYOUT_TYPES) is not treated
// as public by guessing at its access rules.  Mixed-access public pages are
// safe to index because the projection removes member-only Custom HTML before
// the existing Canvas text extractor sees the design.

import { chunkMemberContent } from './memberContentChunker.js';
import { PUBLIC_CANVAS_LAYOUT_TYPES } from './memberContentVisibility.js';
import {
  collectCanvasSymbolIds,
} from '../../client/src/lib/canvasText.js';
import {
  projectCanvasDesignForGuest,
  projectMemberOnlyGuest,
} from '../../shared/canvasMemberOnly.js';

export const CANVAS_CONTENT_TYPE = 'canvas_page';
export const CANVAS_SYMBOL_CONTENT_TYPE = 'canvas_symbol';

// Keep the source read explicit.  In particular, do not use select('*'):
// authoring-only fields must never become part of the adapter contract.
export const CANVAS_PAGE_SOURCE_COLUMNS =
  'id, tenant_id, title, slug, canvas_design, status, layout_type, builder_type, microsite_id, updated_at';
const CANVAS_PAGE_SOURCE_COLUMNS_WITHOUT_UPDATED_AT =
  'id, tenant_id, title, slug, canvas_design, status, layout_type, builder_type, microsite_id';
export const CANVAS_SYMBOL_SOURCE_COLUMNS =
  'id, tenant_id, design, updated_at';

export const MEMBER_CONTENT_CANVAS_UNSUPPORTED =
  'MEMBER_CONTENT_CANVAS_UNSUPPORTED';
export const MEMBER_CONTENT_CANVAS_DEPENDENCY_UNAVAILABLE =
  'MEMBER_CONTENT_CANVAS_DEPENDENCY_UNAVAILABLE';
export const MEMBER_CONTENT_CANVAS_CLAIM_REQUIRED =
  'MEMBER_CONTENT_CANVAS_CLAIM_REQUIRED';

const MAX_SYMBOL_STABILITY_READS = 2;

function adapterError(code, message, cause = null) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

function asRows(data) {
  if (Array.isArray(data)) return data;
  return data ? [data] : [];
}

function normalisePositiveGeneration(value) {
  const generation = Number(value);
  if (
    !Number.isSafeInteger(generation) ||
    generation <= 0
  ) {
    return null;
  }
  return generation;
}

function symbolVersion(value) {
  // updated_at is the source version retained for provenance/debugging.  The
  // dependency generation is the retrieval fence; both are intentionally
  // preserved instead of deriving one from the other.
  return value == null ? null : String(value);
}

function sameSymbolVersions(left, right, ids) {
  return ids.every((id) => {
    const a = left.get(id);
    const b = right.get(id);
    return (
      a?.updated_at === b?.updated_at
      && a?.tenant_id === b?.tenant_id
    );
  });
}

function buildSymbolMap(rows, ids) {
  const byId = new Map();
  for (const row of rows) {
    if (row?.id && ids.includes(row.id)) byId.set(row.id, row);
  }
  return byId;
}

function buildDependencyMap(rows, tenantId, ids) {
  const byId = new Map();
  for (const row of rows) {
    if (!row?.source_id || !ids.includes(row.source_id)) continue;
    if (row.tenant_id != null && String(row.tenant_id) !== String(tenantId)) {
      continue;
    }
    const generation = normalisePositiveGeneration(row.active_generation);
    if (generation == null) continue;
    byId.set(row.source_id, { ...row, generation });
  }
  return byId;
}

/**
 * A Canvas page is indexable only when the public page endpoint would expose
 * its page shell.  Block-level member-only content is handled separately by
 * projectCanvasDesignForGuest.
 */
export function isPublicCanvasPage(item) {
  return !!item
    && item.builder_type === 'canvas'
    && item.status === 'published'
    && PUBLIC_CANVAS_LAYOUT_TYPES.includes(item.layout_type);
}

/**
 * Return the citation path for a public Canvas page.  The adapter supplies
 * microsite_path_prefix after validating that the active microsite belongs to
 * the same tenant.  A caller that only has the source row can still use the
 * default-site path.
 */
export function buildCanvasPageLink(item, { micrositePrefix = null } = {}) {
  if (!item?.slug) return null;
  const slug = encodeURIComponent(String(item.slug));
  const prefix = micrositePrefix || item.microsite_path_prefix || null;
  return prefix
    ? `/${encodeURIComponent(String(prefix))}/${slug}`
    : `/${slug}`;
}

/**
 * Read one page after the generation claim has been acquired by the caller.
 *
 * This function intentionally does not accept a caller-supplied design.  The
 * generation writer must invoke it after claim_member_content_generation and
 * use this canonical reread for all text and visibility decisions.
 */
export async function readCanonicalCanvasPage({
  supabase,
  tenantId,
  sourceId,
} = {}) {
  if (!supabase) {
    throw new Error('readCanonicalCanvasPage requires a supabase client');
  }
  if (!tenantId || !sourceId) {
    throw new Error('readCanonicalCanvasPage requires tenantId and sourceId');
  }

  let query = supabase
    .from('i_edit_page')
    .select(CANVAS_PAGE_SOURCE_COLUMNS)
    .eq('tenant_id', tenantId)
    .eq('id', sourceId)
    .eq('builder_type', 'canvas')
    .limit(1);
  const result = await query;
  if (!result?.error) {
    return asRows(result.data)[0] || null;
  }

  // Some deployed page schemas predate an i_edit_page.updated_at column.
  // Do not substitute published_at: that would falsely claim that an edit
  // after publication was fenced.  Preserve the field as null until the
  // source schema exposes a real edit timestamp.
  if (
    result.error?.code !== '42703'
    || !/updated_at/i.test(result.error?.message || '')
  ) {
    throw result.error;
  }
  const legacyResult = await supabase
    .from('i_edit_page')
    .select(CANVAS_PAGE_SOURCE_COLUMNS_WITHOUT_UPDATED_AT)
    .eq('tenant_id', tenantId)
    .eq('id', sourceId)
    .eq('builder_type', 'canvas')
    .limit(1);
  if (legacyResult?.error) throw legacyResult.error;
  const legacyPage = asRows(legacyResult.data)[0] || null;
  return legacyPage ? { ...legacyPage, updated_at: null } : null;
}

async function readActiveMicrosite(supabase, tenantId, micrositeId) {
  if (!micrositeId) return null;
  const { data, error } = await supabase
    .from('microsite')
    .select('id, tenant_id, path_prefix, is_active')
    .eq('tenant_id', tenantId)
    .eq('id', micrositeId)
    .eq('is_active', true)
    .limit(1);
  if (error) throw error;
  return asRows(data)[0] || null;
}

async function readCanvasSymbols(supabase, tenantId, ids) {
  if (!ids.length) return [];
  const { data, error } = await supabase
    .from('canvas_symbol')
    .select(CANVAS_SYMBOL_SOURCE_COLUMNS)
    .eq('tenant_id', tenantId)
    .in('id', ids);
  if (error) throw error;
  return asRows(data);
}

async function readCanvasSymbolGenerations(supabase, tenantId, ids) {
  if (!ids.length) return [];
  const { data, error } = await supabase
    .from('member_content_source')
    .select('source_id, tenant_id, active_generation')
    .eq('tenant_id', tenantId)
    .eq('content_type', CANVAS_SYMBOL_CONTENT_TYPE)
    .in('source_id', ids);
  if (error) {
    throw adapterError(
      MEMBER_CONTENT_CANVAS_DEPENDENCY_UNAVAILABLE,
      'Canvas symbol generation sources could not be read',
      error
    );
  }
  return asRows(data);
}

/**
 * Read referenced symbols with their current generation fence.
 *
 * The second symbol read is a small race guard.  Without it, a symbol update
 * between the design read and the generation read could pair old text with
 * the new active generation and make a stale snapshot look current to the
 * retrieval RPC.  A changed pair is retried once and then fails closed.
 */
async function readStableCanvasSymbols(supabase, tenantId, ids) {
  if (!ids.length) {
    return {
      symbols: [],
      dependencies: [],
      symbolVersions: {},
    };
  }

  for (let attempt = 0; attempt < MAX_SYMBOL_STABILITY_READS; attempt += 1) {
    const firstRows = await readCanvasSymbols(supabase, tenantId, ids);
    const firstById = buildSymbolMap(firstRows, ids);
    const generations = await readCanvasSymbolGenerations(
      supabase,
      tenantId,
      ids
    );
    const dependencyById = buildDependencyMap(generations, tenantId, ids);
    const secondRows = await readCanvasSymbols(supabase, tenantId, ids);
    const secondById = buildSymbolMap(secondRows, ids);

    // A missing symbol is rendered as no resolved symbol by the public Canvas
    // endpoint.  It contributes no text and therefore needs no dependency.
    // A present symbol without an active source generation is different: it
    // cannot be fenced by match_member_content_chunks, so fail closed.
    const presentIds = ids.filter((id) => secondById.has(id));
    const missingGenerations = presentIds.filter(
      (id) => !dependencyById.has(id)
    );
    if (missingGenerations.length) {
      throw adapterError(
        MEMBER_CONTENT_CANVAS_DEPENDENCY_UNAVAILABLE,
        'A referenced Canvas symbol has no active member-content generation'
      );
    }

    if (!sameSymbolVersions(firstById, secondById, ids)) continue;

    const symbols = presentIds.map((id) => secondById.get(id));
    const dependencies = presentIds.map((id) => ({
      contentType: CANVAS_SYMBOL_CONTENT_TYPE,
      sourceId: id,
      generation: dependencyById.get(id).generation,
    }));
    const symbolVersions = Object.fromEntries(
      presentIds.map((id) => [
        id,
        {
          updated_at: symbolVersion(secondById.get(id).updated_at),
          generation: dependencyById.get(id).generation,
        },
      ])
    );

    return { symbols, dependencies, symbolVersions };
  }

  throw adapterError(
    MEMBER_CONTENT_CANVAS_DEPENDENCY_UNAVAILABLE,
    'Canvas symbols changed while their dependency snapshot was being read'
  );
}

function buildCanvasProvenance({
  tenantId,
  sourceId,
  generation = null,
  dependencies,
}) {
  // The deployed publisher permits authored_repair provenance only.  Keep
  // that marker while recording the Canvas adapter and exact dependency
  // generations in the shape consumed by match_member_content_chunks.
  return {
    kind: 'authored_repair',
    adapter: 'canvas_page',
    tenant_id: tenantId,
    content_type: CANVAS_CONTENT_TYPE,
    source_id: sourceId,
    ...(generation == null ? {} : { generation }),
    dependencies,
  };
}

function publicCanvasItem(page, symbols) {
  const projectedPage = projectCanvasDesignForGuest(page.canvas_design);
  const projectedSymbols = Object.fromEntries(
    symbols.map((symbol) => [
      symbol.id,
      {
        ...projectMemberOnlyGuest(symbol),
        design: projectCanvasDesignForGuest(symbol.design),
      },
    ])
  );
  return {
    id: page.id,
    tenant_id: page.tenant_id,
    title: page.title,
    slug: page.slug,
    status: page.status,
    layout_type: page.layout_type,
    builder_type: page.builder_type,
    microsite_id: page.microsite_id ?? null,
    updated_at: page.updated_at ?? null,
    canvas_design: projectedPage,
    __symbols: projectedSymbols,
  };
}

function emptyCanvasResult({
  tenantId,
  sourceId,
  reason,
  source = null,
} = {}) {
  return {
    contentType: CANVAS_CONTENT_TYPE,
    sourceId,
    tenantId,
    source,
    indexable: false,
    chunks: [],
    dependencies: [],
    symbolVersions: {},
    metadata: null,
    reason,
  };
}

/**
 * Build the complete Canvas adapter snapshot after a generation claim.
 *
 * `claim` is intentionally required.  The adapter does not perform the claim
 * itself because claim/release/CAS ownership belongs to the generation writer,
 * but requiring the claim result here makes it difficult to accidentally
 * index caller-provided stale content.
 *
 * Returned `metadata` is the exact source-level metadata the publisher should
 * copy to every generated chunk.  `dependencies` is also returned separately
 * so a publisher that stores dependency rows can persist the same contract;
 * `metadata.provenance.dependencies` is the retrieval-RPC contract.
 */
export async function buildCanvasGenerationSnapshot({
  supabase,
  tenantId,
  sourceId,
  claim = null,
} = {}) {
  if (!claim || normalisePositiveGeneration(claim.generation) == null) {
    throw adapterError(
      MEMBER_CONTENT_CANVAS_CLAIM_REQUIRED,
      'buildCanvasGenerationSnapshot must run after a generation claim'
    );
  }

  const canonical = await readCanonicalCanvasPage({
    supabase,
    tenantId,
    sourceId,
  });
  if (!canonical) {
    return emptyCanvasResult({
      tenantId,
      sourceId,
      reason: 'missing',
    });
  }
  if (!isPublicCanvasPage(canonical)) {
    return emptyCanvasResult({
      tenantId,
      sourceId,
      source: {
        id: canonical.id,
        tenant_id: canonical.tenant_id,
        title: canonical.title,
        slug: canonical.slug,
        status: canonical.status,
        layout_type: canonical.layout_type,
        builder_type: canonical.builder_type,
        microsite_id: canonical.microsite_id ?? null,
        updated_at: canonical.updated_at ?? null,
      },
      reason: 'not-public-layout',
    });
  }

  const microsite = await readActiveMicrosite(
    supabase,
    tenantId,
    canonical.microsite_id
  );
  if (canonical.microsite_id && !microsite) {
    return emptyCanvasResult({
      tenantId,
      sourceId,
      source: {
        id: canonical.id,
        tenant_id: canonical.tenant_id,
        title: canonical.title,
        slug: canonical.slug,
        status: canonical.status,
        layout_type: canonical.layout_type,
        builder_type: canonical.builder_type,
        microsite_id: canonical.microsite_id,
        updated_at: canonical.updated_at ?? null,
      },
      reason: 'inactive-or-missing-microsite',
    });
  }

  const symbolIds = Array.from(collectCanvasSymbolIds(canonical.canvas_design));
  const {
    symbols,
    dependencies,
    symbolVersions,
  } = await readStableCanvasSymbols(supabase, tenantId, symbolIds);
  const item = publicCanvasItem(canonical, symbols);
  const link = buildCanvasPageLink(item, {
    micrositePrefix: microsite?.path_prefix || null,
  });
  const provenance = buildCanvasProvenance({
    tenantId,
    sourceId,
    generation: normalisePositiveGeneration(claim.generation),
    dependencies,
  });
  const metadata = {
    tenant_id: canonical.tenant_id,
    content_type: CANVAS_CONTENT_TYPE,
    source_id: canonical.id,
    slug: canonical.slug || null,
    title: canonical.title || '(untitled)',
    link,
    status: canonical.status || null,
    feature_key: null,
    access_scope: 'public',
    layout_type: canonical.layout_type || null,
    microsite_id: canonical.microsite_id ?? null,
    source_updated_at: canonical.updated_at ?? null,
    symbol_versions: symbolVersions,
    provenance,
  };

  return {
    contentType: CANVAS_CONTENT_TYPE,
    sourceId: canonical.id,
    tenantId: canonical.tenant_id,
    source: {
      id: canonical.id,
      tenant_id: canonical.tenant_id,
      title: canonical.title,
      slug: canonical.slug,
      status: canonical.status,
      layout_type: canonical.layout_type,
      builder_type: canonical.builder_type,
      microsite_id: canonical.microsite_id ?? null,
      updated_at: canonical.updated_at ?? null,
    },
    // `item` is the public projection, never the raw canonical design.
    item,
    indexable: true,
    chunks: chunkMemberContent(item, CANVAS_CONTENT_TYPE),
    dependencies,
    symbolVersions,
    metadata,
    layout_type: metadata.layout_type,
    microsite_id: metadata.microsite_id,
    source_updated_at: metadata.source_updated_at,
    symbol_versions: metadata.symbol_versions,
    provenance,
    link,
  };
}

/**
 * Pure projection/chunk helper for callers that already fetched the
 * generation-fenced symbols.  The database-backed snapshot above is the
 * preferred entry point; this export keeps publisher integration testable
 * without allowing raw designs into the returned item.
 */
export function buildCanvasGenerationProjection({
  page,
  symbols = [],
  dependencies = [],
  symbolVersions = {},
  generation = null,
  micrositePrefix = null,
} = {}) {
  if (!isPublicCanvasPage(page)) {
    return emptyCanvasResult({
      tenantId: page?.tenant_id || null,
      sourceId: page?.id || null,
      reason: 'not-public-layout',
    });
  }
  const item = publicCanvasItem(page, symbols);
  const provenance = buildCanvasProvenance({
    tenantId: page.tenant_id,
    sourceId: page.id,
    generation,
    dependencies,
  });
  const metadata = {
    tenant_id: page.tenant_id,
    content_type: CANVAS_CONTENT_TYPE,
    source_id: page.id,
    slug: page.slug || null,
    title: page.title || '(untitled)',
    link: buildCanvasPageLink(item, { micrositePrefix }),
    status: page.status || null,
    feature_key: null,
    access_scope: 'public',
    layout_type: page.layout_type || null,
    microsite_id: page.microsite_id ?? null,
    source_updated_at: page.updated_at ?? null,
    symbol_versions: symbolVersions,
    provenance,
  };
  return {
    contentType: CANVAS_CONTENT_TYPE,
    sourceId: page.id,
    tenantId: page.tenant_id,
    source: {
      id: page.id,
      tenant_id: page.tenant_id,
      title: page.title,
      slug: page.slug,
      status: page.status,
      layout_type: page.layout_type,
      builder_type: page.builder_type,
      microsite_id: page.microsite_id ?? null,
      updated_at: page.updated_at ?? null,
    },
    item,
    indexable: true,
    chunks: chunkMemberContent(item, CANVAS_CONTENT_TYPE),
    dependencies,
    symbolVersions,
    metadata,
    layout_type: metadata.layout_type,
    microsite_id: metadata.microsite_id,
    source_updated_at: metadata.source_updated_at,
    symbol_versions: metadata.symbol_versions,
    provenance,
    link: metadata.link,
  };
}

// Descriptive aliases for writer integration without making the writer import
// private implementation details.
export const readCanvasGenerationSnapshot = buildCanvasGenerationSnapshot;
export const prepareCanvasGeneration = buildCanvasGenerationSnapshot;
