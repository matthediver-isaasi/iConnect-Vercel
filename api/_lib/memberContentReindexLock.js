// Task #2372 — Lightweight concurrency guard for the member-content reindex
// chain (`/api/cron/reindex-member-content`).
//
// The reindex cron runs as a self-triggering chain of time-budgeted slices with
// no hard job lock (re-indexing is idempotent, so a dropped chain restarts
// cheaply on the next 6h cron). The one waste case is overlap: if a long chain
// is still working when the next scheduled 6h cron fires, two chains run in
// parallel — correct, but doubles DB round-trips and can re-embed content that
// changed between passes, burning OpenAI budget on large tenants.
//
// This guard stores a single "reindex in progress" marker in `system_settings`
// (a global, null-tenant row) carrying a `runId` and a `heartbeatAt` timestamp:
//
//   - A fresh scheduled tick (hop 0) calls `acquireReindexRun`. If a live marker
//     (heartbeat within RUN_STALE_MS) already exists it DEFERS instead of
//     starting a parallel pass. A stale marker (dead chain) is reclaimed.
//   - Each continuation slice (hop > 0) calls `renewReindexRun`, which refreshes
//     the heartbeat only while it still OWNS the run (marker runId matches). If a
//     newer run has taken over (runId mismatch), the stale chain stops itself.
//   - `completeReindexRun` clears the marker when the chain finishes (or dies) so
//     the next tick restarts immediately rather than waiting out the TTL.
//
// Everything here is best-effort and FAIL-OPEN: if the marker can't be read or
// written, indexing proceeds anyway. The guard must never be a new hard
// dependency that breaks the "restart is free" property — losing the guard just
// reverts to the pre-existing (correct, if wasteful) overlap behaviour.

import crypto from 'crypto';

const SETTING_KEY = 'member_content_reindex_run';
// A healthy chain re-heartbeats at the start of every slice (~<=60s apart, since
// Vercel caps the function at 60s). A marker older than this is treated as a
// dead chain and reclaimed. Comfortably larger than one slice, far smaller than
// the 6h cron interval so a genuinely stalled chain is always revived.
export const RUN_STALE_MS = 5 * 60 * 1000;

async function readMarker(supabase) {
  const { data, error } = await supabase
    .from('system_settings')
    .select('id, setting_value')
    .is('tenant_id', null)
    .eq('setting_key', SETTING_KEY)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  let value = null;
  try {
    value = data.setting_value ? JSON.parse(data.setting_value) : null;
  } catch {
    value = null;
  }
  return { id: data.id, value };
}

async function writeMarker(supabase, existingId, value) {
  const setting_value = JSON.stringify(value);
  if (existingId) {
    const { error } = await supabase
      .from('system_settings')
      .update({ setting_value })
      .eq('id', existingId);
    if (error) throw error;
    return;
  }
  const { error } = await supabase.from('system_settings').insert({
    setting_key: SETTING_KEY,
    setting_value,
    setting_type: 'json',
    description: 'Member-content reindex chain concurrency marker (Task #2372)',
    tenant_id: null,
  });
  if (error) throw error;
}

function isFresh(value, staleMs) {
  if (!value || !value.heartbeatAt) return false;
  const ts = Date.parse(value.heartbeatAt);
  if (Number.isNaN(ts)) return false;
  return Date.now() - ts < staleMs;
}

/**
 * Claim a fresh reindex run (called at hop 0). Returns:
 *   { acquired: true, runId }                — no live chain; caller may proceed.
 *   { acquired: false, activeRunId, ageMs }  — a live chain is already running.
 *
 * Fail-open: if the marker store is unreachable, returns `acquired: true` with a
 * fresh runId so indexing is never blocked by an infrastructure hiccup.
 */
export async function acquireReindexRun({ supabase, scope = null, staleMs = RUN_STALE_MS } = {}) {
  const runId = crypto.randomUUID();
  try {
    const marker = await readMarker(supabase);
    if (marker && isFresh(marker.value, staleMs)) {
      const ts = Date.parse(marker.value.heartbeatAt);
      return {
        acquired: false,
        activeRunId: marker.value.runId || null,
        ageMs: Number.isNaN(ts) ? null : Date.now() - ts,
      };
    }
    await writeMarker(supabase, marker?.id || null, {
      runId,
      scope: scope || null,
      startedAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
    });
    return { acquired: true, runId, reclaimed: !!marker };
  } catch (err) {
    console.warn('[memberContentReindexLock] acquire failed (fail-open):', err?.message || err);
    return { acquired: true, runId, degraded: true };
  }
}

/**
 * Renew ownership of an in-flight run (called on continuation hops > 0). Returns:
 *   { owns: true }   — we still own the run; heartbeat refreshed; caller proceeds.
 *   { owns: false }  — a newer run has taken over; this chain must stop.
 *
 * Fail-open: on a marker-store error, returns `owns: true` so a live chain is
 * never killed by a transient read/write failure.
 */
export async function renewReindexRun({ supabase, runId, scope = null } = {}) {
  if (!runId) return { owns: true, degraded: true };
  try {
    const marker = await readMarker(supabase);
    // Another run took over (different runId, still fresh) -> stand down.
    if (marker && marker.value && marker.value.runId && marker.value.runId !== runId) {
      if (isFresh(marker.value, RUN_STALE_MS)) {
        return { owns: false, activeRunId: marker.value.runId };
      }
    }
    await writeMarker(supabase, marker?.id || null, {
      runId,
      scope: scope || marker?.value?.scope || null,
      startedAt: marker?.value?.startedAt || new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
    });
    return { owns: true };
  } catch (err) {
    console.warn('[memberContentReindexLock] renew failed (fail-open):', err?.message || err);
    return { owns: true, degraded: true };
  }
}

/**
 * Clear the marker when the chain finishes or dies, but only if we still own it
 * (so we never delete a marker a newer run has already claimed). Best-effort.
 */
export async function completeReindexRun({ supabase, runId } = {}) {
  try {
    const marker = await readMarker(supabase);
    if (!marker) return;
    if (runId && marker.value && marker.value.runId && marker.value.runId !== runId) {
      // A newer run owns the marker now; leave it alone.
      return;
    }
    const { error } = await supabase
      .from('system_settings')
      .delete()
      .eq('id', marker.id);
    if (error) throw error;
  } catch (err) {
    console.warn('[memberContentReindexLock] complete failed (best-effort):', err?.message || err);
  }
}
