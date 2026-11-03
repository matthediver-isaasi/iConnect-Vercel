import { buildIdempotencyKey } from './gocardless.js';
import { validateGocardlessProviderContext } from './gocardlessFormProviderContext.js';
import { replacementEligibility, REPLACEMENT_MESSAGES } from './gocardlessMandateReplacementPolicy.js';
import { buildReplacementSchedule, readReplacementInventory, runReplacementHandover,
  ReplacementReviewRequired } from './gocardlessReplacementHandover.js';

const TABLE = 'membership_mandate_replacements';
function checked(result, label) {
  if (result.error) throw new Error(`${label} failed`, { cause: result.error });
  return result.data;
}
export function publicReplacement(operation) {
  if (!operation) return null;
  return { id: operation.id, status: operation.status, message: REPLACEMENT_MESSAGES[operation.status] };
}
export async function loadReplacementContext({ db, member, gc, now = new Date() }) {
  const histories = checked(await db.from('member_membership_history').select('*')
    .eq('tenant_id', member.tenant_id).eq('member_id', member.id)
    .eq('payment_method', 'direct_debit').gte('term_end_date', now.toISOString().slice(0, 10)),
  'Load current membership');
  const agreements = checked(await db.from('membership_billing_agreements').select('*')
    .eq('tenant_id', member.tenant_id).eq('member_id', member.id).eq('provider', 'gocardless')
    .eq('environment', gc.getGocardlessEnvironment()), 'Load Direct Debit agreements');
  const eligibility = replacementEligibility({
    member, histories, agreements, environment: gc.getGocardlessEnvironment(),
    today: now.toISOString().slice(0, 10),
  });
  if (!eligibility.eligible) return { ...eligibility, operation: null };
  const operations = checked(await db.from(TABLE).select('*')
    .eq('tenant_id', member.tenant_id).eq('member_id', member.id)
    .order('created_at', { ascending: false }).limit(1), 'Load replacement');
  return { ...eligibility, operation: operations?.[0] || null };
}

export function replacementResponse(context) {
  const operation = context.operation;
  const open = operation && !['cancelled', 'completed'].includes(operation.status);
  return {
    eligible: context.eligible || !!operation,
    canStart: context.canStart && !open,
    canResume: !!(context.canStart && operation?.status === 'authorizing'
      && operation.flow_id && operation.authorization_url),
    reason: context.reason || null,
    operation: publicReplacement(operation),
  };
}

async function saveOperation(db, operation, update) {
  const saved = checked(await db.from(TABLE).update(update).eq('id', operation.id)
    .eq('tenant_id', operation.tenant_id).eq('version', operation.version)
    .select('*').maybeSingle(), 'Save replacement');
  if (saved) return saved;
  // Another callback won. Never continue provider writes using stale state.
  throw new Error('Replacement changed concurrently; refresh its status');
}

function assertProvider(operation, gc) {
  if (validateGocardlessProviderContext(operation.provider_context, gc.providerContext, {
    environment: operation.environment,
  })) throw new Error('The original GoCardless account must be restored or reviewed');
}

export async function startReplacement({ db, member, gc, context, baseUrl }) {
  if (!context.canStart) throw new Error(context.reason || 'This mandate cannot be replaced automatically');
  let operation = context.operation;
  if (!operation || ['cancelled', 'completed'].includes(operation.status)) {
    const agreement = context.agreement;
    // Fail closed for any other agreement referring to this mandate, including
    // another tenant, historical renewal reuse, or an organisation agreement.
    const references = checked(await db.from('membership_billing_agreements').select('id')
      .eq('gocardless_mandate_id', agreement.gocardless_mandate_id), 'Verify mandate references');
    if (references.length !== 1 || references[0].id !== agreement.id) {
      throw new Error('This mandate is shared or reused. Please contact your membership team.');
    }
    const mandate = await gc.getMandate(agreement.gocardless_mandate_id);
    if (mandate?.id !== agreement.gocardless_mandate_id || mandate.status !== 'active') {
      throw new Error('The existing mandate is not active. Please contact your membership team.');
    }
    if (mandate.scheme !== 'bacs') throw new Error('This bank scheme requires assistance to replace safely.');
    const result = await db.from(TABLE).insert({
      tenant_id: member.tenant_id, member_id: member.id,
      agreement_id: agreement.id, history_id: context.history.id,
      environment: agreement.environment, provider_context: gc.providerContext,
      old_mandate_id: agreement.gocardless_mandate_id,
      old_customer_id: agreement.gocardless_customer_id || null,
    }).select('*').single();
    if (result.error?.code === '23505') {
      operation = checked(await db.from(TABLE).select('*').eq('tenant_id', member.tenant_id)
        .eq('member_id', member.id).not('status', 'in', '(cancelled,completed)')
        .maybeSingle(), 'Load concurrent replacement');
      if (!operation) throw new Error('This mandate already has a replacement in progress');
    } else operation = checked(result, 'Create replacement');
  }
  assertProvider(operation, gc);
  if (operation.status !== 'authorizing') throw new Error('Replacement is already awaiting verification or assistance');
  if (!operation.billing_request_id) {
    const br = await gc.createBillingRequest({
      currency: context.agreement.metadata?.dd?.currency || context.history.currency || 'GBP',
      metadata: { replacement_id: operation.id, tenant_id: member.tenant_id },
      idempotencyKey: buildIdempotencyKey('mandate-replacement-br', operation.id),
    });
    if (!br?.id || br.payment_request || br.links?.payment_request_payment) {
      throw new Error('Replacement authorization must not include a payment');
    }
    operation = await saveOperation(db, operation, { billing_request_id: br.id });
  }
  if (!operation.flow_id) {
    const returnUrl = new URL('/history', baseUrl);
    returnUrl.searchParams.set('mandate_replacement', operation.id);
    const flow = await gc.createBillingRequestFlow({
      billingRequestId: operation.billing_request_id,
      redirectUri: returnUrl.href, exitUri: returnUrl.href,
      idempotencyKey: buildIdempotencyKey('mandate-replacement-flow', operation.id),
    });
    if (!flow?.id || !flow.authorisation_url) throw new Error('GoCardless did not return an authorization flow');
    operation = await saveOperation(db, operation, {
      flow_id: flow.id, authorization_url: flow.authorisation_url,
    });
  }
  return {
    ...replacementResponse({ ...context, operation }),
    flowId: operation.flow_id, authorisationUrl: operation.authorization_url,
    environment: operation.environment,
  };
}

export async function refreshReplacement({ db, gc, operation }) {
  if (!operation || ['cancelled', 'completed', 'action_required'].includes(operation.status)) return operation;
  assertProvider(operation, gc);
  if (operation.status === 'switching') return continueReplacement({ db, gc, operation });
  if (!operation.billing_request_id) return operation;
  const br = await gc.getBillingRequest(operation.billing_request_id);
  if (!br || br.id !== operation.billing_request_id
      || br.metadata?.replacement_id !== operation.id
      || br.metadata?.tenant_id !== operation.tenant_id) {
    throw new Error('GoCardless authorization ownership could not be verified');
  }
  if (br.payment_request || br.links?.payment_request_payment) {
    return saveOperation(db, operation, { status: 'action_required', reason: 'unexpected_provider_payment' });
  }
  if (br.status === 'cancelled') return saveOperation(db, operation, { status: 'cancelled' });
  if (br.status !== 'fulfilled') return operation;
  const mandateId = br.links?.mandate_request_mandate;
  if (!mandateId || mandateId === operation.old_mandate_id) {
    return saveOperation(db, operation, { status: 'action_required', reason: 'candidate_identity_conflict' });
  }
  const mandate = await gc.getMandate(mandateId);
  if (mandate?.id !== mandateId) throw new Error('Candidate mandate could not be verified');
  // Do not route the candidate through ordinary consent fulfillment: the
  // original agreement and its collections must retain their identity.
  const active = mandate.status === 'active';
  const pending = ['pending_submission', 'submitted', 'pending_customer_approval'].includes(mandate.status);
  const ready = active && await replacementReleased(db, operation.environment);
  operation = await saveOperation(db, operation, {
    new_mandate_id: mandateId, new_customer_id: br.links?.customer || null,
    status: ready || pending ? 'awaiting_confirmation' : 'action_required',
    reason: ready || pending ? null : active ? 'handover_release_requires_verified_collection_contract'
      : 'candidate_mandate_unusable',
  });
  return ready ? continueReplacement({ db, gc, operation }) : operation;
}

export async function replacementReleased(db, environment) {
  const result = await db.from('gocardless_replacement_release').select('*')
    .eq('environment', environment).maybeSingle();
  if (['42P01', 'PGRST205'].includes(result.error?.code)) return false;
  const row = checked(result, 'Load handover release');
  return row?.enabled === true && row.evidence_reference?.length > 10
    && Date.parse(row.enabled_at) < Date.now() - 300000;
}

export async function continueReplacement({ db, gc, operation }) {
  assertProvider(operation, gc);
  if (!await replacementReleased(db, operation.environment)) return operation;
  let op = operation;
  try {
    if (op.status !== 'switching') {
      const agreement = checked(await db.from('membership_billing_agreements').select('*')
        .eq('id', op.agreement_id).eq('tenant_id', op.tenant_id).single(), 'Load handover agreement');
      const history = checked(await db.from('member_membership_history').select('*')
        .eq('id', op.history_id).eq('tenant_id', op.tenant_id).single(), 'Load handover history');
      const plan = checked(await db.from('membership_payment_plans').select('*')
        .eq('billing_agreement_id', op.agreement_id).maybeSingle(), 'Load handover plan');
      const [oldMandate, newMandate, inventory] = await Promise.all([
        gc.getMandate(op.old_mandate_id), gc.getMandate(op.new_mandate_id),
        readReplacementInventory(gc, op.old_mandate_id),
      ]);
      const snapshot = buildReplacementSchedule({ agreement, history, plan, inventory, oldMandate, newMandate,
        today: new Date().toISOString().slice(0, 10) });
      snapshot.prepared_at = new Date().toISOString();
      op = checked(await db.rpc('prepare_mandate_handover', {
        p_id: op.id, p_version: op.version, p_snapshot: snapshot,
      }), 'Prepare collection handover');
    }
    // Only this internal client can exercise the persisted handover authority.
    const { gocardlessForTenant } = await import('./gocardless.js');
    const scoped = await gocardlessForTenant(op.tenant_id, { db, replacementId: op.id });
    assertProvider(op, scoped);
    const store = {
      advance: async (current, patch) => (op = await saveOperation(db, current, patch)),
      commit: async current => (op = checked(await db.rpc('commit_mandate_handover', {
        p_id: current.id, p_version: current.version,
      }), 'Commit collection handover')),
      complete: async current => (op = await saveOperation(db, current, {
        phase: 'complete', status: 'completed', completed_at: new Date().toISOString(), reason: null,
      })),
    };
    return await runReplacementHandover({ operation: op, store, gc: scoped });
  } catch (error) {
    if (error instanceof ReplacementReviewRequired || [400, 403, 422].includes(error.status)) {
      return saveOperation(db, op, { status: 'action_required',
        ...(op.phase === 'prepared' ? { phase: 'authorization' } : {}),
        reason: error instanceof ReplacementReviewRequired ? error.message : `provider_rejected_${op.phase}` });
    }
    // Unknown outcomes retain the phase, identity and idempotency keys. A later
    // status read or reconciliation resumes that exact intent.
    throw error;
  }
}

export async function reconcileMandateReplacements({ db, clientForTenant, limit = 10, refresh = refreshReplacement }) {
  // Destructive phases take priority. Within each queue the attempt timestamp
  // rotates even pending or failing operations, so none monopolizes a batch.
  let result = await db.from(TABLE).select('*').eq('status', 'switching')
    .order('updated_at').order('id').limit(limit);
  if (['42P01', 'PGRST205'].includes(result.error?.code)) return { processed: 0, errors: 0 };
  let operations = checked(result, 'Load incomplete handovers');
  if (!operations.length) {
    result = await db.from(TABLE).select('*').in('status', ['authorizing', 'awaiting_confirmation'])
      .order('updated_at').order('id').limit(limit);
    operations = checked(result, 'Load pending authorizations');
  }
  let processed = 0, errors = 0;
  for (const operation of operations) {
    try {
      const claimed = await saveOperation(db, operation, { updated_at: new Date().toISOString() });
      const gc = await clientForTenant(claimed.tenant_id);
      await refresh({ db, gc, operation: claimed }); processed++;
    } catch { errors++; }
  }
  return { processed, errors };
}
