import { freezeMembershipPreparation } from './accountingSourcePreparation.js';
import { resolveAccountingQueueBinding, resumeAccountingSource, submitUnpreparedAccountingRequest } from './accountingQueueIntegration.js';

export const trainingFundQueueEnabled = () =>
  process.env.ACCOUNTING_REQUEST_QUEUE_ENABLED === 'true'
  && process.env.ACCOUNTING_TRAINING_FUND_CONTINUATION_VERIFIED === 'true'
  && (process.env.ACCOUNTING_REQUEST_QUEUE_SOURCES || '').split(',').map(s => s.trim()).includes('training_fund_purchase');

const missing = error => error?.code === '42P01'
  || (error?.code === 'PGRST205' && error.message?.includes('training_fund_accounting_operation'));
async function rpc(db, name, args) {
  const { data, error } = await db.rpc(name, args);
  if (error) throw error;
  return data;
}

// Always look up accepted ownership, even after rollout is switched off.
export async function findTrainingFundOperation({ db, tenantId, memberId, requestKey }) {
  if (!requestKey) return null;
  const { data, error } = await db.from('training_fund_accounting_operation').select('*')
    .eq('tenant_id', tenantId).eq('member_id', memberId).eq('request_key', requestKey).maybeSingle();
  if (error && !(missing(error) && !trainingFundQueueEnabled())) throw error;
  return data || null;
}

export async function acceptTrainingFundOperation({ db, tenantId, member, org, requestKey, amount,
  paymentMethod, purchaseOrderNumber, poToFollow, provider, addonSettings }) {
  if (!/^[0-9a-f-]{36}$/i.test(requestKey || '')) throw new Error('A checkout request key is required');
  const binding = await resolveAccountingQueueBinding({ db, tenantId, provider });
  const suffix = purchaseOrderNumber ? ` (PO: ${purchaseOrderNumber})` : poToFollow ? ' (PO to follow)' : '';
  const invoice = await freezeMembershipPreparation({ db, totalMinor: Math.round(amount * 100), args: {
    appTenantId: tenantId, organizationName: org.name, invoicingEmail: org.invoicing_email || null,
    invoicingAddress: null, membershipYear: '', tierLabel: 'Training Fund', finalCost: amount,
    currency: 'GBP', reference: purchaseOrderNumber || 'Training Fund top-up',
    vatRate: addonSettings.trainingFundVatRate || null,
    nominalCode: addonSettings.trainingFundNominalCode || null, invoiceDescription: `Training Fund top-up${suffix}`,
  } });
  // Never persist connection credentials.
  const authority = { provider, connectionId: binding.connectionId, companyId: binding.companyId,
    environment: binding.environment, invoice, receiptEmail: member.email || null };
  return rpc(db, 'accept_training_fund_accounting', {
    p_tenant: tenantId, p_member: member.id, p_org: org.id, p_key: requestKey,
    p_amount: amount, p_method: paymentMethod, p_po: purchaseOrderNumber || null,
    p_po_later: !!poToFollow, p_authority: authority,
  });
}

export async function continueTrainingFundOperation({ db, operation, getStripe, getPublishableKey },
  dependencies = {}) {
  const resume = dependencies.resume || resumeAccountingSource;
  const submit = dependencies.submit || submitUnpreparedAccountingRequest;
  const source = { db, tenantId: operation.tenant_id, sourceType: 'training_fund_purchase',
    sourceId: operation.purchase_id };
  let result = await resume(source);
  if (!result) {
    const a = operation.authority;
    result = await submit({ ...source, provider: a.provider, connectionId: a.connectionId, companyId: a.companyId,
      snapshot: { version: 1, preparation: true, environment: a.environment, invoice: a.invoice,
        payment: null, linkage: { purchaseId: operation.purchase_id, organizationId: operation.organization_id } } });
  }
  const base = { success: true, purchaseId: operation.purchase_id, paymentMethod: operation.payment_method };
  if (result.accounting_pending) return { ...base, queued: true, accountingState: result.accounting_state };
  if (operation.payment_method === 'invoice') return { ...base,
    invoiceNumber: result.invoiceNumber || result.number || null, onlineInvoiceUrl: result.url || null };

  const stripe = await getStripe(operation.tenant_id);
  if (!stripe) throw new Error('Stripe is not configured for this tenant');
  const publishableKey = await getPublishableKey(operation.tenant_id);
  if (!publishableKey) throw new Error('Stripe publishable key is unavailable');
  const account = await stripe.accounts.retrieve();
  const state = await rpc(db, 'start_training_fund_card_setup', {
    p_tenant: operation.tenant_id, p_purchase: operation.purchase_id,
    p_binding: `${account.id}:${publishableKey}`,
  });
  if (state.status !== 'pending') return { ...base, alreadyProcessed: true };
  let intent;
  if (state.intent_id) intent = await stripe.paymentIntents.retrieve(state.intent_id);
  else {
    // Stripe may prune keys after 24h. An old uncertain creation needs review,
    // never another create with an expired key, even if no ID was saved locally.
    if (!Number.isFinite(Date.parse(state.started_at)) || Date.now() - Date.parse(state.started_at) > 23 * 3600000) {
      return { ...base, queued: true, accountingState: 'review' };
    }
    intent = await stripe.paymentIntents.create({
      amount: Math.round(Number(operation.amount) * 100), currency: 'gbp',
      receipt_email: operation.authority.receiptEmail || undefined,
      metadata: { payment_type: 'training_fund_purchase', purchase_id: operation.purchase_id,
        tenant_id: operation.tenant_id, organization_id: operation.organization_id },
    }, { idempotencyKey: `training-fund:${operation.tenant_id}:${operation.purchase_id}` });
    await rpc(db, 'bind_training_fund_card_setup', {
      p_tenant: operation.tenant_id, p_purchase: operation.purchase_id, p_intent: intent.id,
    });
  }
  return { ...base, clientSecret: intent.client_secret, paymentIntentId: intent.id,
    publishableKey, paymentSucceeded: intent.status === 'succeeded' };
}
