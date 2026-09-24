import { runWidgetConfig, MAX_LIST_GROUPS } from './aggregation.js';
import { validateMemberGroupWidgetType } from './memberGroupContract.js';
import { validateMembershipValueWidgetType } from './validation.js';

export const FRESHNESS_MS = 15 * 60 * 1000;
export const COMPUTE_TIMEOUT_MS = 20000;

export async function cacheRpc(db, name, args = {}) {
  const { data, error } = await db.rpc(`dashboard_widget_cache_${name}`, args);
  if (error) throw new Error(error.message || 'Widget cache unavailable');
  return data;
}

export function cacheResponse(row, now = Date.now()) {
  const updatedAt = row.updated_at || null;
  const leased = !!row.lease_token && Date.parse(row.lease_until) > now;
  // Being overdue means stale, not that a refresh was accepted or started.
  const pending = leased || !!row.request_id;
  const stale = !updatedAt || now - Date.parse(updatedAt) >= FRESHNESS_MS;
  return {
    data: row.result ?? null,
    cache: {
      status: row.error ? 'failed' : !updatedAt ? 'pending' : stale ? 'stale' : 'current',
      updatedAt,
      pending,
      requestId: row.request_id || null,
      completedRequestId: row.completed_request_id || null,
      completedRequestOutcome: row.completed_request_outcome || null,
      ...(row.refresh ? { refresh: row.refresh } : {}),
      error: row.error || null,
      retryAfterSeconds: Math.max(1, Math.ceil((
        Math.max(row.error ? Math.max(Date.parse(row.due_at) || now, Date.parse(row.lease_until) || now) : now,
          leased ? now + 3000 : now,
          Date.parse(row.last_explicit_at) + 60000 || now) - now
      ) / 1000)),
    },
  };
}

export async function executeClaim(db, claim, { run = runWidgetConfig, timeoutMs = COMPUTE_TIMEOUT_MS } = {}) {
  if (!claim) return false;
  const { widget, cache } = claim;
  let timer;
  let result = null;
  let failure = null;
  try {
    validateMemberGroupWidgetType(widget.config, widget.widget_type);
    validateMembershipValueWidgetType(widget.config, widget.widget_type);
    result = await Promise.race([
      run(widget.config, widget.tenant_id, {
        maxGroups: widget.widget_type === 'list' ? MAX_LIST_GROUPS : undefined,
      }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Widget computation timed out')), timeoutMs);
      }),
    ]);
  } catch (error) {
    // Do not persist database details or source data in client-visible errors.
    console.error('[Dashboard cache] computation failed', { widgetId: widget.id, error: error.message });
    failure = 'Unable to refresh widget. Please try again later.';
  } finally {
    clearTimeout(timer);
  }
  const published = await cacheRpc(db, 'publish', {
    p_widget_id: widget.id, p_identity: cache.identity, p_token: cache.lease_token,
    p_result: result, p_error: failure,
  });
  return { published, failed: !!failure };
}

export async function readWidgetCache(db, widget, actor, { refresh = false, run = runWidgetConfig } = {}) {
  const args = { p_widget: widget, p_actor: actor.memberId, p_explicit: refresh };
  let row = await cacheRpc(db, 'touch', args);
  const receipt = row.refresh;
  if (refresh && !receipt) throw new Error('Widget cache protocol migration required');
  // Warm reads never execute aggregation. Cold/explicit callers may perform one
  // claimed job, awaited within the request; all other work remains durable.
  if ((refresh && receipt.outcome !== 'cooldown') || (!refresh && !row.updated_at)) {
    const claim = await cacheRpc(db, 'claim', { p_widget_id: widget.id, p_identity: row.identity });
    if (claim) {
      await executeClaim(db, claim, { run });
      // Revalidate the original authorization snapshot after computation. Edits
      // and deletion must not leak even this worker's previously authorized data.
      row = await cacheRpc(db, 'touch', { ...args, p_explicit: false });
    }
  }
  if (receipt) {
    row.refresh = receipt;
    if (receipt.requestId && row.completed_request_id === receipt.requestId) {
      row.refresh = { ...receipt, outcome: row.completed_request_outcome };
    }
  }
  return cacheResponse(row);
}

export async function runCacheScheduler(db, {
  run = runWidgetConfig, now = Date.now, budgetMs = 25000, maxJobs = 12,
} = {}) {
  const started = now();
  let attempted = 0;
  let failed = 0;
  let published = 0;
  // Two workers, with no new work launched after the budget. Each computation
  // gets at most 20s; worst-case request duration remains below the 60s host cap.
  async function worker() {
    while (now() - started < budgetMs && attempted < maxJobs) {
      attempted++;
      const claim = await cacheRpc(db, 'claim');
      if (!claim) { attempted--; break; }
      const outcome = await executeClaim(db, claim, { run });
      if (outcome.failed) failed++;
      if (outcome.published) published++;
    }
  }
  await Promise.all([worker(), worker()]);
  const backlog = await cacheRpc(db, 'stats');
  const report = { attempted, published, failed, durationMs: now() - started, backlog };
  console.info('[Dashboard cache] scheduler', report);
  return report;
}