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
// Task #2371 — Vercel functions are capped at 60s (vercel.json maxDuration), so
// a full first backfill (or any large tenant) can't finish in one invocation.
// Each run now processes a time-budgeted slice and, if there's more to do,
// self-triggers the next slice with a resume cursor. Re-indexing is idempotent
// (unchanged chunks reuse their embedding), so even if the chain is dropped the
// 6h cron restart makes progress off the persisted chunk state.
//
// Auth: Bearer CRON_SECRET, matching the other /api/cron/* endpoints.
// Optional `tenantId` / `contentType` (query or JSON body) scope the run.
// `cursor` (JSON body) is internal — the resume token the chain feeds itself.

import { supabase } from '../_lib/database.js';
import {
  reindexAllMemberContent,
  getDefaultOpenAIClient,
} from '../_lib/memberContentIndexer.js';

// How much of the 60s function budget to spend on indexing before stopping to
// hand off to the next slice. Leaves headroom for an in-flight embedding batch
// plus the continuation dispatch.
const SLICE_BUDGET_MS = 40 * 1000;
// How long to wait on the continuation dispatch before abandoning the caller's
// side of the connection. The downstream invocation runs to completion
// independent of this signal.
const DISPATCH_ABORT_MS = 2000;
// Runaway guard: progress is monotonic (lastId only advances, then sweep, then
// done), so this can only be hit if something regresses — cap the chain so a
// bug can't burn embedding budget indefinitely.
const MAX_HOPS = 1000;

function getOrigin(req) {
  const forwardedProto = (req.headers['x-forwarded-proto'] || '').toString().split(',')[0].trim();
  const forwardedHost = (req.headers['x-forwarded-host'] || req.headers.host || '').toString().split(',')[0].trim();
  const headerOrigin = forwardedHost ? `${forwardedProto || 'https'}://${forwardedHost}` : '';
  return (process.env.VITE_APP_URL || headerOrigin || '').replace(/\/+$/, '');
}

async function dispatchContinuation(origin, body) {
  const url = `${origin}/api/cron/reindex-member-content`;
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), DISPATCH_ABORT_MS);
  try {
    await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.CRON_SECRET}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    return { ok: true };
  } catch (err) {
    if (err && err.name === 'AbortError') {
      // Expected: we aborted our side after the request was dispatched.
      return { ok: true };
    }
    console.warn('[cron/reindex-member-content] continuation dispatch failed:', err?.message);
    return { ok: false, error: String(err?.message || err) };
  } finally {
    clearTimeout(t);
  }
}

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

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const tenantId =
    (req.query && req.query.tenantId) || body.tenantId || null;
  const contentType =
    (req.query && req.query.contentType) || body.contentType || null;
  // Internal resume token carried by the self-trigger chain.
  const cursor = body.cursor && typeof body.cursor === 'object' ? body.cursor : null;
  const hop = Number.isInteger(body.hop) ? body.hop : 0;

  const startTime = Date.now();

  try {
    const results = await reindexAllMemberContent({
      supabase,
      openai,
      tenantId: tenantId || null,
      contentType: contentType || null,
      deadlineMs: startTime + SLICE_BUDGET_MS,
      cursor,
    });

    let continuation = null;
    if (!results.done && results.nextCursor) {
      if (hop + 1 >= MAX_HOPS) {
        console.error(
          `[cron/reindex-member-content] hop cap (${MAX_HOPS}) reached; ` +
            'stopping chain. Next 6h cron will resume from the start.'
        );
        continuation = { dispatched: false, reason: 'hop_cap' };
      } else {
        const origin = getOrigin(req);
        if (!origin) {
          console.error(
            '[cron/reindex-member-content] no origin to self-trigger; ' +
              'next slice will be picked up by the 6h cron.'
          );
          continuation = { dispatched: false, reason: 'no_origin' };
        } else {
          const dispatch = await dispatchContinuation(origin, {
            tenantId: tenantId || null,
            contentType: contentType || null,
            cursor: results.nextCursor,
            hop: hop + 1,
          });
          continuation = { dispatched: dispatch.ok, reason: dispatch.error || null };
        }
      }
    }

    return res.status(200).json({
      ok: results.errors === 0,
      durationMs: Date.now() - startTime,
      tenantId: tenantId || null,
      contentType: contentType || null,
      hop,
      done: results.done,
      nextCursor: results.nextCursor || null,
      continuation,
      ...results,
    });
  } catch (err) {
    console.error('[cron/reindex-member-content] fatal:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
