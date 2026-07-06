// Task #2363: Member AI Knowledge Assistant — best-effort re-index on save.
//
// Hooks into the generic entity CRUD endpoints so member-facing content stays
// searchable as it's created / edited / deleted. Everything here is best-effort:
// it NEVER throws into the caller (a search-index failure must not fail the
// user's save). The nightly cron reconciles anything missed. Deletes need no
// OpenAI client; upserts of changed text are skipped (with a warning) when no
// key is configured, and picked up later by the cron.

import { supabase } from './database.js';
import {
  reindexMemberContentItem,
  deleteMemberContentChunks,
  getDefaultOpenAIClient,
  CONTENT_TYPE_CONFIG,
} from './memberContentIndexer.js';

// Generic-entity name (as used by api/entities/[entity]) -> content type.
const ENTITY_TO_CONTENT_TYPE = {
  resource: 'resource',
  event: 'event',
  complexevent: 'complex_event',
  newspost: 'news_post',
  blogpost: 'blog_post',
};

function resolveContentType(entity) {
  if (!entity) return null;
  return ENTITY_TO_CONTENT_TYPE[String(entity).toLowerCase()] || null;
}

/**
 * Re-index (or drop) a source row after a create/update. Best-effort.
 * The row must include the columns the indexer reads; the generic entity
 * endpoints return the full saved row, which is sufficient.
 */
export async function reindexMemberContentEntitySafe(entity, row) {
  try {
    const contentType = resolveContentType(entity);
    if (!contentType || !row || !row.id || !supabase) return;
    if (!row.tenant_id) return;

    // Re-fetch the canonical columns so metadata is complete even when the
    // caller returned a partial row.
    const cfg = CONTENT_TYPE_CONFIG[contentType];
    let item = row;
    try {
      const { data } = await supabase
        .from(cfg.table)
        .select(cfg.columns)
        .eq('id', row.id)
        .maybeSingle();
      if (data) item = data;
    } catch {
      // fall back to the row we were given
    }

    const openai = getDefaultOpenAIClient();
    // Without a key we can still remove chunks for now-hidden content; we just
    // can't embed new/changed text. Detect the "needs embedding" case cheaply:
    // if the content is indexable and we have no key, skip and let cron catch up.
    if (!openai) {
      const { isIndexable } = await import('./memberContentIndexer.js');
      if (isIndexable(contentType, item)) {
        console.warn(
          `[memberContentReindex] no OpenAI key; deferring ${contentType}/${row.id} to cron`
        );
        return;
      }
      // Not indexable -> just drop any existing chunks.
      await deleteMemberContentChunks(contentType, row.id, { supabase });
      return;
    }

    await reindexMemberContentItem(contentType, item, { supabase, openai });
  } catch (err) {
    console.error(
      '[memberContentReindex] reindex failed:',
      err?.message || err
    );
  }
}

/**
 * Drop all chunks for a deleted source row. Best-effort; needs no OpenAI key.
 */
export async function deleteMemberContentEntitySafe(entity, sourceId) {
  try {
    const contentType = resolveContentType(entity);
    if (!contentType || !sourceId || !supabase) return;
    await deleteMemberContentChunks(contentType, sourceId, { supabase });
  } catch (err) {
    console.error(
      '[memberContentReindex] delete failed:',
      err?.message || err
    );
  }
}
