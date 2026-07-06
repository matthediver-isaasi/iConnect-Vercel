// Task #2375 — platform-owner-authenticated endpoint that rebuilds the Member AI
// Knowledge Assistant index with one click from the admin UI.
//
// Mirrors api/platform/help-articles-reindex.js (platform-owner session RBAC, no
// CRON_SECRET needed) but targets member content (resources, events, complex
// events, news posts, blog posts) via the same reindexAllMemberContent used by
// the CRON_SECRET-guarded /api/cron/reindex-member-content.
//
// Unlike the synchronous Help reindex, member-content reindex is time-budgeted
// and self-continues across slices (Vercel caps functions at 60s). So this
// endpoint runs a single budgeted slice to return a real summary for the UI
// toast, then — if there is more to do — hands off to the existing cron
// continuation chain (which carries our runId forward) and returns promptly
// instead of blocking for the entire catalog.
//
// Concurrency: reuses the shared reindex lock (memberContentReindexLock) so a
// manual rebuild can't overlap the cron or another manual run. Embedding needs
// an OpenAI key (AI_INTEGRATIONS_OPENAI_API_KEY / OPENAI_API_KEY) that only
// exists in the Vercel/CI environment — fail loudly with a clear message if it
// is missing.

import { supabase } from '../_lib/database.js';
import { getSessionPlatformOwner } from '../_lib/platformSession.js';
import {
  reindexAllMemberContent,
  getDefaultOpenAIClient,
} from '../_lib/memberContentIndexer.js';
import {
  acquireReindexRun,
  completeReindexRun,
  readReindexStatus,
} from '../_lib/memberContentReindexLock.js';

// How much of the 60s function budget to spend indexing before returning and
// handing off to the continuation chain. Matches the cron's slice budget.
const SLICE_BUDGET_MS = 40 * 1000;
// How long to wait on the continuation dispatch before abandoning our side of
// the connection; the downstream invocation runs to completion independently.
const DISPATCH_ABORT_MS = 2000;

function getOrigin(req) {
  const forwardedProto = (req.headers['x-forwarded-proto'] || '').toString().split(',')[0].trim();
  const forwardedHost = (req.headers['x-forwarded-host'] || req.headers.host || '').toString().split(',')[0].trim();
  const headerOrigin = forwardedHost ? `${forwardedProto || 'https'}://${forwardedHost}` : '';
  return (process.env.VITE_APP_URL || headerOrigin || '').replace(/\/+$/, '');
}

// Hand the remaining slices to the existing cron continuation chain. It re-uses
// the concurrency marker via renewReindexRun (hop > 0) with the runId we minted,
// so the chain keeps ownership without spawning a parallel pass.
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
    console.warn('[Platform Member Reindex] continuation dispatch failed:', err?.message);
    return { ok: false, error: String(err?.message || err) };
  } finally {
    clearTimeout(t);
  }
}

export default async function handler(req, res) {
  if (!supabase) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  const owner = await getSessionPlatformOwner(req);
  if (!owner) {
    return res.status(403).json({ error: 'Platform owner access required' });
  }

  // GET: lightweight status readout for the UI to poll — whether a member-content
  // reindex is currently running (or stalled) and when the last full pass
  // completed. Reflects the shared concurrency marker; needs no OpenAI key.
  if (req.method === 'GET') {
    const status = await readReindexStatus({ supabase });
    return res.status(200).json(status);
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Embedding new/changed chunks requires an OpenAI key. Fail loudly rather than
  // silently reporting success with a stale index.
  const openai = getDefaultOpenAIClient();
  if (!openai) {
    console.error(
      '[Platform Member Reindex] No OpenAI API key configured ' +
        '(AI_INTEGRATIONS_OPENAI_API_KEY / OPENAI_API_KEY)'
    );
    return res.status(500).json({
      ok: false,
      error:
        'No OpenAI API key is configured, so the AI search index cannot be rebuilt. ' +
        'Add AI_INTEGRATIONS_OPENAI_API_KEY (or OPENAI_API_KEY) in the deployment environment and try again.',
    });
  }

  const scope = { tenantId: null, contentType: null };

  // Concurrency guard: claim the run (hop 0). If a live chain (cron or another
  // manual rebuild) is already progressing, defer instead of running a parallel
  // pass. Fail-open: a marker error still lets indexing proceed.
  const acq = await acquireReindexRun({ supabase, scope });
  if (!acq.acquired) {
    return res.status(200).json({
      ok: true,
      skipped: true,
      reason: 'in_progress',
      activeRunId: acq.activeRunId || null,
      ageMs: acq.ageMs ?? null,
    });
  }
  const runId = acq.runId;

  const startTime = Date.now();

  try {
    const results = await reindexAllMemberContent({
      supabase,
      openai,
      tenantId: null,
      contentType: null,
      deadlineMs: startTime + SLICE_BUDGET_MS,
      cursor: null,
    });

    let continuation = null;
    if (!results.done && results.nextCursor) {
      const origin = getOrigin(req);
      if (!origin) {
        console.error(
          '[Platform Member Reindex] no origin to hand off continuation; ' +
            'next slice will be picked up by the 6h cron.'
        );
        continuation = { dispatched: false, reason: 'no_origin' };
      } else {
        const dispatch = await dispatchContinuation(origin, {
          tenantId: null,
          contentType: null,
          cursor: results.nextCursor,
          hop: 1,
          runId,
        });
        continuation = { dispatched: dispatch.ok, reason: dispatch.error || null };
      }
    }

    // Release the concurrency marker unless we handed off to a live successor.
    // If the pass finished, or the hand-off failed / had no origin, clear it so
    // the next tick can restart immediately. Only leave the marker in place when
    // a continuation was actually dispatched for the downstream slice to renew.
    if (results.done || (continuation && continuation.dispatched !== true)) {
      await completeReindexRun({ supabase, runId, completed: results.done });
    }

    return res.status(200).json({
      ok: results.errors === 0,
      durationMs: Date.now() - startTime,
      done: results.done,
      continuation,
      ...results,
    });
  } catch (err) {
    console.error('[Platform Member Reindex] fatal:', err);
    // Release the marker so the next tick restarts immediately rather than
    // waiting out the marker TTL.
    await completeReindexRun({ supabase, runId });
    return res.status(500).json({ ok: false, error: err.message });
  }
}
