// Read-only presentation of retained collection evidence. A plan amount is an
// agreed price, not proof that the provider has scheduled a payment.
import { resolveSavedCollectionPolicy } from '../../shared/gocardlessCollectionPolicy.js';

const UPCOMING = new Set(['pending_customer_approval', 'pending_submission', 'submitted']);
const COLLECTED = new Set(['confirmed', 'paid_out']);

export function shapeCollectionDetails({
  agreement, plan, payments = [], reservation = null, paused = false,
  now = new Date(), readError = false,
}) {
  const terms = agreement?.metadata?.dd || {};
  const policy = resolveSavedCollectionPolicy(terms);
  const today = new Date(now).toISOString().slice(0, 10);
  const blockers = [];
  if (paused) blockers.push('Membership is paused');
  if (plan?.collection_stopped_at) blockers.push('Collections are stopped');
  if (['cancelled', 'paused', 'failed', 'expired'].includes(plan?.status)) {
    blockers.push(`Payment plan is ${plan.status}`);
  }
  if (['cancelled', 'mandate_cancelled', 'payment_failed', 'suspended', 'in_arrears'].includes(agreement?.status)) {
    blockers.push(`Agreement is ${agreement.status.replaceAll('_', ' ')}`);
  }
  if (['payment_setup_required', 'mandate_pending', 'pending_payment_setup'].includes(agreement?.status)) {
    blockers.push('Direct Debit setup is awaiting an active mandate');
  }
  if (plan?.membership_monthly_arrears_period?.some((row) => !row.settled_at)) {
    blockers.push('Unresolved arrears require collection review');
  }
  if (reservation?.blocked_reason) blockers.push(reservation.blocked_reason);
  if (plan?.dynamic_collection_error) blockers.push(plan.dynamic_collection_error);
  if (policy.needs_review) blockers.push('Collection policy needs review: retained consent is incomplete');
  if (readError) blockers.push('Current collection evidence could not be loaded');
  const upcoming = payments
    .filter((row) => UPCOMING.has(row.status) && row.charge_date >= today)
    .sort((a, b) => a.charge_date.localeCompare(b.charge_date))[0] || null;
  const collected = payments
    .filter((row) => COLLECTED.has(row.status))
    .sort((a, b) => String(b.charge_date).localeCompare(String(a.charge_date)))[0] || null;
  const currency = plan?.currency || terms.currency || null;
  const paymentShape = (row) => row ? {
    amount: row.amount_minor == null ? null : Number(row.amount_minor) / 100,
    currency: row.currency || currency,
    dueDate: row.charge_date || null,
    providerStatus: row.status,
  } : null;
  // A reservation is a calculation only until the provider has returned its
  // payment. Keep submitted evidence separate from the current calculation.
  const reservedProvider = reservation?.status === 'submitted'
    && reservation.gocardless_payment_id && reservation.provider_charge_date
    && reservation.provider_charge_date >= today
    && UPCOMING.has(reservation.provider_evidence?.status)
    ? {
      amount: Number(reservation.amount_minor) / 100,
      currency: reservation.currency,
      dueDate: reservation.provider_charge_date,
      providerStatus: reservation.provider_evidence.status,
    } : null;
  const provider = paymentShape(upcoming) || reservedProvider;
  const pricePreview = reservation?.amount_minor != null ? {
    amount: Number(reservation.amount_minor) / 100,
    currency: reservation.currency,
    dueDate: reservation.due_date,
    label: 'Reserved price — not a confirmed charge',
  } : null;
  let state = 'unknown';
  let amount = null;
  let dueDate = null;
  if (provider) {
    state = 'provider_scheduled';
    amount = provider.amount;
    dueDate = provider.dueDate;
  } else if (blockers.length) {
    state = 'blocked';
  } else if (pricePreview) {
    state = 'reserved';
    amount = pricePreview.amount;
    dueDate = pricePreview.dueDate;
  } else if (policy.pricing_policy === 'fixed' && terms.monthly_amount_minor != null) {
    state = 'agreed';
    amount = Number(terms.monthly_amount_minor) / 100;
  } else if (collected) {
    state = 'last_collected';
    amount = Number(collected.amount_minor) / 100;
    dueDate = collected.charge_date;
  }
  return {
    state, amount, currency: provider?.currency || pricePreview?.currency || currency,
    dueDate, providerStatus: provider?.providerStatus || null,
    upcomingCollection: provider, lastCollection: paymentShape(collected),
    pricePreview, blockers,
  };
}

export async function loadGoCardlessCollectionDetails({
  db, tenantId, agreement, plan, paused = false, now = new Date(), resolvePrice = null,
}) {
  if (!plan && agreement?.tenant_id === tenantId) {
    return shapeCollectionDetails({ agreement, plan: null, paused, now });
  }
  if (!plan || plan.tenant_id !== tenantId || agreement?.tenant_id !== tenantId
    || plan.billing_agreement_id !== agreement.id) {
    return shapeCollectionDetails({ agreement, plan: null, paused, now, readError: true });
  }
  try {
    const { data: payments, error } = await db.from('gocardless_payments')
      .select('amount_minor,currency,status,charge_date')
      .eq('tenant_id', tenantId).eq('plan_id', plan.id)
      .order('charge_date', { ascending: false }).limit(24);
    if (error) throw error;
    let reservation = null;
    if (resolveSavedCollectionPolicy(agreement.metadata?.dd || {}).pricing_policy === 'dynamic') {
      const fields = 'due_date,amount_minor,currency,status,gocardless_payment_id,provider_charge_date,provider_evidence,blocked_reason';
      const result = await db.from('gocardless_collection_reservations')
        .select(fields)
        .eq('tenant_id', tenantId).eq('billing_agreement_id', agreement.id)
        .eq('plan_id', plan.id)
        .gte('due_date', new Date(now).toISOString().slice(0, 10))
        .order('due_date', { ascending: true }).limit(1).maybeSingle();
      if (result.error) throw result.error;
      reservation = result.data;
      if (!reservation) {
        const latest = await db.from('gocardless_collection_reservations')
          .select(fields)
          .eq('tenant_id', tenantId).eq('billing_agreement_id', agreement.id)
          .eq('plan_id', plan.id)
          .order('due_date', { ascending: false }).limit(1).maybeSingle();
        if (latest.error) throw latest.error;
        reservation = latest.data;
      }
    }
    const details = shapeCollectionDetails({ agreement, plan, payments: payments || [], reservation, paused, now });
    const pricingDate = details.upcomingCollection?.dueDate || plan.dynamic_next_collection_date;
    if (resolveSavedCollectionPolicy(agreement.metadata?.dd || {}).pricing_policy === 'dynamic' && pricingDate) {
      try {
        const resolver = resolvePrice
          || (await import('./gocardlessDynamicCollections.js')).resolveDynamicCollectionPrice;
        const price = await resolver(agreement, pricingDate, { db });
        details.pricePreview = {
          amount: price.monthly_amount_minor / 100, currency: price.currency, dueDate: pricingDate,
          label: 'Current calculated price — not a confirmed charge',
        };
        if (details.upcomingCollection && details.upcomingCollection.amount !== details.pricePreview.amount) {
          details.blockers.push('The current calculated price differs from the already scheduled collection. The provider payment will not be repriced.');
        }
      } catch {
        details.pricePreview = null;
        details.blockers.push('The current active price could not be resolved unambiguously; review is required');
      }
    }
    return details;
  } catch {
    // Failed reads must be visible, never represented as a confirmed £0 charge.
    return shapeCollectionDetails({ agreement, plan, paused, now, readError: true });
  }
}