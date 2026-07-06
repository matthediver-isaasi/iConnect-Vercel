// Task #2363 — CRON_SECRET-guarded endpoint that rebuilds the Member AI
// Knowledge Assistant index server-side on Vercel.
//
// Embedding member content chunks needs an OpenAI key
// (AI_INTEGRATIONS_OPENAI_API_KEY / OPENAI_API_KEY) that only exists in the
// Vercel/CI environment, never in the Replit workspace — so the backfill in
// scripts/reindex-member-content.mjs --apply cannot run from the workspace.
// This mirrors that script's --apply path (chunk + embed every INDEXABLE row of
// resources / events / complex_events / news_post / blog_post, reusing
// unchanged chunks) but runs where the key is present. It also reconciles the
// index for content edited through non-generic endpoints (e.g. the multi-step
// event flow) that bypass the on-save hook.
//
// Auth: Bearer CRON_SECRET, matching the other /api/cron/* endpoints.
// Optional `tenantId` / `contentType` (query or JSON body) scope the run.

import { supabase } from '../_lib/database.js';
import {
  reindexAllMemberContent,
  getDefaultOpenAIClient,
} from '../_lib/memberContentIndexer.js';

export default async function handler(req, res) {
  const authHeader = req.headers.authorization;
  const cronSecret = process.env.CRON_SECRET;

  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    console.log('[cron/reindex-member-content] Unauthorized request');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!supabase) {
    return res.status(500).json({ error: 'Database not configured' });
  }

  const openai = getDefaultOpenAIClient();
  if (!openai) {
    console.error(
      '[cron/reindex-member-content] No OpenAI API key configured ' +
        '(AI_INTEGRATIONS_OPENAI_API_KEY / OPENAI_API_KEY)'
    );
    return res.status(500).json({
      ok: false,
      error:
        'No OpenAI API key configured (AI_INTEGRATIONS_OPENAI_API_KEY / OPENAI_API_KEY). ' +
        'Run where the key is available (e.g. Vercel/CI).',
    });
  }

  const tenantId =
    (req.query && req.query.tenantId) ||
    (req.body && typeof req.body === 'object' && req.body.tenantId) ||
    null;
  const contentType =
    (req.query && req.query.contentType) ||
    (req.body && typeof req.body === 'object' && req.body.contentType) ||
    null;

  const startTime = Date.now();

  try {
    const results = await reindexAllMemberContent({
      supabase,
      openai,
      tenantId: tenantId || null,
      contentType: contentType || null,
    });

    return res.status(200).json({
      ok: results.errors === 0,
      durationMs: Date.now() - startTime,
      tenantId: tenantId || null,
      contentType: contentType || null,
      ...results,
    });
  } catch (err) {
    console.error('[cron/reindex-member-content] fatal:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
