// Task #2276 — platform-owner-authenticated endpoint that rebuilds the Help
// Center AI Q&A index with one click from the admin UI.
//
// Same reindex logic as the CRON_SECRET-guarded /api/cron/reindex-help-articles
// (both share reindexAllArticles), but gated by platform-owner session RBAC so a
// non-technical owner can trigger a full rebuild without shell access or the
// CRON_SECRET. Embedding new/changed chunks needs an OpenAI key
// (AI_INTEGRATIONS_OPENAI_API_KEY / OPENAI_API_KEY) that only exists in the
// Vercel/CI environment — fail loudly with a clear message if it is missing.

import { supabase } from '../_lib/database.js';
import { getSessionPlatformOwner } from '../_lib/platformSession.js';
import {
  reindexAllArticles,
  getDefaultOpenAIClient,
} from '../_lib/helpArticleIndexer.js';

export default async function handler(req, res) {
  if (!supabase) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  const owner = await getSessionPlatformOwner(req);
  if (!owner) {
    return res.status(403).json({ error: 'Platform owner access required' });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Embedding new/changed chunks requires an OpenAI key. Fail loudly rather
  // than silently reporting success with a stale index.
  const openai = getDefaultOpenAIClient();
  if (!openai) {
    console.error(
      '[Platform Help Reindex] No OpenAI API key configured ' +
        '(AI_INTEGRATIONS_OPENAI_API_KEY / OPENAI_API_KEY)'
    );
    return res.status(500).json({
      ok: false,
      error:
        'No OpenAI API key is configured, so the AI search index cannot be rebuilt. ' +
        'Add AI_INTEGRATIONS_OPENAI_API_KEY (or OPENAI_API_KEY) in the deployment environment and try again.',
    });
  }

  const onlySlug =
    (req.body && typeof req.body === 'object' && req.body.slug) || null;

  const startTime = Date.now();

  try {
    const results = await reindexAllArticles({
      supabase,
      openai,
      slug: onlySlug || null,
    });

    return res.status(200).json({
      ok: results.errors === 0,
      durationMs: Date.now() - startTime,
      slug: onlySlug || null,
      ...results,
    });
  } catch (err) {
    console.error('[Platform Help Reindex] fatal:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
