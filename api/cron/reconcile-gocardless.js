// Live-only reconciliation envelope. Selection and row orchestration are shared
// with the capability-restricted Direct Debit preview.
import { supabase } from '../_lib/database.js';
import { gocardlessForTenant } from '../_lib/gocardless.js';
import { applyStatusTransition } from '../_lib/gocardlessState.js';
import { postDdInstalmentToAccounting } from '../_lib/gocardlessAccounting.js';
import { createHeartbeatReporter, HEARTBEAT_ENV_VARS } from '../_lib/heartbeat.js';
import { processGocardlessEvent } from '../_lib/gocardlessWebhookProcessor.js';
import { reconcileDynamicCollections } from '../_lib/gocardlessDynamicCollections.js';
import { reconcileDynamicTermCompletions } from '../_lib/gocardlessDynamicCompletion.js';
import {
  reconciliationSelection, reconciliationStages, markReconciliationFresh,
} from '../_lib/directDebitReconciliationPipeline.js';

const MAX_ROWS_PER_GROUP = 100;
const clientCache = new Map();
async function gcFor(tenantId) {
  const key = tenantId || '__platform__';
  if (!clientCache.has(key)) clientCache.set(key, await gocardlessForTenant(tenantId || null));
  return clientCache.get(key);
}

// Only this live interpreter imports mutating clients. Operation payloads are
// constructed in the shared pipeline before any lifecycle or accounting work.
export function liveReconciliationEffects({
  db = supabase, getGc = gcFor, processEvent = processGocardlessEvent,
  transition = applyStatusTransition, postAccounting = postDdInstalmentToAccounting,
} = {}) {
  return {
    async perform(operation) {
      const p = operation.payload;
      switch (operation.type) {
        case 'reconciliation.update': {
          let query = db.from(p.table).update(p.values);
          for (const [key, value] of p.filters) query = query.eq(key, value);
          const { error } = await query;
          if (error) throw new Error(error.message);
          return { updated: true };
        }
        case 'reconciliation.transition': return transition(p);
        case 'reconciliation.replay': return processEvent(p.event, { db, gc: await getGc(p.tenantId) });
        case 'reconciliation.accounting': return postAccounting(
          { agreement: p.agreement, paymentRow: p.paymentRow }, { reclaimStale: p.reclaimStale });
        default: throw new Error(`Unsupported reconciliation effect ${operation.type}`);
      }
    },
  };
}

async function runLiveStage(results, stage, {
  db = supabase, gcForTenant = gcFor, processEvent = processGocardlessEvent,
  now = new Date(), effects = liveReconciliationEffects({ db, getGc: gcForTenant, processEvent }),
} = {}) {
  const ctx = { db, now, getGc: gcForTenant, effects };
  for (const selector of stage.selectors) {
    const { data: rows, error } = await reconciliationSelection(db, selector, now)
      .order('updated_at', { ascending: true }).limit(MAX_ROWS_PER_GROUP);
    if (error) throw new Error(`load ${selector} failed: ${error.message}`);
    for (const row of rows || []) {
      try {
        const outcome = await stage.run(ctx, row);
        for (const key of ['repaired', 'flagged', 'skipped']) results[key] += outcome?.[key] || 0;
        if (outcome?.repaired || outcome?.flagged) results.details.push({ [stage.scope]: row.id, stage: stage.id, ...outcome });
      } catch (cause) {
        // Live fairness write only. Preview has no cleanup writer and never
        // invokes this batch envelope or its audit/heartbeat logic.
        if (stage.id === 'stale-payments') {
          try { await markReconciliationFresh(ctx, row); }
          catch (freshnessError) { results.details.push({ payment: row.id, error: freshnessError.message }); }
        }
        results.errors++;
        results.details.push({ [stage.scope]: row.id, error: cause.message });
      }
    }
  }
}

export async function reconcileStalePayments(results, deps = {}) {
  return runLiveStage(results, reconciliationStages.find(stage => stage.id === 'stale-payments'), deps);
}

async function executeReconciliation(_req, res) {
  const reportHeartbeat = createHeartbeatReporter({ envVar: HEARTBEAT_ENV_VARS.gocardlessReconciliation });
  if (!supabase) {
    await reportHeartbeat(false);
    return res.status(500).json({ error: 'Database not configured' });
  }
  clientCache.clear();
  const startTime = Date.now();
  const results = { repaired: 0, flagged: 0, skipped: 0, errors: 0, details: [] };
  try {
    const completion = await reconcileDynamicTermCompletions({ db: supabase, limit: 10, budgetMs: 5000 });
    results.repaired += completion.completed + completion.notified;
    results.errors += completion.errors;
    const dynamic = await reconcileDynamicCollections({ db: supabase, clientForTenant: gcFor, budgetMs: 35000 });
    results.repaired += dynamic.processed;
    results.flagged += dynamic.blocked;
    for (const stage of reconciliationStages) await runLiveStage(results, stage);
  } catch (error) {
    results.errors++;
    results.details.push({ error: error.message });
    console.error('[cron/reconcile-gocardless] fatal:', error);
  }
  const duration = Date.now() - startTime;
  try {
    const { error } = await supabase.from('scheduled_task_log').insert({
      tenant_id: null, task_name: 'gocardless_reconciliation',
      task_display_name: 'GoCardless Reconciliation', status: results.errors > 0 ? 'partial' : 'success',
      details: JSON.stringify({ ...results, duration_ms: duration }), executed_at: new Date().toISOString(),
    });
    if (error) console.error('[cron/reconcile-gocardless] failed to log run:', error.message);
  } catch (error) { console.error('[cron/reconcile-gocardless] failed to log run:', error.message); }
  await reportHeartbeat(results.errors === 0);
  return res.status(200).json({ ok: true, duration_ms: duration, ...results });
}

export function createReconcileGocardlessHandler({ execute = executeReconciliation } = {}) {
  return async function handler(req, res) {
    const cronSecret = process.env.CRON_SECRET;
    if (!cronSecret) return res.status(503).json({ error: 'Cron authentication is not configured' });
    if (req.headers.authorization !== `Bearer ${cronSecret}`) return res.status(401).json({ error: 'Unauthorized' });
    return execute(req, res);
  };
}

export default createReconcileGocardlessHandler();