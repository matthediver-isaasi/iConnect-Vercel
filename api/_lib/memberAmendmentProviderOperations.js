import {
  createMemberAmendmentMonthlyService, monthlyAmendmentFingerprint, MonthlyAmendmentError,
} from './memberAmendmentMonthly.js';

// Internal execution boundary, not a public API. input must be loaded by the
// authenticated membership service; never pass browser-authored provider
// authority/prepared JSON into this module.
export function createMemberAmendmentProviderOperations({
  db, monthly = createMemberAmendmentMonthlyService(),
}) {
  const result = value => {
    if (value.error) {
      throw Object.assign(new Error('Monthly amendment operation could not be persisted.'), {
        code: value.error.code === '40001' || value.error.code === '23505'
          ? 'amendment_operation_conflict' : 'amendment_operation_storage_failed',
        status: 409,
      });
    }
    return value.data;
  };
  const rpc = async (name, args) => result(await db.rpc(name, args));
  async function load(tenantId, memberId, key) {
    return result(await db.from('member_amendment_provider_operation').select('*')
      .eq('tenant_id', tenantId).eq('member_id', memberId).eq('operation_key', key).maybeSingle());
  }
  function checkBinding(operation, tenantId, memberId) {
    const prepared = operation?.prepared;
    if (!operation || operation.tenant_id !== tenantId || operation.member_id !== memberId
      || prepared?.input?.tenantId !== tenantId || prepared?.input?.memberId !== memberId) {
      throw new MonthlyAmendmentError('operation_ownership_mismatch', 'Monthly operation owner does not match.');
    }
    const { fingerprint, ...content } = prepared;
    if (fingerprint !== operation.fingerprint || fingerprint !== monthlyAmendmentFingerprint(content)) {
      throw new MonthlyAmendmentError('operation_evidence_changed', 'Stored monthly operation evidence is invalid.');
    }
  }
  async function persistOutcome(operation, actorId, outcome) {
    return rpc('record_member_amendment_provider_result', {
      p_tenant_id: operation.tenant_id, p_id: operation.id, p_actor_id: actorId,
      p_claim_token: operation.claim_token, p_result: outcome,
    });
  }
  async function reconcile(operation, actorId) {
    if (['finalized','aborted'].includes(operation.state)) return operation;
    if (!operation.claim_token) return operation; // No provider write was claimed.
    let outcome;
    try { outcome = await monthly.reconcile(operation.prepared); }
    catch { outcome = { status: 'uncertain', reason: 'provider_read_not_confirmed' }; }
    // No new provider write is made, even if the read says "not_applied".
    return persistOutcome(operation, actorId, outcome);
  }
  async function resume({ tenantId, memberId, actorId, key }) {
    if (!actorId) throw new MonthlyAmendmentError('actor_required', 'An authenticated audit identity is required.');
    const operation = await load(tenantId, memberId, key);
    checkBinding(operation, tenantId, memberId);
    return reconcile(operation, actorId);
  }
  async function execute({ input, actorId }) {
    if (!actorId) throw new MonthlyAmendmentError('actor_required', 'An authenticated audit identity is required.');
    const { tenantId, memberId, amendmentId: key } = input;
    let operation = await load(tenantId, memberId, key);
    if (operation) {
      checkBinding(operation, tenantId, memberId);
      // A retry may carry reloaded rows, but must not change the requested
      // target, boundary or immutable purchased authority.
      for (const field of ['target','effectiveDate','authority']) {
        if (monthlyAmendmentFingerprint(input[field]) !== monthlyAmendmentFingerprint(operation.prepared.input[field])) {
          throw new MonthlyAmendmentError('operation_key_conflict', 'This operation key belongs to a different membership change.');
        }
      }
      if (operation.state !== 'reserved') return reconcile(operation, actorId);
    } else {
      const prepared = await monthly.prepare(input);
      if (!['stripe_schedule','gc_amount'].includes(prepared.mutation.kind)) {
        throw new MonthlyAmendmentError('dynamic_revision_required', 'Dynamic collections require a versioned pricing revision; no operation was reserved.');
      }
      operation = (await rpc('reserve_member_amendment_provider_operation', {
        p_tenant_id: tenantId, p_member_id: memberId, p_actor_id: actorId,
        p_key: key, p_prepared: prepared,
      })).operation;
      checkBinding(operation, tenantId, memberId);
    }
    const claim = await rpc('claim_member_amendment_provider_operation', {
      p_tenant_id: tenantId, p_id: operation.id, p_actor_id: actorId,
    });
    if (!claim.claimed) {
      checkBinding(claim.operation, tenantId, memberId);
      return claim.operation; // Losing caller must not race a running write.
    }
    operation = claim.operation;
    checkBinding(operation, tenantId, memberId);
    let outcome;
    try { outcome = await monthly.apply(operation.prepared); }
    catch { outcome = { status: 'uncertain', reason: 'provider_write_not_confirmed' }; }
    // If this persistence fails, executing + the original claim survive.
    // Subsequent requests run read-only reconciliation; never a second write.
    return persistOutcome(operation, actorId, outcome);
  }
  return { execute, resume };
}
