// Resumable provider handover. No browser result is evidence of collection
// authority. Every destructive step has a persisted phase and a read-back.
import { buildIdempotencyKey } from './gocardless.js';

export class ReplacementReviewRequired extends Error {
  constructor(reason) { super(reason); this.name = 'ReplacementReviewRequired'; }
}
const review = reason => { throw new ReplacementReviewRequired(reason); };
const settled = p => p.status === 'paid_out';
const canonicalSchedule = rows => JSON.stringify(rows.map(p => ({
  amount: p.amount, charge_date: p.charge_date,
})));

export async function readReplacementInventory(gc, mandateId) {
  async function pages(method, field) {
    const all = [], cursors = new Set(), ids = new Set();
    let after = null;
    do {
      const page = await gc[method]({ mandateId, after, limit: 100 });
      if (!Array.isArray(page[field]) || !Object.hasOwn(page, 'after')
          || (page.after !== null && (typeof page.after !== 'string' || !page.after))) {
        review('incomplete_provider_inventory');
      }
      for (const row of page[field]) {
        if (!row.id || ids.has(row.id) || row.links?.mandate !== mandateId) review('ambiguous_provider_inventory');
        ids.add(row.id); all.push(row);
      }
      after = page.after;
      if (after && cursors.has(after)) review('repeated_provider_cursor');
      cursors.add(after);
      if (cursors.size > 100) review('provider_inventory_requires_assistance');
    } while (after);
    return all;
  }
  const [payments, subscriptions] = await Promise.all([
    pages('listReplacementPaymentsPage', 'payments'), pages('listSubscriptionsPage', 'subscriptions'),
  ]);
  return { payments, subscriptions };
}

// This deliberately supports only schedules whose entire remainder can be
// independently compared. The provider's ten-item preview is NOT extrapolated.
export function buildReplacementSchedule({ agreement, history, plan, inventory, oldMandate, newMandate, today }) {
  if (!oldMandate?.id || oldMandate.id === newMandate?.id
      || oldMandate.status !== 'active' || newMandate?.status !== 'active'
      || !oldMandate.links?.creditor || oldMandate.links.creditor !== newMandate.links?.creditor
      || oldMandate.scheme !== newMandate.scheme
      || !/^\d{4}-\d{2}-\d{2}$/.test(newMandate.next_possible_charge_date || '')) review('mandate_not_ready');
  if (agreement.agreement_type !== 'member' || agreement.organization_id
      || agreement.member_id !== history.member_id || agreement.tenant_id !== history.tenant_id
      || agreement.gocardless_mandate_id !== oldMandate.id
      || agreement.metadata?.collection_hold || agreement.needs_attention) review('ownership_or_collection_hold');
  // Imported/adopted mandates can have an external scheduler even when the
  // provider currently lists no subscription. Only app-origin consent qualifies.
  if (!agreement.gocardless_billing_request_id
      || !agreement.metadata?.dd || agreement.metadata?.migration
      || agreement.metadata?.external_scheduler || agreement.metadata?.adopted) review('external_or_unproven_scheduler');
  if (inventory.payments.some(p => !settled(p))) review('unsettled_or_retryable_payment');
  const live = inventory.subscriptions.filter(s => !['finished', 'cancelled'].includes(s.status));
  const base = { agreement, history, plan: plan || null, payments: inventory.payments,
    oldMandate, newMandate, cutoff: today, remaining: [], subscription: null };
  if (!plan) {
    if (live.length || agreement.metadata.dd.kind === 'monthly_direct_debit'
        || history.payment_status !== 'paid') review('annual_collection_not_settled');
    return { ...base, mode: 'annual' };
  }
  if (plan.billing_agreement_id !== agreement.id || plan.member_id !== agreement.member_id
      || plan.tenant_id !== agreement.tenant_id || plan.organization_id
      || plan.gocardless_mandate_id !== oldMandate.id || plan.environment !== agreement.environment
      || plan.needs_attention || plan.auto_retry_claim_token || plan.auto_retry_payment_id
      || plan.collection_stopped_at || !['active', 'completed'].includes(plan.status)) review('plan_requires_assistance');
  const earliest = [today, newMandate.next_possible_charge_date].sort().at(-1);
  if (plan.metadata?.collection_mode === 'dynamic') {
    if (live.length || plan.gocardless_subscription_id
        || (plan.dynamic_next_collection_date && plan.dynamic_next_collection_date < earliest)) review('dynamic_collection_notice_window');
    return { ...base, mode: 'dynamic' };
  }
  const sub = live[0];
  if (live.length !== 1 || !sub || sub.id !== plan.gocardless_subscription_id
      || sub.status !== 'active' || sub.interval_unit !== 'monthly' || (sub.interval || 1) !== 1
      || sub.amount !== plan.amount_minor || sub.currency !== plan.currency
      || sub.metadata?.plan_id !== plan.id || sub.metadata?.agreement_id !== agreement.id
      || sub.metadata?.tenant_id !== agreement.tenant_id) review('subscription_ownership_or_terms');
  const paid = inventory.payments.filter(p => p.links?.subscription === sub.id);
  if (!Number.isSafeInteger(sub.count) || sub.count <= 0) review('unbounded_subscription');
  const terms = agreement.metadata.dd;
  const initialCount = terms.billing_request_payment?.included === true ? 1 : 0;
  if (!Number.isSafeInteger(terms.instalment_count) || terms.instalment_count <= 0
      || terms.instalment_count !== plan.instalments_total
      || sub.count !== terms.instalment_count - initialCount) review('subscription_count_disagrees_with_consent');
  if (paid.some(p => p.amount !== sub.amount || p.currency !== sub.currency)) review('paid_instalment_terms_mismatch');
  const initialId = agreement.metadata.gocardless_initial_payment?.id;
  const initial = initialCount ? inventory.payments.find(p => p.id === initialId) : null;
  if (initialCount && (!initial || initial.links?.subscription
      || initial.amount !== terms.billing_request_payment.amount_minor
      || initial.currency !== (terms.currency || 'GBP'))) review('initial_payment_not_verified');
  if (inventory.payments.some(p => p.links?.subscription !== sub.id
      && (!initialCount || p.id !== initialId))) review('unallocated_payment_requires_assistance');
  const remainingCount = sub.count - paid.length;
  const remaining = sub.upcoming_payments;
  // GoCardless does not maintain the Stripe-oriented instalments_paid column.
  // Only the complete provider inventory plus the original initial-payment
  // contract establish how many purchased instalments remain.
  if (remainingCount < 1 || remainingCount > 10 || !Array.isArray(remaining)
      || remaining.length !== remainingCount) review('incomplete_remaining_schedule');
  let previous = '';
  for (const p of remaining) {
    if (p.amount !== sub.amount || !/^\d{4}-\d{2}-\d{2}$/.test(p.charge_date || '')
        || p.charge_date < earliest || p.charge_date <= previous
        || p.charge_date > history.term_end_date) review('remaining_schedule_or_notice_window');
    previous = p.charge_date;
  }
  return { ...base, mode: 'subscription', remaining, subscription: sub };
}

export function assertSuccessorSubscription(sub, operation) {
  const snapshot = operation.snapshot;
  if (!sub?.id || sub.links?.mandate !== operation.new_mandate_id
      || !['active', 'pending_customer_approval'].includes(sub.status)
      || sub.metadata?.replacement_id !== operation.id
      || sub.amount !== snapshot.subscription.amount || sub.currency !== snapshot.subscription.currency
      || sub.count !== snapshot.remaining.length || sub.interval_unit !== 'monthly'
      || (sub.interval || 1) !== 1 || !Array.isArray(sub.upcoming_payments)
      || canonicalSchedule(sub.upcoming_payments) !== canonicalSchedule(snapshot.remaining)) {
    review('successor_schedule_not_verified');
  }
  if (sub.status !== 'active') review('successor_approval_required');
}

// Store supplies CAS transitions and an atomic identity-only commit; gc must be
// scoped to this operation by the provider-mutation fence. Never pass a general
// tenant client to this function in production.
export async function runReplacementHandover({ operation, store, gc, maxSteps = 8 }) {
  let op = operation;
  for (let step = 0; step < maxSteps && op.status === 'switching'; step++) {
    const advance = patch => store.advance(op, patch);
    if (op.phase === 'prepared') {
      // Let requests from an older deployment drain before destructive work.
      // The DB/provider fences remain held throughout this settling window.
      const preparedAt = op.snapshot.prepared_at || op.updated_at;
      if (preparedAt && Date.parse(preparedAt) > Date.now() - 300000) return op;
      // Recheck under the durable fence, before stopping any collection.
      const [old, candidate, inventory] = await Promise.all([
        gc.getMandate(op.old_mandate_id), gc.getMandate(op.new_mandate_id),
        readReplacementInventory(gc, op.old_mandate_id),
      ]);
      const verified = buildReplacementSchedule({ ...op.snapshot, inventory,
        oldMandate: old, newMandate: candidate, today: new Date().toISOString().slice(0, 10) });
      if (canonicalSchedule(verified.remaining) !== canonicalSchedule(op.snapshot.remaining)) review('schedule_changed_before_cutover');
      op = await advance({ phase: op.snapshot.mode === 'subscription' ? 'stop_intent' : 'commit_intent' });
    } else if (op.phase === 'stop_intent') {
      const id = op.snapshot.subscription.id;
      let sub = await gc.getSubscription(id);
      if (sub?.id !== id || sub.links?.mandate !== op.old_mandate_id) review('old_subscription_identity');
      if (sub.status === 'active') {
        await gc.cancelSubscription(id);
        sub = await gc.getSubscription(id);
      }
      if (sub.status !== 'cancelled') review('old_subscription_stop_unconfirmed');
      // Cancellation doesn't cancel already-created payments. Detect a provider
      // scheduler race before creating any successor.
      const inventory = await readReplacementInventory(gc, op.old_mandate_id);
      const beforeIds = op.snapshot.payments.map(p => p.id).sort();
      if (JSON.stringify(inventory.payments.map(p => p.id).sort()) !== JSON.stringify(beforeIds)
          || inventory.payments.some(p => !settled(p))
          || inventory.subscriptions.some(s => !['cancelled', 'finished'].includes(s.status))) review('collection_created_during_stop');
      op = await advance({ phase: 'create_intent' });
    } else if (op.phase === 'create_intent') {
      const s = op.snapshot.subscription;
      const sub = await gc.createSubscription({
        mandateId: op.new_mandate_id, amountMinor: s.amount, currency: s.currency,
        intervalUnit: 'monthly', dayOfMonth: s.day_of_month, name: s.name,
        startDate: op.snapshot.remaining[0].charge_date, count: op.snapshot.remaining.length,
        metadata: { replacement_id: op.id, tenant_id: op.tenant_id, plan_id: op.snapshot.plan.id },
        idempotencyKey: buildIdempotencyKey('replacement-subscription', op.id),
      });
      // Persist identity even if returned terms require review; never lose a
      // provider-created subscription merely because validation failed.
      if (!sub?.id) throw new Error('Successor subscription outcome unknown');
      op = await advance({ new_subscription_id: sub.id, phase: 'verify_successor' });
    } else if (op.phase === 'verify_successor') {
      const sub = await gc.getSubscription(op.new_subscription_id);
      assertSuccessorSubscription(sub, op);
      op = await advance({ phase: 'commit_intent' });
    } else if (op.phase === 'commit_intent') {
      op = await store.commit(op);
    } else if (op.phase === 'retire_intent') {
      // Authority is committed, but ordinary new collections stay fenced until
      // retirement is positively observed. Unknown results remain resumable.
      const candidate = await gc.getMandate(op.new_mandate_id);
      if (candidate?.status !== 'active' || candidate.id !== op.new_mandate_id) review('successor_mandate_not_active');
      const inventory = await readReplacementInventory(gc, op.old_mandate_id);
      if (inventory.payments.some(p => !settled(p))
          || inventory.subscriptions.some(s => !['cancelled', 'finished'].includes(s.status))) review('old_obligations_not_retired');
      let old = await gc.getMandate(op.old_mandate_id);
      if (old?.id !== op.old_mandate_id) review('old_mandate_identity');
      if (old.status === 'active') {
        await gc.cancelMandate(op.old_mandate_id);
        old = await gc.getMandate(op.old_mandate_id);
      }
      if (old.status !== 'cancelled') throw new Error('Old mandate retirement is not confirmed');
      op = await store.complete(op);
    } else throw new Error('Unknown handover phase');
  }
  return op;
}
