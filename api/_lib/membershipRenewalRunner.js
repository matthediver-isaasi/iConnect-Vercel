import { randomUUID } from 'node:crypto';
import { RenewalBudgetExceeded } from './membershipRenewalBudget.js';

const PAGE_SIZE = 200;
export const RENEWAL_LIMITS = Object.freeze({
  discoveryMs: 3_000, readMs: 2_000, pauseMs: 5_000,
  billingMs: 30_000, workMs: 48_000, tenantExpiryMs: 4_000, finalizationMs: 54_000,
});

export function renewalOutcome(results) {
  const failed = results.errors > 0 || results.details.some(d => d.error || d.status === 'error');
  return failed ? 'failed' : results.stalled ? 'stalled' : results.deferred ? 'deferred' : 'completed';
}

async function readWithDeadline(query, timeoutMs) {
  // PostgREST's signal cancels the actual read transport. Always await its
  // settlement; never race a promise and leave work running after the response.
  if (typeof query.abortSignal !== 'function') return await query;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
  try {
    return await query.abortSignal(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

export function withRenewalReadDeadline(db, { deadline, clock = Date.now, timeoutMs = 2_000 }) {
  const mutations = new Set(['insert', 'update', 'upsert', 'delete']);
  const wrap = (query, write = false) => new Proxy(query, {
    get(target, key) {
      if (key === 'then') return (resolve, reject) => {
        const operation = write ? Promise.resolve(target)
          : readWithDeadline(target, Math.min(timeoutMs, Math.max(1, deadline - clock())));
        return operation.then(resolve, reject);
      };
      const value = Reflect.get(target, key);
      if (typeof value !== 'function') return value;
      return (...args) => wrap(value.apply(target, args), write || mutations.has(key));
    },
  });
  return new Proxy(db, {
    get(target, key) {
      if (key === 'from') return (...args) => wrap(target.from(...args));
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

async function checked(query, label, readTimeoutMs = null) {
  const { data, error } = await (readTimeoutMs === null ? query : readWithDeadline(query, readTimeoutMs));
  if (error) throw new Error(`${label}: ${error.message}`);
  return data;
}

// Separate from the HTTP handler so every stage, clock and effect is injectable.
export async function runMembershipRenewals({
  db, pause, expiry, stages, clock = Date.now, logger = console,
  owner = randomUUID(), limits = RENEWAL_LIMITS,
}) {
  limits = { ...RENEWAL_LIMITS, ...limits };
  const started = clock();
  const now = new Date(started);
  const today = now.toISOString().slice(0, 10);
  const results = { processed: 0, skipped: 0, errors: 0, deferred: 0, details: [], progress: [] };
  let tenants = [];
  let state;
  let claimed = false;
  const diagnostic = (stage, event, extra = {}) => {
    const entry = { job: 'membership_renewals', owner, stage, event, elapsed_ms: clock() - started, ...extra };
    logger.log(JSON.stringify(entry));
    return entry;
  };
  const errorDetail = (stage, error, tenantId) => {
    results.errors++;
    results.details.push({ stage, tenantId, status: 'error', error: error.message });
    diagnostic(stage, 'error', { tenantId, error: error.message });
  };
  const save = async (release = false) => {
    await checked(db.rpc('save_membership_renewal_cron', {
      p_owner: owner, p_state: state, p_release: release,
    }), 'Could not save renewal continuation');
  };
  const runStage = async (stage, tenantId, fn) => {
    const stageStart = clock();
    diagnostic(stage, 'start', { tenantId });
    try {
      const result = await fn();
      diagnostic(stage, 'end', { tenantId, duration_ms: clock() - stageStart });
      return result;
    } catch (error) {
      diagnostic(stage, error.code === 'RENEWAL_BUDGET_EXHAUSTED' ? 'deferred' : 'error',
        { tenantId, duration_ms: clock() - stageStart, error: error.message });
      throw error;
    }
  };
  try {
    diagnostic('claim', 'start');
    const claim = await checked(db.rpc('claim_membership_renewal_cron', { p_owner: owner }), 'Could not claim renewal worker');
    if (!claim?.claimed) {
      // A second worker is not evidence that the owning worker is healthy.
      diagnostic('claim', 'busy');
      return { ...results, outcome: 'busy', healthy: false, heartbeat: false, duration_ms: clock() - started };
    }
    claimed = true;
    state = { billing: {}, expiry: {}, tenants: {}, ...claim.state };
    tenants = await runStage('configuration-discovery', null, async () => {
      // Discovery itself is a resumable stream. Retain known tenants so a
      // large or slow directory cannot postpone their billing/expiry forever.
      // Explicit pagination even if the server cap is smaller than PAGE_SIZE.
      let offset = state.discoveryOffset || 0;
      while (clock() < started + limits.discoveryMs) {
        const rows = await checked(db.rpc('membership_renewal_cron_tenants')
          .order('tenant_id', { ascending: true }).range(offset, offset + PAGE_SIZE - 1),
        'Tenant discovery failed', Math.min(limits.readMs, started + limits.discoveryMs - clock()));
        if (!rows?.length) {
          state.discoveryOffset = 0;
          await save();
          return Object.values(state.tenants).sort((a, b) => a.tenant_id.localeCompare(b.tenant_id));
        }
        for (const row of rows) state.tenants[row.tenant_id] = row;
        offset += rows.length;
        state.discoveryOffset = offset;
        await save();
      }
      results.deferred++;
      diagnostic('configuration-discovery', 'deferred', { nextOffset: offset });
      return Object.values(state.tenants).sort((a, b) => a.tenant_id.localeCompare(b.tenant_id));
    });
    // Register today's opportunity before doing work. A later invocation after
    // the configured hour catches up, but we never invent historical billing.
    for (const { tenant_id: id, scheduled_hour: hour } of tenants) {
      if (!state.billing[id] && now.getUTCHours() >= hour) {
        state.billing[id] = { date: today, stage: 0, cursor: null };
      } else if (state.billing[id]?.done && state.billing[id].date < today && now.getUTCHours() >= hour) {
        state.billing[id] = { date: today, stage: 0, cursor: null };
      }
    }
    await save();
    const pauseBefore = JSON.stringify(state.pauseCursor || null);
    try {
      await runStage('pause-restarts', null, () => pause(results, {
        now,
        control: {
          cursor: state.pauseCursor || null,
          shouldContinue: () => clock() < started + limits.pauseMs,
          checkpoint: async cursor => {
            state.pauseCursor = cursor;
            await save();
            diagnostic('pause-restarts', 'progress', { cursor });
          },
        },
      }));
      state.pauseCursor = null;
      state.pauseNoProgress = 0;
      await save();
    } catch (error) {
      if (error.code === 'RENEWAL_BUDGET_EXHAUSTED') {
        results.deferred++;
        state.pauseNoProgress = pauseBefore === JSON.stringify(state.pauseCursor || null)
          ? (state.pauseNoProgress || 0) + 1 : 0;
        if (state.pauseNoProgress >= 3) results.stalled = true;
      }
      else errorDetail('pause-restarts', error);
    }
    const rotate = (list, after) => {
      const index = list.findIndex(row => row.tenant_id === after);
      return index < 0 ? list : [...list.slice(index + 1), ...list.slice(0, index + 1)];
    };
    // Billing runs before expiry, with a separate limit so expiry gets time too.
    for (const { tenant_id: tenantId } of rotate(tenants, state.billingAfter)) {
      const pending = state.billing[tenantId];
      if (!pending || pending.done) continue;
      if (clock() >= started + limits.billingMs) { results.deferred++; break; }
      const billingBefore = JSON.stringify([pending.stage, pending.cursor]);
      try {
        while (pending.stage < stages.length) {
          if (clock() >= started + limits.billingMs) throw new RenewalBudgetExceeded();
          const [name, fn] = stages[pending.stage];
          const before = results.errors;
          Object.defineProperty(results, '__renewalControl', { configurable: true, value: {
            cursor: pending.cursor,
            shouldContinue: () => clock() < started + limits.billingMs,
            checkpoint: async cursor => {
              pending.cursor = cursor;
              await save();
              diagnostic(name, 'progress', { tenantId, cursor });
            },
          } });
          await runStage(name, tenantId, () => fn(tenantId, results));
          delete results.__renewalControl;
          if (results.errors > before) throw new Error(`${name} reported row errors`);
          pending.cursor = null;
          // Persist next stage only after the whole stage succeeds.
          pending.stage++;
          pending.noProgress = 0;
          await save();
        }
        pending.done = true;
        pending.noProgress = 0;
        await save();
      } catch (error) {
        delete results.__renewalControl;
        if (error.code === 'RENEWAL_BUDGET_EXHAUSTED') {
          results.deferred++;
          pending.noProgress = billingBefore === JSON.stringify([pending.stage, pending.cursor])
            ? (pending.noProgress || 0) + 1 : 0;
          if (pending.noProgress >= 3) results.stalled = true;
        }
        else errorDetail(stages[pending.stage]?.[0] || 'billing', error, tenantId);
      }
      state.billingAfter = tenantId;
      await save();
    }
    // Each tenant gets a bounded slice. Rotate the starting tenant on handoff,
    // including after errors, rather than pinning every invocation to tenant 1.
    for (const { tenant_id: tenantId } of rotate(tenants, state.expiryAfter)) {
      if (clock() >= started + limits.workMs) { results.deferred++; break; }
      const sliceEnd = Math.min(started + limits.workMs, clock() + limits.tenantExpiryMs);
      const prior = state.expiry[tenantId] || {};
      const control = {
        cursor: prior.cursor || null,
        shouldContinue: () => clock() < sliceEnd,
        checkpoint: async cursor => {
          state.expiry[tenantId] = { ...state.expiry[tenantId], cursor, progressAt: new Date(clock()).toISOString() };
          await save();
        },
        onProgress: progress => diagnostic('expiry', 'progress', { tenantId, ...progress }),
      };
      try {
        const readBoundDb = withRenewalReadDeadline(db, { deadline: sliceEnd, clock, timeoutMs: limits.readMs });
        const outcome = await runStage('expiry', tenantId, () => expiry(readBoundDb, tenantId, results, now, control));
        state.expiry[tenantId] = {
          cursor: outcome.complete ? null : outcome.cursor,
          progressAt: new Date(clock()).toISOString(),
          completedAt: outcome.complete ? new Date(clock()).toISOString() : prior.completedAt || null,
          noProgress: !outcome.complete && !outcome.examined && !outcome.enforced ? (prior.noProgress || 0) + 1 : 0,
        };
        if (!outcome.complete) results.deferred++;
        if (state.expiry[tenantId].noProgress >= 3) results.stalled = true;
        results.progress.push({ tenantId, stage: 'expiry', ...outcome });
      } catch (error) {
        errorDetail('expiry', error, tenantId);
      }
      state.expiryAfter = tenantId;
      await save();
    }
  } catch (error) {
    errorDetail('runner', error);
  } finally {
    if (claimed) {
      diagnostic('finalization', 'start');
      const logRows = [];
      for (const tenantId of tenants.length ? tenants.map(t => t.tenant_id) : [null]) {
          const details = results.details.filter(d => !d.tenantId || d.tenantId === tenantId);
          const outcome = renewalOutcome(results);
          logRows.push({
            tenant_id: tenantId, task_name: 'membership_renewals', task_display_name: 'Membership Renewals',
            status: ['failed', 'stalled'].includes(outcome) ? 'error' : outcome === 'deferred' ? 'partial' : 'success',
            details: JSON.stringify({
              outcome, duration_ms: clock() - started, errors: results.errors, deferred: results.deferred,
              processed: results.processed, skipped: results.skipped, details,
              progress: results.progress.filter(p => p.tenantId === tenantId),
              billing: state?.billing?.[tenantId] || null,
            }),
            executed_at: new Date(clock()).toISOString(),
          });
      }
      // Batch inserts replace the former per-tenant write N+1. Do not start
      // another logging batch once the finalization reserve is exhausted.
      for (let offset = 0; offset < logRows.length; offset += PAGE_SIZE) {
        if (clock() >= started + limits.finalizationMs) {
          errorDetail('completion-log', new Error(`Completion log budget exhausted; ${logRows.length - offset} tenant logs were not written`));
          break;
        }
        try {
          await checked(db.from('scheduled_task_log').insert(logRows.slice(offset, offset + PAGE_SIZE)), 'Completion log failed');
        } catch (error) { errorDetail('completion-log', error); }
      }
      try { await save(true); } catch (error) { errorDetail('release', error); }
      diagnostic('finalization', 'end', { outcome: renewalOutcome(results), errors: results.errors, deferred: results.deferred });
    }
  }
  const outcome = renewalOutcome(results);
  return { ...results, outcome, healthy: ['completed', 'deferred'].includes(outcome),
    heartbeat: true, duration_ms: clock() - started };
}