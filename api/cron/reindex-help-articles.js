// Task #2275 — one-shot, CRON_SECRET-guarded endpoint that rebuilds the Help
// Center AI Q&A index server-side on Vercel.
//
// Embedding help_article chunks needs an OpenAI key
// (AI_INTEGRATIONS_OPENAI_API_KEY / OPENAI_API_KEY) that only exists in the
// Vercel/CI environment, never in the Replit workspace — so the backfill in
// scripts/reindex-help-articles.mjs --apply cannot run from the workspace.
// This mirrors that script's --apply path (chunk + embed every PUBLISHED
// article, reusing unchanged chunks) but runs where the key is present, so the
// whole backfill can be triggered with a single authenticated request instead
// of re-saving each article through the admin UI one-by-one.
//
// Auth: Bearer CRON_SECRET, matching the other /api/cron/* endpoints.
// Optional `slug` (query or JSON body) scopes the run to a single article.

import { supabase } from '../_lib/database.js';
import {
  reindexArticle,
  getDefaultOpenAIClient,
} from '../_lib/helpArticleIndexer.js';

export default async function handler(req, res) {
  const authHeader = req.headers.authorization;
  const cronSecret = process.env.CRON_SECRET;

  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    console.log('[cron/reindex-help-articles] Unauthorized request');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!supabase) {
    return res.status(500).json({ error: 'Database not configured' });
  }

  // Embedding new/changed chunks requires an OpenAI key. Fail loudly rather
  // than silently reporting success with a stale index.
  const openai = getDefaultOpenAIClient();
  if (!openai) {
    console.error(
      '[cron/reindex-help-articles] No OpenAI API key configured ' +
        '(AI_INTEGRATIONS_OPENAI_API_KEY / OPENAI_API_KEY)'
    );
    return res.status(500).json({
      ok: false,
      error:
        'No OpenAI API key configured (AI_INTEGRATIONS_OPENAI_API_KEY / OPENAI_API_KEY). ' +
        'Run where the key is available (e.g. Vercel/CI).',
    });
  }

  const onlySlug =
    (req.query && req.query.slug) ||
    (req.body && typeof req.body === 'object' && req.body.slug) ||
    null;

  const startTime = Date.now();
  const results = {
    articles: 0,
    chunks: 0,
    embedded: 0,
    reused: 0,
    errors: 0,
    details: [],
  };

  try {
    let query = supabase
      .from('help_article')
      .select('id, slug, title, body, status, required_feature')
      .eq('status', 'published');
    if (onlySlug) query = query.eq('slug', onlySlug);

    const { data: articles, error } = await query;
    if (error) {
      console.error(
        '[cron/reindex-help-articles] failed to list articles:',
        error.message
      );
      return res.status(500).json({ ok: false, error: error.message });
    }

    const list = articles || [];
    for (const article of list) {
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
          `[cron/reindex-help-articles] slug=${article.slug} error:`,
          err?.message || err
        );
      }
    }

    return res.status(200).json({
      ok: results.errors === 0,
      durationMs: Date.now() - startTime,
      slug: onlySlug || null,
      ...results,
    });
  } catch (err) {
    console.error('[cron/reindex-help-articles] fatal:', err);
    return res.status(500).json({ ok: false, error: err.message, ...results });
  }
}
