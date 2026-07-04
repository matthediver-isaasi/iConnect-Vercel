/**
 * Backfill / rebuild the Help Center AI Q&A index (Task #2257).
 *
 * Chunks every PUBLISHED help_article, embeds new/changed chunks, and upserts
 * them into help_article_chunk on DEST. Unchanged chunks (same text + gates)
 * keep their existing embedding, so re-runs are cheap.
 *
 * Reads help_article via @supabase/supabase-js against DEST (DEST_SUPABASE_URL /
 * DEST_SUPABASE_KEY), matching the workspace DB-access convention in replit.md.
 * Embeddings need an OpenAI key (AI_INTEGRATIONS_OPENAI_API_KEY / OPENAI_API_KEY)
 * — only required with --apply.
 *
 * Usage:
 *   node scripts/reindex-help-articles.mjs               # dry-run (chunk plan only)
 *   node scripts/reindex-help-articles.mjs --apply       # embed + write
 *   node scripts/reindex-help-articles.mjs --apply --slug=getting-started
 */
import { createClient } from '@supabase/supabase-js';
import { chunkArticleBody } from '../api/_lib/helpArticleChunker.js';
import {
  reindexArticle,
  getDefaultOpenAIClient,
} from '../api/_lib/helpArticleIndexer.js';

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const slugArg = args.find((a) => a.startsWith('--slug='));
const onlySlug = slugArg ? slugArg.split('=')[1] : null;

const SUPABASE_URL = process.env.DEST_SUPABASE_URL;
const SUPABASE_KEY = process.env.DEST_SUPABASE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('DEST_SUPABASE_URL and DEST_SUPABASE_KEY must be set');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false },
});

async function run() {
  let query = supabase
    .from('help_article')
    .select('id, slug, title, body, status, required_feature')
    .eq('status', 'published');
  if (onlySlug) query = query.eq('slug', onlySlug);

  const { data: articles, error } = await query;
  if (error) throw error;

  console.log(
    `${APPLY ? 'APPLY' : 'DRY-RUN'}: ${articles.length} published article(s)${
      onlySlug ? ` (slug=${onlySlug})` : ''
    }\n`
  );

  let openai = null;
  if (APPLY) {
    openai = getDefaultOpenAIClient();
    if (!openai) {
      console.error(
        'No OpenAI API key configured (AI_INTEGRATIONS_OPENAI_API_KEY / OPENAI_API_KEY). ' +
          'Cannot embed. Run where the key is available (e.g. Vercel/CI).'
      );
      process.exit(1);
    }
  }

  let totalChunks = 0;
  let totalEmbedded = 0;

  for (const article of articles) {
    if (!APPLY) {
      const chunks = chunkArticleBody(article.body, {
        requiredFeature: article.required_feature,
      });
      totalChunks += chunks.length;
      const gated = chunks.filter((c) => c.featureGates.length).length;
      console.log(
        `  [plan] ${article.slug}: ${chunks.length} chunk(s), ${gated} gated`
      );
      continue;
    }

    const summary = await reindexArticle(article, { supabase, openai });
    totalChunks += summary.chunks;
    totalEmbedded += summary.embedded;
    console.log(
      `  [done] ${article.slug}: ${summary.chunks} chunk(s), ` +
        `${summary.embedded} embedded, ${summary.reused} reused`
    );
  }

  console.log(
    `\n${APPLY ? 'Applied' : 'Planned'}: ${totalChunks} chunk(s)` +
      (APPLY ? `, ${totalEmbedded} embedded.` : '. Re-run with --apply to write.')
  );
}

run().catch((err) => {
  console.error('Re-index failed:', err);
  process.exit(1);
});
