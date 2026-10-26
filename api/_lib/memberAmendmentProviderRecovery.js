import { createMemberAmendmentProviderOperations } from './memberAmendmentProviderOperations.js';

// Recovery can only inspect previously claimed writes. It must never prepare,
// claim, execute, abandon or release an operation, even when the provider says
// the change was not applied. Entitlement finalization is a separate boundary.
export async function runMemberAmendmentProviderRecovery({
  db, service = createMemberAmendmentProviderOperations({ db }),
  limit = 30, budgetMs = 7500, now = () => Date.now(),
}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100
    || !Number.isFinite(budgetMs) || budgetMs < 0) {
    throw new TypeError('Invalid monthly recovery limits');
  }
  const started = now();
  if (budgetMs === 0) return { enabled: true, outcomes: [], timedOut: true };
  // Avoid racing the original in-flight provider request. This is not a lease:
  // overlapping recovery reads are safe and cannot repeat its external write.
  const cutoff = new Date(started - 120000).toISOString();
  const { data, error } = await db.from('member_amendment_provider_operation')
    .select('tenant_id,member_id,actor_id,operation_key,state,claim_token')
    .in('state', ['executing', 'uncertain'])
    .not('claim_token', 'is', null)
    .lt('updated_at', cutoff)
    .order('updated_at', { ascending: true })
    .order('id', { ascending: true })
    .limit(limit);
  if (error) {
    if (['42P01', 'PGRST205'].includes(error.code)) {
      return { enabled: false, reason: 'migration_required', outcomes: [] };
    }
    throw Object.assign(new Error('Monthly provider recovery queue could not be read'), {
      code: 'monthly_recovery_queue_failed',
    });
  }
  if (!Array.isArray(data)) throw new Error('Monthly provider recovery queue is invalid');
  const outcomes = [];
  for (const row of data) {
    if (now() - started >= budgetMs) break;
    try {
      if (!row.claim_token || !['executing', 'uncertain'].includes(row.state)
        || !row.actor_id || !row.tenant_id || !row.member_id || !row.operation_key) {
        throw Object.assign(new Error('Invalid recovery ownership'), { code: 'monthly_recovery_binding_invalid' });
      }
      const operation = await service.resume({
        tenantId: row.tenant_id, memberId: row.member_id,
        actorId: row.actor_id, key: row.operation_key,
      });
      outcomes.push({
        key: row.operation_key, state: operation.state,
        // Provider success is not completed membership application.
        requiresFinalization: operation.state === 'provider_applied',
      });
    } catch (failure) {
      outcomes.push({ key: row.operation_key, code: failure.code || 'monthly_recovery_failed' });
    }
  }
  return { enabled: true, outcomes, timedOut: outcomes.length < data.length };
}
