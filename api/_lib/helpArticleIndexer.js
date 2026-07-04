// Task #2257: Help Center AI Q&A — indexing pipeline.
//
// Chunks a help article, embeds new/changed chunks, and upserts them into
// help_article_chunk. Shared by:
//   - scripts/reindex-help-articles.mjs (backfill / bulk re-index)
//   - api/platform/help-articles.js     (re-index on save / publish / unpublish)
//
// Clients (supabase, openai) are injected so scripts can target DEST directly
// while the serverless endpoint uses the server-scoped clients.

import crypto from 'node:crypto';
import OpenAI from 'openai';
import { chunkArticleBody } from './helpArticleChunker.js';

export const EMBEDDING_MODEL = 'text-embedding-3-small';

let defaultOpenAIClient = null;

/**
 * Lazily build an OpenAI client from env, reusing the same key resolution as
 * the rest of the codebase (invoke-llm.js / ai-reports/generate.js).
 * Returns null when no key is configured.
 */
export function getDefaultOpenAIClient() {
  if (defaultOpenAIClient) return defaultOpenAIClient;
  const apiKey =
    process.env.AI_INTEGRATIONS_OPENAI_API_KEY || process.env.OPENAI_API_KEY;
  const baseURL = process.env.AI_INTEGRATIONS_OPENAI_BASE_URL;
  if (!apiKey) return null;
  defaultOpenAIClient = new OpenAI({ apiKey, ...(baseURL && { baseURL }) });
  return defaultOpenAIClient;
}

function hashChunk(content, gates) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify({ c: content, g: gates }))
    .digest('hex');
}

/**
 * Embed a batch of input strings. Returns an array of embedding vectors.
 */
export async function embedTexts(openai, inputs) {
  if (!inputs.length) return [];
  const resp = await openai.embeddings.create({
    model: EMBEDDING_MODEL,
    input: inputs,
  });
  return resp.data.map((d) => d.embedding);
}

export async function deleteArticleChunks(articleId, { supabase }) {
  const { error } = await supabase
    .from('help_article_chunk')
    .delete()
    .eq('article_id', articleId);
  if (error) throw error;
}

/**
 * Re-index a single article.
 *
 * @param {object} article  { id, slug, title, body, status, required_feature }
 * @param {object} deps     { supabase, openai }
 * @returns {Promise<object>} summary
 */
export async function reindexArticle(article, { supabase, openai } = {}) {
  if (!supabase) throw new Error('reindexArticle requires a supabase client');
  const articleId = article.id;

  // Only published articles are searchable; drop chunks for anything else so
  // drafts can never surface in AI answers.
  if (article.status !== 'published') {
    await deleteArticleChunks(articleId, { supabase });
    return { articleId, chunks: 0, embedded: 0, reused: 0, removed: true };
  }

  const built = chunkArticleBody(article.body, {
    requiredFeature: article.required_feature,
  });

  if (!built.length) {
    await deleteArticleChunks(articleId, { supabase });
    return { articleId, chunks: 0, embedded: 0, reused: 0, removed: true };
  }

  // Reuse embeddings for unchanged chunks (same content + gates).
  const { data: existing, error: exErr } = await supabase
    .from('help_article_chunk')
    .select('chunk_index, content_hash, embedding')
    .eq('article_id', articleId);
  if (exErr) throw exErr;
  const existingByIdx = new Map((existing || []).map((r) => [r.chunk_index, r]));

  const rows = [];
  const toEmbedIdx = [];
  const toEmbedInput = [];
  const nowIso = new Date().toISOString();

  for (const ch of built) {
    const hash = hashChunk(ch.content, ch.featureGates);
    const prev = existingByIdx.get(ch.chunkIndex);
    const reuse =
      prev && prev.content_hash === hash && prev.embedding != null;

    const row = {
      article_id: articleId,
      slug: article.slug,
      title: article.title,
      chunk_index: ch.chunkIndex,
      content: ch.content,
      feature_gates: ch.featureGates,
      content_hash: hash,
      updated_at: nowIso,
    };

    if (reuse) {
      row.embedding = prev.embedding;
    } else {
      toEmbedIdx.push(ch.chunkIndex);
      // Prepend the title for embedding context; store `content` raw.
      toEmbedInput.push(`${article.title}\n\n${ch.content}`);
    }
    rows.push(row);
  }

  let embedded = 0;
  if (toEmbedInput.length) {
    if (!openai) {
      throw new Error(
        'reindexArticle needs an OpenAI client to embed new/changed chunks'
      );
    }
    const embeddings = await embedTexts(openai, toEmbedInput);
    toEmbedIdx.forEach((idx, k) => {
      const row = rows.find((r) => r.chunk_index === idx);
      row.embedding = embeddings[k];
    });
    embedded = embeddings.length;
  }

  // Remove any now-stale trailing chunks (article shrank), then upsert.
  const { error: delErr } = await supabase
    .from('help_article_chunk')
    .delete()
    .eq('article_id', articleId)
    .gte('chunk_index', built.length);
  if (delErr) throw delErr;

  const { error: upErr } = await supabase
    .from('help_article_chunk')
    .upsert(rows, { onConflict: 'article_id,chunk_index' });
  if (upErr) throw upErr;

  return {
    articleId,
    chunks: rows.length,
    embedded,
    reused: rows.length - embedded,
    removed: false,
  };
}

// Re-chunk + re-embed every PUBLISHED article (reusing unchanged chunks),
// optionally scoped to a single `slug`. Shared by the CRON_SECRET-guarded
// endpoint and the platform-owner "Rebuild AI search index" button so both
// paths run identical logic. Requires an OpenAI client to embed new/changed
// chunks; callers should verify one is available and fail loudly if not.
export async function reindexAllArticles({ supabase, openai, slug = null } = {}) {
  if (!supabase) throw new Error('reindexAllArticles requires a supabase client');

  const results = {
    articles: 0,
    chunks: 0,
    embedded: 0,
    reused: 0,
    errors: 0,
    details: [],
  };

  let query = supabase
    .from('help_article')
    .select('id, slug, title, body, status, required_feature')
    .eq('status', 'published');
  if (slug) query = query.eq('slug', slug);

  const { data: articles, error } = await query;
  if (error) throw error;

  for (const article of articles || []) {
    try {
      const summary = await reindexArticle(article, { supabase, openai });
      results.articles++;
      results.chunks += summary.chunks;
      results.embedded += summary.embedded;
      results.reused += summary.reused;
      results.details.push({
        slug: article.slug,
        chunks: summary.chunks,
        embedded: summary.embedded,
        reused: summary.reused,
      });
    } catch (err) {
      results.errors++;
      results.details.push({
        slug: article.slug,
        error: err?.message || String(err),
      });
      console.error(
        `[reindexAllArticles] slug=${article.slug} error:`,
        err?.message || err
      );
    }
  }

  return results;
}
