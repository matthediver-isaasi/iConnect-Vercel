import { createHash } from 'node:crypto';
import { readonlyTenantDatabase, readonlyGocardless } from './directDebitDryRunRuntime.js';
import { filterDirectDebitRows, lookupConsoleRows } from './directDebitConsoleEligibility.js';
import { runDynamicCollection } from './directDebitDynamicPipeline.js';
import { reconcileDynamicCollectionPlan } from './gocardlessDynamicCollections.js';

const checked = (result, label) => {
  if (result.error) throw new Error(`${label}: ${result.error.message}`);
  return result.data;
};
const fingerprint = (operation, environment, ownerLabel) => createHash('sha256')
  .update(JSON.stringify({
    tenant: operation.payload.plan.tenant_id, plan: operation.payload.plan.id,
    planEnvironment: operation.payload.plan.environment,
    agreement: operation.payload.agreement.id,
    agreementEnvironment: operation.payload.agreement.environment,
    member: operation.payload.agreement.member_id, organization: operation.payload.agreement.organization_id,
    mandate: operation.payload.agreement.gocardless_mandate_id,
    period: operation.payload.params.p_due_date, number: operation.payload.params.p_collection_number,
    key: operation.payload.params.p_idempotency_key,
    price: operation.payload.params.p_price_snapshot,
    amount: operation.amountMinor, currency: operation.currency, date: operation.date,
    environment, ownerLabel,
  })).digest('hex');

// No caller-supplied timing, price, mandate, tenant or period is accepted.
export async function handleManualCollection(req, res, { db, tenantId, actor, getProvider }) {
  res.setHeader('Cache-Control', 'private, no-store');
  const body = req.body || {};
  const execute = body.action === 'run_collection';
  if (!actor) {
    return res.status(403).json({ code: 'COLLECTION_ACTOR_REQUIRED', error: 'An authenticated collection actor is required' });
  }
  const allowed = new Set(['action', 'planId', ...(execute ? ['confirmed', 'confirmationToken', 'reason'] : [])]);
  if (Object.keys(body).some(key => !allowed.has(key)) || typeof body.planId !== 'string' || !body.planId.trim()) {
    return res.status(400).json({ error: 'Only a selected plan and explicit confirmation are accepted; overrides are forbidden' });
  }
  if (execute && (body.confirmed !== true || typeof body.confirmationToken !== 'string'
    || !/^[a-f0-9]{64}$/.test(body.confirmationToken))) {
    return res.status(400).json({ code: 'COLLECTION_CONFIRMATION_REQUIRED', error: 'Explicit confirmation and a valid confirmation token are required' });
  }
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  if (execute && (reason.length < 10 || reason.length > 500)) {
    return res.status(400).json({ code: 'COLLECTION_REASON_INVALID', error: 'A 10–500 character reason is required' });
  }
  const reads = readonlyTenantDatabase(db, tenantId);
  const plan = checked(await reads.from('membership_payment_plans').select('*').eq('id', body.planId).maybeSingle(), 'Plan lookup');
  if (!plan || !(await filterDirectDebitRows(reads, tenantId, [plan], { plans: true })).length) {
    return res.status(404).json({ error: 'Plan not found' });
  }
  const agreement = (await lookupConsoleRows(reads, tenantId, 'membership_billing_agreements', [plan.billing_agreement_id])).get(plan.billing_agreement_id);
  const member = agreement?.member_id ? (await lookupConsoleRows(reads, tenantId, 'member', [agreement.member_id])).get(agreement.member_id) : null;
  const organization = agreement?.organization_id ? (await lookupConsoleRows(reads, tenantId, 'organization', [agreement.organization_id])).get(agreement.organization_id) : null;
  const ownerLabel = organization?.name || [member?.first_name, member?.last_name].filter(Boolean).join(' ') || 'Plan owner';
  const scopedReads = readonlyTenantDatabase(db, tenantId, { memberId: member?.id, organizationId: organization?.id });
  const manualTiming = { tenantId, planId: plan.id, dueDate: plan.dynamic_next_collection_date,
    resolveDueDate: async number => checked(await db.rpc('gocardless_manual_collection_due_date', {
      p_tenant_id: tenantId, p_plan_id: plan.id, p_collection_number: number,
    }), 'Resolve canonical manual period'),
  };
  let client, environment, operation;
  const getGc = async () => {
    client ||= await getProvider(tenantId);
    environment = client.getGocardlessEnvironment();
    if (!['sandbox', 'live'].includes(environment) || environment !== plan.environment
      || environment !== agreement.environment) throw new Error('Provider environment does not match the plan and agreement');
    return readonlyGocardless(client);
  };
  try {
    const prior = checked(await scopedReads.from('gocardless_manual_collection_authorizations').select('id')
      .eq('plan_id', plan.id).eq('due_date', manualTiming.dueDate).limit(1), 'Read manual collection audit');
    if (prior?.length) return res.json({ status: 'blocked', reason: 'This period already has a manual attempt. Do not retry. A finance operator must verify provider evidence and, if appropriate, attach the exact existing payment. Refresh only reads records; it does not recover or resubmit.', errors: [] });
    const outcome = await runDynamicCollection({ db: scopedReads, plan, now: new Date(), getGc, manualTiming,
      effects: { async perform(candidate) {
        if (candidate.type !== 'dynamic.reserve_collection') throw new Error('Only collection submission is allowed');
        operation = candidate;
        return { preview: true };
      } } });
    if (!operation) return res.json({ status: 'skipped', reason: outcome.detail, errors: [] });
  } catch (error) {
    console.error('[manual-collection] eligibility verification failed', error);
    return res.json({ status: 'blocked', reason: 'Collection eligibility could not be verified. No payment was submitted by this request. Ask a finance operator to inspect the server evidence.',
      errors: [{ stage: 'preview', code: 'COLLECTION_PREFLIGHT_FAILED', error: 'Eligibility or provider verification failed.' }] });
  }
  const token = fingerprint(operation, environment, ownerLabel);
  if (!execute) return res.json({ status: 'ready', planId: plan.id, confirmation: {
    token, amountMinor: operation.amountMinor, currency: operation.currency, date: operation.date,
    dueDate: operation.payload.params.p_due_date, ownerLabel, environment,
    mandate: `••••${agreement.gocardless_mandate_id.slice(-4)}`,
  } });
  if (token !== body.confirmationToken) return res.status(409).json({ error: 'Collection evidence changed. Review a fresh confirmation; nothing was submitted by this request.' });
  let authorized = false;
  const result = await reconcileDynamicCollectionPlan({ db, plan, manualTiming,
    clientForTenant: async () => {
      if (client.getGocardlessEnvironment() !== environment) throw new Error('Provider environment changed');
      return client;
    },
    authorizeOperation: async candidate => {
      if (candidate.type !== 'dynamic.reserve_collection'
        || fingerprint(candidate, environment, ownerLabel) !== token) throw new Error('Confirmed collection evidence changed');
      const auth = checked(await db.rpc('authorize_gocardless_manual_collection', {
        p_tenant_id: tenantId, p_plan_id: plan.id, p_due_date: candidate.payload.params.p_due_date,
        p_collection_number: candidate.payload.params.p_collection_number,
        p_amount_minor: candidate.amountMinor, p_currency: candidate.currency,
        p_charge_date: candidate.date, p_idempotency_key: candidate.payload.params.p_idempotency_key,
        p_actor: actor, p_reason: reason,
        p_identity: { agreement: candidate.payload.agreement.id,
          member: candidate.payload.agreement.member_id || null,
          organization: candidate.payload.agreement.organization_id || null,
          mandate: candidate.payload.agreement.gocardless_mandate_id, environment },
      }), 'Authorize manual collection');
      authorized = true;
      candidate.payload.params.p_provider_evidence = {
        ...candidate.payload.params.p_provider_evidence, manual_authorization_id: auth.id,
      };
    },
  });
  if (result.errors.length) console.error('[manual-collection] execution evidence', result.errors);
  return res.json({
    status: result.outcome?.submitted ? 'submitted' : result.failed ? (authorized ? 'uncertain' : 'blocked') : 'skipped',
    reason: result.outcome?.detail || (authorized
      ? 'Submission outcome is uncertain. Do not retry. A finance operator must verify provider evidence and explicitly approve attachment of the exact existing payment. Refresh only reads records; it does not recover or resubmit.'
      : 'Collection was blocked before submission. Review the error and existing evidence.'),
    payment: result.payment, errors: result.errors.map(error => ({
      stage: error.stage, code: error.stage === 'dynamic-collection-outcome' ? 'COLLECTION_OUTCOME_WRITE_FAILED' : 'COLLECTION_EXECUTION_FAILED',
      error: error.stage === 'dynamic-collection-outcome'
        ? 'Local outcome bookkeeping could not be confirmed. Contact a finance operator.'
        : 'Collection execution could not be confirmed. Do not retry; a finance operator must reconcile the reservation and provider evidence.',
    })),
  });
}