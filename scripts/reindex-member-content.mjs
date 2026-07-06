/**
 * Backfill / rebuild the Member AI Knowledge Assistant index (Task #2363).
 *
 * Chunks every INDEXABLE row of member-facing content (resources, events,
 * complex_events, news_post, blog_post), embeds new/changed chunks, and upserts
 * them into member_content_chunk on DEST. Unchanged chunks (same text) keep
 * their existing embedding, so re-runs are cheap.
 *
 * Reads source rows via @supabase/supabase-js against DEST (DEST_SUPABASE_URL /
 * DEST_SUPABASE_KEY), matching the workspace DB-access convention in replit.md.
 * Embeddings need an OpenAI key (AI_INTEGRATIONS_OPENAI_API_KEY / OPENAI_API_KEY)
 * — only required with --apply.
 *
 * Usage:
 *   node scripts/reindex-member-content.mjs                       # dry-run (chunk plan)
 *   node scripts/reindex-member-content.mjs --apply              # embed + write
 *   node scripts/reindex-member-content.mjs --apply --tenant=<uuid>
 *   node scripts/reindex-member-content.mjs --apply --type=resource
 */
import { createClient } from '@supabase/supabase-js';
import { chunkMemberContent } from '../api/_lib/memberContentChunker.js';
import {
  reindexMemberContentItem,
  reindexAllMemberContent,
  getDefaultOpenAIClient,
  isIndexable,
  CONTENT_TYPE_CONFIG,
} from '../api/_lib/memberContentIndexer.js';
import { CONTENT_TYPES } from '../api/_lib/memberContentVisibility.js';

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const tenantArg = args.find((a) => a.startsWith('--tenant='));
const typeArg = args.find((a) => a.startsWith('--type='));
const onlyTenant = tenantArg ? tenantArg.split('=')[1] : null;
const onlyType = typeArg ? typeArg.split('=')[1] : null;

const SUPABASE_URL = process.env.DEST_SUPABASE_URL;
const SUPABASE_KEY = process.env.DEST_SUPABASE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('DEST_SUPABASE_URL and DEST_SUPABASE_KEY must be set');
  process.exit(1);
}
if (onlyType && !CONTENT_TYPES.includes(onlyType)) {
  console.error(`--type must be one of: ${CONTENT_TYPES.join(', ')}`);
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false },
});

async function dryRun() {
  const types = onlyType ? [onlyType] : CONTENT_TYPES;
  let totalRows = 0;
  let totalIndexable = 0;
  let totalChunks = 0;

  for (const type of types) {
    const cfg = CONTENT_TYPE_CONFIG[type];
    const PAGE = 500;
    let from = 0;
    let rowsForType = 0;
    let indexableForType = 0;
    let chunksForType = 0;

    for (;;) {
      let query = supabase
        .from(cfg.table)
        .select(cfg.columns)
        .order('id', { ascending: true })
        .range(from, from + PAGE - 1);
      if (onlyTenant) query = query.eq('tenant_id', onlyTenant);

      const { data: rows, error } = await query;
      if (error) throw error;
      if (!rows || rows.length === 0) break;

      for (const item of rows) {
        rowsForType++;
        if (!isIndexable(type, item)) continue;
        indexableForType++;
        chunksForType += chunkMemberContent(item, type).length;
      }

      if (rows.length < PAGE) break;
      from += PAGE;
    }

    totalRows += rowsForType;
    totalIndexable += indexableForType;
    totalChunks += chunksForType;
    console.log(
      `  [plan] ${type}: ${rowsForType} row(s), ${indexableForType} indexable, ${chunksForType} chunk(s)`
    );
  }

  console.log(
    `\nDRY-RUN total: ${totalRows} row(s), ${totalIndexable} indexable, ${totalChunks} chunk(s). ` +
      'Re-run with --apply to embed + write.'
  );
}

async function apply() {
  const openai = getDefaultOpenAIClient();
  if (!openai) {
    console.error(
      'No OpenAI API key configured (AI_INTEGRATIONS_OPENAI_API_KEY / OPENAI_API_KEY). ' +
        'Cannot embed. Run where the key is available (e.g. Vercel/CI).'
    );
    process.exit(1);
  }

  const results = await reindexAllMemberContent({
    supabase,
    openai,
    tenantId: onlyTenant || null,
    contentType: onlyType || null,
  });

  console.log(
    `\nApplied: ${results.items} item(s), ${results.chunks} chunk(s), ` +
      `${results.embedded} embedded, ${results.reused} reused, ` +
      `${results.removed} removed, ${results.errors} error(s). ` +
      `Orphan sweep: ${results.orphansRemoved || 0} source(s) / ` +
      `${results.orphanChunksRemoved || 0} chunk(s) purged.`
  );
  if (results.details.length) {
    for (const d of results.details) {
      console.log(`  [error] ${d.contentType}/${d.sourceId}: ${d.error}`);
    }
  }
}

async function run() {
  console.log(
    `${APPLY ? 'APPLY' : 'DRY-RUN'}${onlyTenant ? ` tenant=${onlyTenant}` : ''}${
      onlyType ? ` type=${onlyType}` : ''
    }\n`
  );
  if (APPLY) {
    await apply();
  } else {
    await dryRun();
  }
}

run().catch((err) => {
  console.error('Re-index failed:', err);
  process.exit(1);
});
