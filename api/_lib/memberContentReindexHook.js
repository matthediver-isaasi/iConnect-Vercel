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
  scheduleMemberContentReindex,
} from './memberContentIndexer.js';
import { collectCanvasSymbolIds } from '../../client/src/lib/canvasText.js';

// Generic-entity name (as used by api/entities/[entity]) -> content type.
const ENTITY_TO_CONTENT_TYPE = {
  resource: 'resource',
  event: 'event',
  complexevent: 'complex_event',
  newspost: 'news_post',
  blogpost: 'blog_post',
  // Canvas Builder pages (entity name IEditPage). Non-canvas iEdit pages are
  // filtered out by isIndexable (builder_type !== 'canvas'), so a save of an
  // element-based iEdit page just no-ops (drops any chunks it never had).
  ieditpage: 'canvas_page',
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
    if (!supabase) return;
    // PDF chunks inherit a file-repository version fence. Rebuild every
    // resource which currently points at a changed media-library file so their
    // embeddings are refreshed rather than merely fail-closed at query time.
    if (String(entity).toLowerCase().replace(/[_-]/g, '') === 'filerepository' && row?.tenant_id && row?.file_url) {
      const { data: resources, error } = await supabase
        .from('resource')
        .select(CONTENT_TYPE_CONFIG.resource.columns)
        .eq('tenant_id', row.tenant_id)
        .eq('target_url', row.file_url);
      if (error) throw error;
      const openai = getDefaultOpenAIClient();
      if (!openai) {
        for (const resource of resources || []) {
          await scheduleMemberContentReindex('resource', resource, { supabase });
        }
        return;
      }
      await Promise.all(
        (resources || []).map((resource) =>
          reindexMemberContentItem('resource', resource, { supabase, openai })
        )
      );
      return;
    }
    if (String(entity).toLowerCase().replace(/[_-]/g, '') === 'canvassymbol' && row?.tenant_id && row?.id) {
      // Symbols are transcluded at render time. There is no relational
      // dependency table, so find only the tenant's Canvas pages and compare
      // their extracted symbol ids. This is bounded by one tenant and runs
      // sequentially to avoid an edit storm starving normal source updates.
      const { data: pages, error } = await supabase
        .from('i_edit_page')
        .select(CONTENT_TYPE_CONFIG.canvas_page.columns)
        .eq('tenant_id', row.tenant_id)
        .eq('builder_type', 'canvas')
        .limit(5000);
      if (error) throw error;
      const impacted = (pages || []).filter((page) =>
        collectCanvasSymbolIds(page.canvas_design).has(row.id)
      );
      const openai = getDefaultOpenAIClient();
      if (!openai) {
        for (const page of impacted) {
          await scheduleMemberContentReindex('canvas_page', page, { supabase });
        }
        return;
      }
      for (const page of impacted) {
        await reindexMemberContentItem('canvas_page', page, { supabase, openai });
      }
      return;
    }
    const contentType = resolveContentType(entity);
    if (!contentType || !row || !row.id) return;
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
        await scheduleMemberContentReindex(contentType, item, { supabase });
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
