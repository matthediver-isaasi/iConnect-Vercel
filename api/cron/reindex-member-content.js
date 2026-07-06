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
import {
  acquireReindexRun,
  renewReindexRun,
  completeReindexRun,
} from '../_lib/memberContentReindexLock.js';

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
  // Internal ownership token for the concurrency marker (Task #2372), minted at
  // hop 0 and carried down the chain so continuation slices can re-assert it.
  const runIdFromBody = typeof body.runId === 'string' ? body.runId : null;

  const startTime = Date.now();
  const scope = { tenantId: tenantId || null, contentType: contentType || null };

  // Concurrency guard: a fresh scheduled tick (hop 0) claims the run; if a live
  // chain is already progressing it defers instead of starting a parallel pass.
  // Continuation hops renew ownership; if a newer run has taken over, the stale
  // chain stands down. Fail-open: any marker error lets indexing proceed.
  let runId = runIdFromBody;
  if (hop === 0) {
    const acq = await acquireReindexRun({ supabase, scope });
    if (!acq.acquired) {
      console.log(
        '[cron/reindex-member-content] live chain in progress ' +
          `(runId=${acq.activeRunId}, ageMs=${acq.ageMs}); deferring this tick.`
      );
      return res.status(200).json({
        ok: true,
        skipped: true,
        reason: 'in_progress',
        activeRunId: acq.activeRunId || null,
        ageMs: acq.ageMs ?? null,
      });
    }
    runId = acq.runId;
  } else {
    const renew = await renewReindexRun({ supabase, runId, scope });
    if (!renew.owns) {
      console.log(
        '[cron/reindex-member-content] run superseded by a newer chain ' +
          `(activeRunId=${renew.activeRunId}); this chain is standing down.`
      );
      return res.status(200).json({
        ok: true,
        skipped: true,
        reason: 'superseded',
        activeRunId: renew.activeRunId || null,
      });
    }
  }

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
            runId,
          });
          continuation = { dispatched: dispatch.ok, reason: dispatch.error || null };
        }
      }
    }

    // Release the concurrency marker whenever this chain is NOT handing off to a
    // live successor: the pass finished, or it dead-ended (hop cap / no origin /
    // dispatch failed). Clearing lets the next 6h cron restart immediately
    // instead of waiting out the marker TTL, preserving "restart is free". Only
    // when a continuation was actually dispatched do we leave the marker for the
    // downstream slice to renew.
    if (results.done || (continuation && continuation.dispatched !== true)) {
      await completeReindexRun({ supabase, runId, completed: results.done });
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
    // The chain is aborting mid-slice; release the marker so the next 6h cron
    // restarts immediately rather than waiting out the marker TTL.
    await completeReindexRun({ supabase, runId });
    return res.status(500).json({ ok: false, error: err.message });
  }
}
