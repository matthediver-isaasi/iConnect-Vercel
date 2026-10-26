import { createMemberAmendmentProviderOperations } from './memberAmendmentProviderOperations.js';
import { runMemberAmendmentProviderRecovery } from './memberAmendmentProviderRecovery.js';

export async function runMemberMonthlyFinalizationRecovery({
  db, service = createMemberAmendmentProviderOperations({ db }),
  limit = 30, budgetMs = 7500, now = () => Date.now(),
}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100
    || !Number.isFinite(budgetMs) || budgetMs < 0) throw new TypeError('Invalid monthly recovery limits');
  const started = now();
  if (budgetMs <= 0) return { enabled: true, outcomes: [], timedOut: true };
  const { data, error } = await db.rpc('pending_member_monthly_finalizations', { p_limit: limit });
  if (error) {
    if (['PGRST202', '42883'].includes(error.code)) {
      return { enabled: false, reason: 'migration_required', outcomes: [] };
    }
    throw Object.assign(new Error('Monthly finalization recovery queue unavailable'), {
      code: 'monthly_finalization_queue_failed',
    });
  }
  if (!Array.isArray(data)) throw new Error('Invalid monthly finalization recovery queue');
  const outcomes = [];
  for (const row of data) {
    if (now() - started >= budgetMs) break;
    try {
      if (!row.tenant_id || !row.member_id || !row.actor_id || !row.operation_key || !row.reason) {
        throw Object.assign(new Error('Invalid saved approval'), { code: 'monthly_approval_invalid' });
      }
      const application = await service.finalize({
        tenantId: row.tenant_id, memberId: row.member_id, actorId: row.actor_id,
        key: row.operation_key, reason: row.reason,
      });
      outcomes.push({ key: row.operation_key, state: 'finalized', operationId: application.operationId });
    } catch (failure) {
      outcomes.push({ key: row.operation_key, code: failure.code || 'monthly_finalization_failed' });
    }
  }
  return { enabled: true, outcomes, timedOut: outcomes.length < data.length };
}

export async function runMemberMonthlyRecovery({ db, budgetMs = 7500,
  runFinalization = runMemberMonthlyFinalizationRecovery,
  runProvider = runMemberAmendmentProviderRecovery }) {
  const started = Date.now();
  // Approved completion takes priority. Its own fresh provider read can also
  // resolve uncertainty; neither runner may repeat a provider mutation.
  let finalization, provider;
  try { finalization = await runFinalization({ db, budgetMs: budgetMs / 2 }); }
  catch (error) {
    finalization = { enabled: true, outcomes: [], error: error.code || 'monthly_finalization_failed' };
  }
  try {
    provider = await runProvider({ db, budgetMs: Math.max(0, budgetMs - (Date.now() - started)) });
  } catch (error) {
    provider = { enabled: true, outcomes: [], error: error.code || 'monthly_recovery_failed' };
  }
  return { finalization, provider };
}
