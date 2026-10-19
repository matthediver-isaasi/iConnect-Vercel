// Task #2375 — platform-owner-authenticated endpoint that rebuilds the Member AI
// Knowledge Assistant index with one click from the admin UI.
//
// Mirrors api/platform/help-articles-reindex.js (platform-owner session RBAC, no
// CRON_SECRET needed) but targets member content (resources, events, complex
// events, news posts, blog posts) via the same reindexAllMemberContent used by
// the CRON_SECRET-guarded /api/cron/reindex-member-content.
//
// Unlike the synchronous Help reindex, member-content reindex is time-budgeted
// (Vercel caps functions at 60s), so a full catalog can't finish in one call.
//
// Task #2389 — this endpoint used to run a single slice and then hand off to the
// cron continuation chain via a fire-and-forget server-to-self fetch. On Vercel
// serverless that self-hand-off does not reliably execute, so after the first
// slice nothing renewed the concurrency heartbeat; once it aged past the 5-min
// stale threshold the UI showed "may have stalled" until the 6h cron reclaimed
// it. Since a super-admin is actively watching during a MANUAL rebuild, we now
// drive the slices from the browser instead (the pattern the Backups tab uses):
// each POST runs exactly ONE budgeted slice and returns the resume state (done
// flag, next cursor, run ownership token, and this slice's counters). The client
// re-POSTs with { runId, cursor } to process the next slice, which renews the
// heartbeat so the marker never goes stale mid-run. The scheduled 6h cron keeps
// its own server self-triggering chain as the unattended backstop.
//
// Concurrency: reuses the shared reindex lock (memberContentReindexLock) so a
// manual rebuild can't overlap the cron or another manual run. The first slice
// acquires the run; continuation slices renew ownership; completion/failure
// releases it. Embedding needs an OpenAI key
// (AI_INTEGRATIONS_OPENAI_API_KEY / OPENAI_API_KEY) that only exists in the
// Vercel/CI environment — fail loudly with a clear message if it is missing.

import { supabase } from '../_lib/database.js';
import { getSessionPlatformOwner } from '../_lib/platformSession.js';
import {
  reindexAllMemberContent,
  getDefaultOpenAIClient,
} from '../_lib/memberContentIndexer.js';
import {
  acquireReindexRun,
  renewReindexRun,
  completeReindexRun,
  readReindexStatus,
} from '../_lib/memberContentReindexLock.js';

// How much of the 60s function budget to spend indexing before returning the
// resume state to the browser. Matches the cron's slice budget, leaving headroom
// for an in-flight embedding batch plus the response.
const SLICE_BUDGET_MS = 40 * 1000;
const SOURCE_TYPES = ['resource', 'event', 'complex_event', 'news_post', 'blog_post', 'canvas_page', 'iedit_page'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validateScope(scope) {
  return (scope.tenantId === null || (typeof scope.tenantId === 'string' && UUID.test(scope.tenantId))) &&
    (scope.contentType === null || SOURCE_TYPES.includes(scope.contentType)) &&
    Number.isInteger(scope.maxEmbeddingChunks) && scope.maxEmbeddingChunks >= 0 && scope.maxEmbeddingChunks <= 100;
}

export default async function handler(req, res) {
  if (!supabase) {
    return res.status(503).json({ error: 'Database not configured' });
  }

  const owner = await getSessionPlatformOwner(req);
  if (!owner?.id) {
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

  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  const runIdFromBody = body.runId ?? null;
  if (runIdFromBody !== null && (typeof runIdFromBody !== 'string' || !UUID.test(runIdFromBody))) {
    return res.status(400).json({ error: 'Invalid runId' });
  }
  let scope = {
    tenantId: body.tenantId ?? null,
    contentType: body.contentType ?? null,
    maxEmbeddingChunks: Object.hasOwn(body, 'maxEmbeddingChunks') ? body.maxEmbeddingChunks : 20,
    platformOwnerId: owner.id,
  };
  if (runIdFromBody) {
    const status = await readReindexStatus({ supabase });
    if (!status.ok) return res.status(503).json({ error: 'Cannot verify rebuild authority; no indexing performed' });
    if (status.runId !== runIdFromBody) {
      return res.status(409).json({ error: 'Rebuild ownership expired or was superseded; start a new operation' });
    }
    if (status.scope?.platformOwnerId !== owner.id || !validateScope(status.scope)) {
      return res.status(403).json({ error: 'This session does not own a scoped platform rebuild' });
    }
    scope = status.scope;
    for (const key of ['tenantId', 'contentType', 'maxEmbeddingChunks']) {
      if (Object.hasOwn(body, key) && body[key] !== scope[key]) {
        return res.status(409).json({ error: 'Continuation scope and embedding allowance cannot change; start a new operation' });
      }
    }
  }
  if (!validateScope(scope)) {
    return res.status(400).json({ error: 'Use a tenant UUID, supported contentType and integer maxEmbeddingChunks from 0 to 100' });
  }
  if (scope.tenantId) {
    const { data: tenant, error } = await supabase.from('tenant').select('id').eq('id', scope.tenantId).maybeSingle();
    if (error) return res.status(503).json({ error: 'Cannot verify tenant scope; no indexing performed' });
    if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
  }
  const cursor = body.cursor ?? null;
  if (cursor !== null && (
    typeof cursor !== 'object' || Array.isArray(cursor) ||
    (cursor.phase && cursor.phase !== 'sweep') ||
    (!cursor.phase && (!SOURCE_TYPES.includes(cursor.type) ||
      (scope.contentType && cursor.type !== scope.contentType) ||
      (cursor.lastId != null && (typeof cursor.lastId !== 'string' || !UUID.test(cursor.lastId)))))
  )) return res.status(400).json({ error: 'Invalid cursor for the requested scope' });

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

  // Concurrency guard. First slice (no runId) acquires the run; if a live chain
  // (cron or another manual rebuild) is already progressing, defer instead of
  // running a parallel pass. Continuation slices renew ownership; if a newer run
  // has taken over, stand down. Manual operations fail closed if their durable
  // scope/budget cannot be verified. Either path freshens the heartbeat
  // while the browser keeps driving slices back-to-back.
  let runId;
  if (runIdFromBody) {
    const renew = await renewReindexRun({ supabase, runId: runIdFromBody, scope });
    if (renew.degraded) return res.status(503).json({ error: 'Cannot renew rebuild authority; no indexing performed' });
    if (!renew.owns) {
      return res.status(200).json({
        ok: true,
        skipped: true,
        reason: 'superseded',
        activeRunId: renew.activeRunId || null,
      });
    }
    runId = runIdFromBody;
  } else {
    const acq = await acquireReindexRun({ supabase, scope });
    if (acq.degraded) return res.status(503).json({ error: 'Cannot persist rebuild scope; no indexing performed' });
    if (!acq.acquired) {
      return res.status(200).json({
        ok: true,
        skipped: true,
        reason: 'in_progress',
        activeRunId: acq.activeRunId || null,
        ageMs: acq.ageMs ?? null,
      });
    }
    runId = acq.runId;
  }

  const startTime = Date.now();

  try {
    const results = await reindexAllMemberContent({
      supabase,
      openai,
      tenantId: scope.tenantId,
      contentType: scope.contentType,
      maxEmbeddingChunks: scope.maxEmbeddingChunks,
      deadlineMs: startTime + SLICE_BUDGET_MS,
      cursor,
    });

    // Release the concurrency marker only when the whole pass is done. While
    // there's more to do we leave the marker in place — it was just renewed at
    // the top of this slice, so it stays fresh — and the browser drives the next
    // slice. If the browser stops (tab closed), the marker ages out after the
    // stale threshold and the 6h cron reclaims and finishes the run.
    const paused = results.stopReason === 'embedding_budget';
    if (results.done || paused) {
      // A scoped pass is not evidence that the full global corpus was rebuilt.
      await completeReindexRun({ supabase, runId,
        completed: results.done && !scope.tenantId && !scope.contentType });
    }

    return res.status(200).json({
      ...results,
      ok: results.errors === 0,
      durationMs: Date.now() - startTime,
      done: results.done,
      nextCursor: results.nextCursor || null,
      runId,
      scope,
      paused,
      ...(paused ? { pauseMessage: 'Embedding allowance exhausted. Automatic continuation stopped. Review the source coverage, then explicitly resume with an allowance up to 100 chunks per slice.' } : {}),
    });
  } catch (err) {
    console.error('[Platform Member Reindex] fatal:', err);
    // Release the marker so the next tick restarts immediately rather than
    // waiting out the marker TTL.
    await completeReindexRun({ supabase, runId });
    return res.status(500).json({ ok: false, error: err.message, runId });
  }
}
