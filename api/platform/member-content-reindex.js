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

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  // Resume token carried by the browser-driven loop across slices.
  const cursor = body.cursor && typeof body.cursor === 'object' ? body.cursor : null;
  // Run ownership token minted on the first slice and echoed back on every
  // continuation POST so we renew (not re-acquire) the same concurrency marker.
  const runIdFromBody = typeof body.runId === 'string' && body.runId ? body.runId : null;

  const scope = { tenantId: null, contentType: null };

  // Concurrency guard. First slice (no runId) acquires the run; if a live chain
  // (cron or another manual rebuild) is already progressing, defer instead of
  // running a parallel pass. Continuation slices renew ownership; if a newer run
  // has taken over, stand down. Fail-open: a marker error still lets indexing
  // proceed. Either path freshens the heartbeat, so the marker never goes stale
  // while the browser keeps driving slices back-to-back.
  let runId;
  if (runIdFromBody) {
    const renew = await renewReindexRun({ supabase, runId: runIdFromBody, scope });
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
      tenantId: null,
      contentType: null,
      deadlineMs: startTime + SLICE_BUDGET_MS,
      cursor,
    });

    // Release the concurrency marker only when the whole pass is done. While
    // there's more to do we leave the marker in place — it was just renewed at
    // the top of this slice, so it stays fresh — and the browser drives the next
    // slice. If the browser stops (tab closed), the marker ages out after the
    // stale threshold and the 6h cron reclaims and finishes the run.
    if (results.done) {
      await completeReindexRun({ supabase, runId, completed: true });
    }

    return res.status(200).json({
      ...results,
      ok: results.errors === 0,
      durationMs: Date.now() - startTime,
      done: results.done,
      nextCursor: results.nextCursor || null,
      runId,
    });
  } catch (err) {
    console.error('[Platform Member Reindex] fatal:', err);
    // Release the marker so the next tick restarts immediately rather than
    // waiting out the marker TTL.
    await completeReindexRun({ supabase, runId });
    return res.status(500).json({ ok: false, error: err.message, runId });
  }
}
