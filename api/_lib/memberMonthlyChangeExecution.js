import { AMENDMENT_UUID } from './memberAmendments.js';
import { monthlyAmendmentFingerprint } from './memberAmendmentMonthly.js';
import { createMemberMonthlyPurchaseAuthority } from './memberMonthlyPurchaseAuthority.js';
import { createMemberAmendmentProviderOperations } from './memberAmendmentProviderOperations.js';

const fail = message => {
  throw Object.assign(new Error(message), { status: 409, code: 'monthly_execution_conflict' });
};
// Internal coordinator. The production confirmation resolver must supply the
// monthlyExecution envelope; it cannot be supplied by browser request fields.
export function createMemberMonthlyChangeExecution({
  db, purchases = createMemberMonthlyPurchaseAuthority({ db }),
  operations = createMemberAmendmentProviderOperations({ db }),
}) {
  async function one(table, filters) {
    let query = db.from(table).select('*');
    for (const [key, value] of Object.entries(filters)) query = query.eq(key, value);
    const { data, error } = await query.maybeSingle();
    if (error) fail('Monthly execution evidence could not be read.');
    return data;
  }
  async function resolve(context, request) {
    if (context.actorKind !== 'admin' || !context.actorId || !context.tenantId
      || !AMENDMENT_UUID.test(context.memberId || '') || !AMENDMENT_UUID.test(request.authorityId || '')) {
      fail('Authenticated finance-admin context is required.');
    }
    const saved = await one('member_change_authority', {
      id: request.authorityId, tenant_id: context.tenantId, member_id: context.memberId,
    });
    const authority = saved?.authority;
    if (!saved || saved.tenant_id !== context.tenantId || saved.member_id !== context.memberId
      || saved.actor_kind !== 'admin' || authority?.action !== 'change'
      || authority.sourceSnapshot?.id !== saved.source_record_id
      || authority.sourceSnapshot?.commitment_snapshot?.payment_frequency !== 'monthly'
      || authority.monthlyExecution?.version !== 1
      || !authority.monthlyExecution.providerTarget
      || !authority.monthlyExecution.providerAuthority
      || authority.calculation?.behaviour !== 'retain_term') {
      fail('A confirmed executable monthly membership quote is required.');
    }
    return { saved, authority, key: `monthly-change:${saved.id}` };
  }
  async function existing(context, key) {
    return one('member_amendment_provider_operation', {
      tenant_id: context.tenantId, member_id: context.memberId, operation_key: key,
    });
  }
  function binding(operation, saved) {
    if (operation.source_record_id !== saved.source_record_id
      || operation.prepared?.input?.changeAuthorityId !== saved.id) fail('Monthly operation belongs to different authority.');
  }
  async function resume(context, request) {
    const { saved, key } = await resolve(context, request);
    const operation = await existing(context, key);
    if (!operation) return { state: 'not_started', nextAction: 'execute' };
    binding(operation, saved);
    // Recovery never starts a new provider operation or invents approval.
    const approval = await one('member_monthly_finalization_approval', {
      operation_id: operation.id, tenant_id: context.tenantId,
    });
    if (!approval) return {
      operation: await operations.resume({ ...context, key }),
      nextAction: 'approve_finalization',
    };
    return { application: await operations.finalize({
      ...context, actorId: approval.actor_id, key, reason: approval.reason,
    }) };
  }
  async function execute(context, request) {
    const { saved, authority, key } = await resolve(context, request);
    if (request.approve !== true || typeof request.reason !== 'string'
      || !request.reason.trim() || request.reason.trim().length > 2000) fail('Explicit approval and reason are required.');
    const prior = await existing(context, key);
    if (prior) {
      binding(prior, saved);
      if (prior.state === 'reserved') {
        await operations.execute({ input: prior.prepared.input, actorId: context.actorId });
      }
    }
    else {
      const input = await purchases.load({
        tenantId: context.tenantId, memberId: context.memberId, amendmentId: key,
        effectiveDate: authority.calculation.effectiveDate,
        target: authority.monthlyExecution.providerTarget,
      });
      if (monthlyAmendmentFingerprint(input.purchase) !== monthlyAmendmentFingerprint(authority.sourceSnapshot)
        || monthlyAmendmentFingerprint(input.authority) !== monthlyAmendmentFingerprint(authority.monthlyExecution.providerAuthority)) {
        fail('Purchased monthly evidence changed; do not execute the stale quote.');
      }
      const target = await one('membership_tier_config', {
        tenant_id: context.tenantId, id: authority.targetSnapshot.id,
      });
      if (monthlyAmendmentFingerprint(target) !== monthlyAmendmentFingerprint(authority.targetSnapshot)) {
        fail('Target membership structure changed; do not execute the stale quote.');
      }
      if (authority.targetBandSnapshot) {
        const band = await one('membership_tier_band', {
          tenant_id: context.tenantId, config_id: target.id, id: authority.targetBandSnapshot.id,
        });
        if (monthlyAmendmentFingerprint(band) !== monthlyAmendmentFingerprint(authority.targetBandSnapshot)) {
          fail('Target membership band changed; do not execute the stale quote.');
        }
      }
      await operations.execute({ input: { ...input, changeAuthorityId: saved.id }, actorId: context.actorId });
    }
    // A replay does not reload a now-amended Stripe schedule as a new purchase.
    // It uses the original operation and read-only reconciliation.
    return { application: await operations.finalize({
      ...context, key, reason: request.reason.trim(),
    }) };
  }
  return { execute, resume };
}
