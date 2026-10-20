import { createHash } from 'node:crypto';
import {
  monthlyStripeForTenant, monthlyGoCardlessForTenant, allStripeInvoices, allStripeInvoicePayments, allGoCardlessPayments,
} from './memberAmendmentMonthlyProviders.js';

export class MonthlyAmendmentError extends Error {
  constructor(code, message) { super(message); this.code = code; this.status = 422; }
}
const block = (code, message) => { throw new MonthlyAmendmentError(code, message); };
const ref = value => typeof value === 'string' ? value : value?.id;
const day = epoch => new Date(epoch * 1000).toISOString().slice(0, 10);
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
export const monthlyAmendmentFingerprint = value =>
  createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const positive = value => Number.isSafeInteger(value) && value > 0;
const date = value => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '') || !Number.isFinite(Date.parse(`${value}T00:00:00Z`))
    || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) {
    block('invalid_date', 'An exact date-only original collection boundary is required');
  }
  return value;
};

// authority is server-owned immutable evidence, NEVER a client-authored object.
function validate(input, now) {
  const { tenantId, memberId, purchase: p, agreement: a, plan, authority: auth, target } = input;
  if (!tenantId || !memberId || !auth || !p || !a || !plan || !target) {
    block('purchase_authority_required', 'Purchase, consent, payment plan and immutable monthly authority are required');
  }
  const same = (actual, expected) => actual != null && actual === expected;
  if (![p, a, plan].every(row => same(row.tenant_id, tenantId) && same(row.member_id, memberId))
    || a.organization_id || plan.organization_id || a.agreement_type !== 'member'
    || !same(p.billing_agreement_id, a.id) || !same(plan.billing_agreement_id, a.id)
    || !same(auth.purchaseId, p.id) || !same(auth.agreementId, a.id) || !same(auth.planId, plan.id)
    || !same(auth.tenantId, tenantId) || !same(auth.memberId, memberId)
    || !same(auth.provider, a.provider) || !same(plan.provider, a.provider)
    || !same(auth.environment, a.environment) || !same(plan.environment, a.environment)) {
    block('ownership_mismatch', 'Monthly purchase, tenant, member, payer, plan or environment linkage is inconsistent');
  }
  if (!['stripe', 'gocardless'].includes(a.provider)
    || !(a.provider === 'stripe' ? ['live', 'test'] : ['live', 'sandbox']).includes(auth.environment)) {
    block('unsupported_provider', 'Unsupported monthly provider or environment');
  }
  const terms = a.metadata?.[a.provider === 'stripe' ? 'card' : 'dd'];
  if (!terms || terms.kind !== (a.provider === 'stripe' ? 'monthly_card' : 'monthly_direct_debit')
    || !terms.accepted_at || !auth.termKey || !same(terms.commitment?.term_key, auth.termKey)
    || !same(auth.termsHash, monthlyAmendmentFingerprint(terms))
    || !['annual_instalments', 'monthly_price'].includes(auth.pricingBasis)
    || !Array.isArray(auth.collectionDates) || !auth.collectionDates.length
    || auth.collectionDates.some((d, i, dates) => date(d) !== d || (i > 0 && d <= dates[i - 1]))) {
    block('purchase_authority_required', 'Immutable consent terms, pricing basis and original finite collection dates must be explicit');
  }
  if (p.status !== 'active' || !['active', 'first_payment_pending'].includes(plan.status)
    || !['active', 'first_payment_pending'].includes(a.status)
    || plan.collection_stopped_at || plan.metadata?.bnms_release_required
    || plan.metadata?.catch_up_intent || a.metadata?.bnms_pilot_approval
    || plan.metadata?.workflow_pending || plan.metadata?.workflow_delivery?.status === 'pending') {
    block('plan_not_amendable', 'Stopped, incomplete or inactive monthly plans require review');
  }
  if (!/^[A-Z]{3}$/.test(auth.currency || '') || terms.currency?.toUpperCase() !== auth.currency
    || target.currency !== auth.currency || plan.currency?.toUpperCase() !== auth.currency) {
    block('currency_mismatch', 'Currency changes or ambiguous currency are not supported');
  }
  // This engine deliberately supports two-decimal currencies only.
  try {
    if (new Intl.NumberFormat('en', { style: 'currency', currency: auth.currency })
      .resolvedOptions().maximumFractionDigits !== 2) block('unsupported_currency', 'Two-decimal currency required');
  } catch (error) {
    if (error instanceof MonthlyAmendmentError) throw error;
    block('unsupported_currency', 'Recognized two-decimal currency required');
  }
  date(input.effectiveDate);
  if (input.effectiveDate < now.toISOString().slice(0, 10)
    || !auth.collectionDates.includes(input.effectiveDate)) {
    block('billing_boundary_required', 'Only future original collection boundaries may be amended');
  }
  if (!/^[A-Za-z0-9_.:-]{8,128}$/.test(input.amendmentId || '')) {
    block('amendment_id_required', 'A durable server-owned amendment operation ID is required');
  }
  if (!auth.payerId) block('payer_required', 'Immutable provider payer ID is required');
  return terms;
}

function economics(input, immutable) {
  const { authority: auth, target, effectiveDate } = input;
  const future = auth.collectionDates.filter(d => d >= effectiveDate);
  if (!future.length || immutable.some(p => p.date >= effectiveDate)) {
    block('submitted_payment', 'Effective collection already has generated/submitted payment evidence; choose a later billing boundary');
  }
  let amountMinor;
  const retainedMinor = immutable.reduce((sum, p) => sum + p.amountMinor, 0);
  if (immutable.some(p => !auth.collectionDates.includes(p.date))
    || new Set(immutable.map(p => p.date)).size !== immutable.length) {
    block('unresolved_instalments', 'Payment periods must be unique original purchased collection dates');
  }
  if (!Number.isSafeInteger(retainedMinor)) block('invalid_amount', 'Retained payment total exceeds exact integer arithmetic');
  if (auth.pricingBasis === 'annual_instalments') {
    if (!positive(target.termTotalMinor)) block('annual_obligation_required', 'An approved revised whole-term obligation is required, not a monthly-price substitution');
    // Do not redistribute a missing/failed earlier instalment as a new debt.
    const past = auth.collectionDates.filter(d => d < effectiveDate);
    if (past.length !== immutable.length || past.some(d => !immutable.some(p => p.date === d))) {
      block('unresolved_instalments', 'Earlier instalments are missing or duplicated; reconcile before redistributing the annual obligation');
    }
    const remaining = target.termTotalMinor - retainedMinor;
    if (!positive(remaining) || remaining % future.length !== 0) {
      block('nonuniform_instalments', 'Remaining annual obligation cannot be expressed as equal positive exact instalments');
    }
    amountMinor = remaining / future.length;
  } else {
    if (!positive(target.amountMinor)) block('invalid_amount', 'Positive exact prospective monthly amount required');
    amountMinor = target.amountMinor;
  }
  if (!Number.isSafeInteger(amountMinor * future.length)) block('invalid_amount', 'Prospective amount exceeds exact integer arithmetic');
  return { pricingBasis: auth.pricingBasis, currency: auth.currency, amountMinor,
    retainedMinor, remainingCollections: future.length,
    prospectiveTotalMinor: amountMinor * future.length,
    effectiveDate, collectionDates: future, proration: 'none' };
}

function stripeItems(items) {
  if (!Array.isArray(items) || items.length !== 1 || (items[0].quantity ?? 1) !== 1
    || items[0].tax_rates?.length || items[0].discounts?.length || items[0].billing_thresholds) {
    block('unsupported_stripe_items', 'Exactly one untaxed, undiscounted quantity-one recurring item is supported');
  }
  return [{ price: ref(items[0].price), quantity: 1 }];
}
function simpleStripePrice(price, currency, amount) {
  if (!price?.id || price.active === false || price.currency !== currency.toLowerCase()
    || price.unit_amount !== amount || price.type !== 'recurring'
    || price.recurring?.interval !== 'month' || price.recurring?.interval_count !== 1
    || price.recurring?.usage_type !== 'licensed' || price.billing_scheme !== 'per_unit'
    || price.transform_quantity || price.tax_behavior === 'exclusive') {
    block('unsupported_stripe_price', 'Existing exact licensed monthly price without additional tax is required');
  }
}
function stripeRestricted(object) {
  if (object.discounts?.length || object.default_tax_rates?.length || object.tax_rates?.length
    || object.automatic_tax?.enabled || object.trial_end || object.add_invoice_items?.length
    || object.billing_thresholds || object.transfer_data || object.application_fee_percent) {
    block('unsupported_stripe_schedule', 'Tax, discount, trial, add-on, transfer or threshold schedule economics require a specialized adapter');
  }
}

async function inspectStripe(input, stripe, now) {
  const { agreement: a, plan, authority: auth } = input;
  const sub = await stripe.subscriptions.retrieve(plan.stripe_subscription_id);
  if (!sub?.id || sub.id !== a.stripe_subscription_id || ref(sub.customer) !== auth.payerId
    || a.stripe_customer_id !== auth.payerId || plan.stripe_customer_id !== auth.payerId
    || sub.livemode !== (auth.environment === 'live')
    || sub.metadata?.tenant_id !== input.tenantId || sub.metadata?.member_id !== input.memberId
    || sub.metadata?.kind !== 'monthly_card'
    || (sub.metadata?.agreement_id && sub.metadata.agreement_id !== a.id)
    || sub.status !== 'active' || sub.cancel_at || sub.cancel_at_period_end || sub.pause_collection
    || sub.pending_update || !ref(sub.schedule)) {
    block('stripe_ownership_mismatch', 'Stripe subscription ownership, mode, payer or lifecycle is not safely amendable');
  }
  const customer = await stripe.customers.retrieve(auth.payerId);
  if (customer.deleted || customer.metadata?.tenant_id !== input.tenantId
    || customer.metadata?.member_id !== input.memberId) block('payer_mismatch', 'Stripe customer is not the purchased personal payer');
  const schedule = await stripe.subscriptionSchedules.retrieve(ref(sub.schedule));
  if (schedule.status !== 'active' || ref(schedule.subscription) !== sub.id
    || ref(schedule.customer) !== auth.payerId || schedule.livemode !== sub.livemode
    || schedule.metadata?.agreement_id !== a.id || schedule.metadata?.kind !== 'monthly_card'
    || schedule.end_behavior !== 'cancel') {
    block('stripe_schedule_ownership', 'A recognized owned active finite cancel-at-end schedule is required');
  }
  stripeRestricted(sub);
  stripeRestricted(schedule.default_settings || {});
  const currentItems = stripeItems(sub.items?.data);
  const existingPrice = await stripe.prices.retrieve(currentItems[0].price);
  simpleStripePrice(existingPrice, auth.currency, existingPrice.unit_amount);
  if (existingPrice.livemode !== sub.livemode) block('mode_mismatch', 'Stripe price mode mismatch');
  const invoices = await allStripeInvoices(stripe, sub.id);
  const immutable = [];
  for (const inv of invoices.filter(inv => inv.status !== 'void')) {
    if (inv.status !== 'paid' || inv.amount_remaining !== 0 || inv.lines?.has_more
      || inv.lines?.data?.length !== 1 || inv.customer !== auth.payerId
      || inv.currency !== auth.currency.toLowerCase() || inv.amount_paid !== inv.total) {
      block('unresolved_invoice', 'Draft/open/unpaid, complex or foreign invoices must be reconciled first');
    }
    const line = inv.lines.data[0];
    if (line.proration || line.parent?.subscription_item_details?.proration
      || !positive(inv.total) || line.amount !== inv.total || !Number.isInteger(line.period?.start)) {
      block('unresolved_invoice', 'Invoice must represent one exact settled original billing period');
    }
    const payments = await allStripeInvoicePayments(stripe, inv.id);
    if (payments.length !== 1 || payments[0].amount_paid !== inv.total
      || payments[0].payment?.type !== 'payment_intent' || !ref(payments[0].payment.payment_intent)) {
      block('unresolved_invoice', 'Exactly one fully paid card PaymentIntent is required; credits/external/split payments need review');
    }
    const intent = await stripe.paymentIntents.retrieve(ref(payments[0].payment.payment_intent));
    const charge = ref(intent.latest_charge) ? await stripe.charges.retrieve(ref(intent.latest_charge)) : null;
    if (intent.status !== 'succeeded' || ref(intent.customer) !== auth.payerId
      || intent.livemode !== sub.livemode || intent.currency !== inv.currency
      || intent.amount !== inv.total || !charge?.paid || !charge.captured || charge.refunded
      || charge.amount_refunded !== 0 || charge.disputed || ref(charge.customer) !== auth.payerId
      || charge.livemode !== sub.livemode || charge.currency !== inv.currency || charge.amount !== inv.total) {
      block('unresolved_invoice', 'Refunded, disputed, uncaptured or foreign invoice payment requires reconciliation');
    }
    immutable.push({ id: inv.id, date: day(line.period.start), amountMinor: inv.total });
  }
  immutable.sort((x, y) => x.date.localeCompare(y.date));
  const effectiveAt = auth.collectionDates.indexOf(input.effectiveDate);
  // Exact seconds retain billing-anchor time-of-day, not effective-date midnight.
  const anchor = sub.billing_cycle_anchor;
  if (!Number.isInteger(anchor) || !Number.isInteger(auth.finiteEnd)) {
    block('purchase_authority_required', 'Exact original billing anchor and finite end are required');
  }
  const anchorDate = new Date(anchor * 1000);
  const timestamp = Date.parse(`${input.effectiveDate}T${anchorDate.toISOString().slice(11)}`) / 1000;
  if (effectiveAt < 0 || timestamp <= now.getTime() / 1000 || timestamp >= auth.finiteEnd) {
    block('billing_boundary_required', 'A future billing boundary strictly inside the purchased finite term is required');
  }
  // Prove dates against Stripe's actual anchor rather than trusting a caller's
  // nominal month/day (including clamped February / 29th-31st anniversaries).
  const boundaries = auth.collectionDates.map((_, offset) => {
    const d = new Date(anchor * 1000);
    const originalDay = d.getUTCDate();
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() + offset);
    const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    d.setUTCDate(Math.min(last, originalDay));
    return d.getTime() / 1000;
  });
  const expectedEnd = (() => {
    const d = new Date(anchor * 1000);
    const originalDay = d.getUTCDate();
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() + auth.collectionDates.length);
    const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    d.setUTCDate(Math.min(last, originalDay));
    return d.getTime() / 1000;
  })();
  if (boundaries.some((b, i) => day(b) !== auth.collectionDates[i])
    || boundaries[effectiveAt] !== timestamp || expectedEnd !== auth.finiteEnd) {
    block('billing_boundary_required', 'Purchased collection dates/end do not match the provider monthly anchor');
  }
  return { sub, schedule, immutable, timestamp };
}

async function inspectGc(input, gc) {
  const { agreement: a, authority: auth, plan } = input;
  if (gc.getGocardlessEnvironment() !== auth.environment) block('mode_mismatch', 'GoCardless client mode mismatch');
  const mandate = await gc.getMandate(a.gocardless_mandate_id);
  if (!mandate?.id || mandate.id !== plan.gocardless_mandate_id
    || mandate.status !== 'active' || mandate.links?.customer !== auth.payerId
    || !mandate.next_possible_charge_date) block('payer_mismatch', 'Active purchased mandate/payer and notice date are required');
  const all = await allGoCardlessPayments(gc, mandate.id);
  const dynamic = a.metadata.dd.collection_policy?.pricing_policy === 'dynamic';
  if (dynamic && (a.metadata.dd.collection_policy?.version !== 1
    || !['stop', 'continue'].includes(a.metadata.dd.collection_policy?.end_policy)
    || a.metadata.dd.invoicing_mode !== 'per_instalment'
    || plan.metadata?.collection_mode !== 'dynamic' || plan.gocardless_subscription_id)) {
    block('dynamic_consent_required', 'Explicit versioned dynamic consent and a subscription-free dynamic plan are required');
  }
  const subscriptionId = plan.gocardless_subscription_id;
  const initialId = a.metadata?.gocardless_initial_payment?.id;
  const payments = all.filter(p => dynamic ? p.metadata?.plan_id === plan.id
    : p.links?.subscription === subscriptionId || p.id === initialId);
  const immutable = payments.map(p => {
    if (p.links?.mandate !== mandate.id || p.currency !== auth.currency
      || !['pending_submission', 'submitted', 'confirmed', 'paid_out'].includes(p.status)
      || Number(p.amount_refunded || 0) !== 0
      || !positive(p.amount) || !auth.collectionDates.includes(p.charge_date)) {
      block('unresolved_payment', 'Failed, cancelled, foreign, off-boundary or refunded payments require reconciliation');
    }
    return { id: p.id, date: p.charge_date, amountMinor: p.amount };
  }).sort((x, y) => x.date.localeCompare(y.date));
  if (dynamic) return { mandate, immutable, dynamic: true };
  if (!subscriptionId) block('subscription_required', 'Fixed DD requires an existing provider subscription');
  const subscription = await gc.getSubscription(subscriptionId);
  if (subscription.id !== subscriptionId || subscription.status !== 'active'
    || subscription.links?.mandate !== mandate.id || subscription.currency !== auth.currency
    || subscription.interval_unit !== 'monthly' || subscription.interval !== 1
    || !Number.isInteger(subscription.count) || subscription.count < 1
    || subscription.metadata?.tenant_id !== input.tenantId
    || subscription.metadata?.agreement_id !== a.id || subscription.metadata?.plan_id !== plan.id) {
    block('gc_subscription_ownership', 'Owned active finite monthly subscription required');
  }
  if (subscription.count + (initialId ? 1 : 0) !== auth.collectionDates.length
    || !positive(subscription.amount)) {
    block('gc_commitment_mismatch', 'Provider subscription count does not match the purchased finite collection obligation');
  }
  return { mandate, subscription, immutable, dynamic: false };
}

export function createMemberAmendmentMonthlyService({
  getStripe = monthlyStripeForTenant, getGc = monthlyGoCardlessForTenant, now = () => new Date(),
} = {}) {
  async function inspect(input) {
    validate(input, now());
    const client = await (input.authority.provider === 'stripe' ? getStripe : getGc)(input.tenantId, input.authority.environment);
    const evidence = input.authority.provider === 'stripe'
      ? await inspectStripe(input, client, now()) : await inspectGc(input, client);
    return { client, evidence };
  }
  async function prepare(input) {
    const { evidence } = await inspect(input);
    const quote = economics(input, evidence.immutable);
    let mutation;
    if (input.authority.provider === 'stripe') {
      const { schedule, timestamp, sub } = evidence;
      if (schedule.phases?.length !== 1) block('unsupported_stripe_schedule', 'Only an original single-phase schedule can be amended automatically');
      const phase = schedule.phases[0];
      stripeRestricted(phase);
      if (phase.start_date !== schedule.current_phase?.start_date || phase.start_date >= timestamp
        || phase.end_date !== input.authority.finiteEnd
        || monthlyAmendmentFingerprint(stripeItems(phase.items)) !== monthlyAmendmentFingerprint(stripeItems(sub.items.data))) {
        block('unsupported_stripe_schedule', 'Original schedule dates/items or finite end do not match purchased authority');
      }
      // Reject unknown economically meaningful phase settings rather than silently omitting them.
      const allowed = new Set(['start_date', 'end_date', 'items', 'proration_behavior', 'metadata',
        'currency', 'collection_method', 'invoice_settings', 'default_payment_method',
        'billing_cycle_anchor', 'automatic_tax', 'discounts', 'default_tax_rates',
        'add_invoice_items', 'application_fee_percent', 'transfer_data', 'trial_end', 'billing_thresholds']);
      for (const [key, value] of Object.entries(phase)) {
        if (!allowed.has(key) && value != null && (!Array.isArray(value) || value.length)) {
          block('unsupported_stripe_schedule', `Unsupported existing Stripe phase setting: ${key}`);
        }
      }
      if (phase.billing_cycle_anchor && phase.billing_cycle_anchor !== 'automatic') {
        block('unsupported_stripe_schedule', 'Custom phase billing anchors are not supported');
      }
      if (!input.target.stripePriceId) block('stripe_price_required', 'Existing approved target Stripe price ID required');
      const client = await getStripe(input.tenantId, input.authority.environment);
      const targetPrice = await client.prices.retrieve(input.target.stripePriceId);
      simpleStripePrice(targetPrice, quote.currency, quote.amountMinor);
      if (targetPrice.livemode !== (input.authority.environment === 'live')) block('mode_mismatch', 'Target Stripe price mode mismatch');
      const preserved = {};
      for (const key of ['metadata', 'collection_method', 'invoice_settings', 'default_payment_method']) {
        if (phase[key] != null) preserved[key] = phase[key];
      }
      if (preserved.default_payment_method) preserved.default_payment_method = ref(preserved.default_payment_method);
      mutation = { kind: 'stripe_schedule', id: schedule.id, params: {
        end_behavior: 'cancel', proration_behavior: 'none',
        metadata: { ...schedule.metadata, member_amendment_id: input.amendmentId },
        phases: [
          { ...preserved, start_date: phase.start_date, end_date: timestamp,
            items: stripeItems(phase.items), proration_behavior: 'none' },
          { ...preserved, start_date: timestamp, end_date: phase.end_date,
            items: [{ price: input.target.stripePriceId, quantity: 1 }], proration_behavior: 'none' },
        ],
      } };
    } else if (evidence.dynamic) {
      mutation = { kind: 'dynamic_revision_required', id: input.plan.id };
    } else {
      const upcoming = evidence.subscription.upcoming_payments;
      if (!Array.isArray(upcoming) || upcoming.length !== quote.collectionDates.length
        || upcoming[0].charge_date !== input.effectiveDate
        || evidence.mandate.next_possible_charge_date > input.effectiveDate
        || upcoming.some((p, i) => p.charge_date !== quote.collectionDates[i])) {
        block('gc_notice_or_boundary', 'Next ungenerated collection must match the effective date within the mandate notice window');
      }
      mutation = { kind: 'gc_amount', id: evidence.subscription.id, amountMinor: quote.amountMinor };
    }
    const prepared = { version: 1, input: structuredClone(input), quote, mutation,
      before: monthlyAmendmentFingerprint(evidence), immutable: evidence.immutable,
      idempotencyKey: `member-amend-monthly:${monthlyAmendmentFingerprint({
        tenant: input.tenantId, amendment: input.amendmentId, plan: input.plan.id,
      })}` };
    return { ...prepared, fingerprint: monthlyAmendmentFingerprint(prepared) };
  }
  function checkPrepared(prepared) {
    const { fingerprint, ...body } = prepared || {};
    if (body.version !== 1 || monthlyAmendmentFingerprint(body) !== fingerprint) {
      block('prepared_changed', 'Persisted monthly operation fingerprint is invalid');
    }
  }
  async function reconcile(prepared) {
    checkPrepared(prepared);
    const { input, mutation } = prepared;
    if (mutation.kind === 'dynamic_revision_required') block('dynamic_revision_required', 'Core must implement an atomic effective-dated dynamic collection revision resolver before applying');
    try {
      const { client, evidence } = await inspect(input);
      let matches;
      if (mutation.kind === 'stripe_schedule') {
        const schedule = evidence.schedule;
        matches = schedule.id === mutation.id
          && schedule.metadata?.member_amendment_id === input.amendmentId
          && schedule.phases?.length === mutation.params.phases.length
          && schedule.end_behavior === mutation.params.end_behavior
          && schedule.phases.every((phase, i) => {
            const wanted = mutation.params.phases[i];
            return phase.start_date === wanted.start_date && phase.end_date === wanted.end_date
              && monthlyAmendmentFingerprint(stripeItems(phase.items)) === monthlyAmendmentFingerprint(wanted.items);
          });
      } else {
        matches = evidence.subscription.id === mutation.id && evidence.subscription.amount === mutation.amountMinor
          && evidence.subscription.upcoming_payments?.length === prepared.quote.collectionDates.length
          && evidence.subscription.upcoming_payments.every((p, i) =>
            p.charge_date === prepared.quote.collectionDates[i] && p.amount === mutation.amountMinor);
      }
      void client;
      const unchanged = monthlyAmendmentFingerprint(evidence.immutable) === monthlyAmendmentFingerprint(prepared.immutable);
      if (matches && unchanged) return { status: 'provider_applied', provider: input.authority.provider,
        providerId: mutation.id, fingerprint: prepared.fingerprint, evidence };
      return { status: monthlyAmendmentFingerprint(evidence) === prepared.before ? 'not_applied' : 'uncertain',
        providerId: mutation.id, fingerprint: prepared.fingerprint,
        reason: 'Provider state does not exactly confirm this operation', evidence };
    } catch (error) {
      return { status: 'uncertain', providerId: mutation.id, fingerprint: prepared.fingerprint,
        reason: 'Provider state could not be verified', code: error.code || 'provider_read_failed' };
    }
  }
  async function apply(prepared) {
    checkPrepared(prepared);
    if (prepared.mutation.kind === 'dynamic_revision_required') block('dynamic_revision_required', 'Dynamic DD requires the core revision/reservation bridge; no provider write was attempted');
    // Re-read immediately before writing. Core must also retain its per-plan hold.
    const current = await reconcile(prepared);
    if (current.status === 'provider_applied') return { ...current, replayed: true };
    if (current.status !== 'not_applied') block('provider_state_changed', 'Provider state changed; reconcile the existing operation without resubmission');
    const { input, mutation } = prepared;
    const client = await (input.authority.provider === 'stripe' ? getStripe : getGc)(input.tenantId, input.authority.environment);
    try {
      if (mutation.kind === 'stripe_schedule') {
        await client.subscriptionSchedules.update(mutation.id, mutation.params, { idempotencyKey: prepared.idempotencyKey });
      } else if (mutation.kind === 'gc_amount') {
        await client.updateSubscriptionAmount(mutation.id, {
          amountMinor: mutation.amountMinor, idempotencyKey: prepared.idempotencyKey,
        });
      } else block('unsupported_provider', 'Unknown monthly mutation');
      return await reconcile(prepared);
    } catch (error) {
      return { status: 'uncertain', providerId: mutation.id, fingerprint: prepared.fingerprint,
        code: error.code || 'provider_write_unconfirmed',
        reason: 'Provider write may have succeeded; retain collection hold and reconcile without a new key' };
    }
  }
  return { prepare, quote: async input => {
    const prepared = await prepare(input);
    return { ...prepared.quote, supported: prepared.mutation.kind !== 'dynamic_revision_required',
      blocker: prepared.mutation.kind === 'dynamic_revision_required' ? 'dynamic_revision_required' : null,
      provider: input.authority.provider, providerEvidenceFingerprint: prepared.before };
  }, apply, reconcile };
}
