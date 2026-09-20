// Explicit variable-price consent only. Each provider request is durably
// reserved before submission; retries always replay the winning reservation.
import { supabase } from './database.js';
import { buildIdempotencyKey, gocardlessForTenant } from './gocardless.js';
import { matchBand } from './tierBandMatcher.js';
import { matchesSelections } from './selectionMatcher.js';

export const DYNAMIC_RESERVATIONS = 'gocardless_collection_reservations';
const LIVE_STATUSES = ['active', 'mandate_pending', 'first_payment_pending'];
const day = value => new Date(value).toISOString().slice(0, 10);
const equal = (a, b) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();
const checked = (result, context) => {
  if (result.error) throw new Error(`${context}: ${result.error.message}`);
  return result.data;
};

export function isDynamicAgreement(agreement) {
  const policy = agreement?.metadata?.dd?.collection_policy;
  return policy?.version === 1 && policy.pricing_policy === 'dynamic'
    && ['stop', 'continue'].includes(policy.end_policy);
}

export function dynamicCollectionDate(firstDate, number) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(firstDate || '') || !Number.isInteger(number) || number < 1) {
    throw new Error('A trusted first collection date and collection number are required');
  }
  const start = new Date(`${firstDate}T00:00:00Z`);
  const last = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + number, 0)).getUTCDate();
  return day(new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + number - 1, Math.min(start.getUTCDate(), last))));
}

export function assertDynamicPayment(reservation, payment, mandateId) {
  if (!payment?.id || payment.amount !== reservation.amount_minor
    || !equal(payment.currency, reservation.currency)
    || payment.links?.mandate !== mandateId || payment.links?.subscription
    || !payment.charge_date || payment.charge_date !== reservation.requested_charge_date) {
    throw new Error('Dynamic collection provider amount, currency, mandate or charge date does not match its reservation');
  }
  if (reservation.gocardless_payment_id && reservation.gocardless_payment_id !== payment.id) {
    throw new Error('Dynamic collection provider payment identity changed');
  }
}

export async function resolveDynamicCollectionPrice(agreement, intendedDate, { db = supabase } = {}) {
  const terms = agreement?.metadata?.dd;
  const commitment = terms?.commitment;
  const purchased = commitment?.commitment_snapshot?.config;
  if (!isDynamicAgreement(agreement) || terms.invoicing_mode !== 'per_instalment'
    || !purchased || !commitment.term_key) {
    throw new Error('Dynamic collection requires explicit consent, per-instalment invoicing and a trusted purchased scope');
  }
  const configs = checked(await db.from('membership_tier_config').select('*')
    .eq('tenant_id', agreement.tenant_id)
    .or(`effective_from.is.null,effective_from.lte.${intendedDate}`)
    .or(`effective_to.is.null,effective_to.gte.${intendedDate}`), 'Resolve collection structure');
  const matches = (configs || []).filter(config => config.is_active !== false
    && config.dd_enabled === true
    && equal(config.structure_scope_type || 'organization', purchased.structure_scope_type || 'organization')
    && equal(config.structure_field_id, purchased.structure_field_id)
    && equal(config.structure_match_value, purchased.structure_match_value)
    && equal(config.start_mode, purchased.start_mode));
  if (matches.length !== 1) throw new Error(`Dynamic collection on ${intendedDate} requires exactly one active structure in the purchased scope`);
  const config = matches[0];
  if (!equal(config.currency, terms.currency)) throw new Error('Dynamic collection cannot change the agreed currency');
  let band = null;
  if ((config.pricing_model || 'tiered') !== 'flat') {
    // Pin the purchased pricing basis, not today's mutable member profile.
    if (!equal(config.field_id, purchased.field_id) || !equal(config.field_source, purchased.field_source)
      || !equal(config.field_name, purchased.field_name)) throw new Error('Dynamic collection pricing basis changed; review required');
    const bands = checked(await db.from('membership_tier_band').select('*')
      .eq('tenant_id', agreement.tenant_id).eq('config_id', config.id), 'Resolve collection bands');
    const basis = commitment.commitment_snapshot?.pricing?.field_value ?? terms.field_value;
    const purchasedBand = commitment.commitment_snapshot?.pricing?.band;
    const eligible = (bands || []).filter(candidate => basis != null
      ? matchBand(basis, [candidate])
      : purchasedBand && ['min_value', 'max_value', 'match_value'].every(key => equal(candidate[key], purchasedBand[key])));
    if (eligible.length !== 1) throw new Error('Dynamic collection requires exactly one matching price band for its saved pricing basis');
    band = eligible[0];
  }
  const value = Number(band ? band.dd_monthly_amount : config.dd_monthly_amount);
  const minor = Math.round(value * 100);
  if (!Number.isFinite(value) || !Number.isSafeInteger(minor) || minor <= 0) throw new Error('Active structure has no positive monthly collection price');
  // Same selection semantics as vatOverrideHelper, but strict reads: an
  // unavailable tax rule/value must not silently turn a taxable charge into zero.
  const overrides = checked(await db.from('membership_tier_vat_override').select('*')
    .eq('tenant_id', agreement.tenant_id).eq('config_id', config.id)
    .order('sort_order', { ascending: true }), 'Resolve collection VAT overrides');
  const ownerType = agreement.member_id ? 'member' : 'organization';
  const ownerId = agreement.member_id || agreement.organization_id;
  let taxRule = null;
  const taxValues = {};
  if (overrides?.length) {
    const owner = checked(await db.from(ownerType).select('*')
      .eq('tenant_id', agreement.tenant_id).eq('id', ownerId).single(), 'Resolve collection tax owner');
    const fieldIds = [...new Set(overrides.map(rule => rule.field_id).filter(Boolean))];
    for (const field of fieldIds.filter(id => id.startsWith('core:'))) taxValues[field] = owner[field.slice(5)];
    const custom = fieldIds.filter(id => !id.startsWith('core:'));
    if (custom.length) {
      const values = checked(await db.from(`${ownerType}_preference_value`).select('field_id,value')
        .eq(`${ownerType}_id`, ownerId).in('field_id', custom), 'Resolve collection tax field values');
      for (const value of values || []) taxValues[value.field_id] = value.value;
    }
    taxRule = overrides.find(rule => matchesSelections(taxValues[rule.field_id], rule.match_value, rule.match_condition)) || null;
  }
  return {
    config_id: config.id, band_id: band?.id || null,
    tier_label: band?.label || 'Flat Rate', membership_year: terms.membership_year,
    currency: terms.currency, monthly_amount_minor: minor,
    vat_rate: taxRule ? taxRule.vat_rate || null : band ? band.vat_rate ?? null : config.flat_vat_rate ?? null,
    tax_rule: taxRule, tax_basis: taxValues,
    nominal_code: band?.nominal_code || config.nominal_code || null,
    config: structuredClone(config), band: band ? structuredClone(band) : null,
    scope: { structure_scope_type: purchased.structure_scope_type, structure_field_id: purchased.structure_field_id, structure_match_value: purchased.structure_match_value },
    intended_date: intendedDate,
  };
}

function assertCollectible(agreement, plan) {
  if (!isDynamicAgreement(agreement) || !LIVE_STATUSES.includes(agreement.status)
    || !LIVE_STATUSES.includes(plan.status) || plan.collection_stopped_at
    || agreement.metadata?.dd?.arrears_state || plan.metadata?.catch_up_intent
    || plan.gocardless_subscription_id) throw new Error('Dynamic collection is blocked by agreement or plan lifecycle');
}

export async function ensureDynamicPlanForAgreement(agreement, deps = {}) {
  const db = deps.db || supabase;
  const gc = typeof deps.gc?.gocardlessForTenant === 'function'
    ? await deps.gc.gocardlessForTenant(agreement.tenant_id, { db })
    : deps.gc || await gocardlessForTenant(agreement.tenant_id, { db });
  if (!isDynamicAgreement(agreement)) throw new Error('Explicit dynamic collection consent is required');
  const terms = agreement.metadata.dd;
  const term = terms.commitment;
  if (!term?.term_key || !term.term_start_date || !term.term_end_date
    || terms.invoicing_mode !== 'per_instalment') throw new Error('Dynamic collection term or invoicing consent is incomplete');
  const idempotencyKey = buildIdempotencyKey('dd-dynamic-plan', agreement.tenant_id, agreement.id, term.term_key);
  let plan = checked(await db.from('membership_payment_plans').select('*')
    .eq('tenant_id', agreement.tenant_id).eq('idempotency_key', idempotencyKey).maybeSingle(), 'Load dynamic plan');
  let created = false;
  if (!plan) {
    const mandate = await gc.getMandate(agreement.gocardless_mandate_id);
    if (mandate?.status !== 'active' || !mandate.next_possible_charge_date) throw new Error('Dynamic collection mandate is not active or has no provider earliest charge date');
    const today = day(typeof deps.now === 'function' ? deps.now() : new Date());
    let first = [today, term.term_start_date, mandate.next_possible_charge_date].sort().at(-1);
    if (terms.first_collection_rule !== 'earliest') {
      const nominated = terms.first_collection_rule === 'anniversary'
        ? Number(term.term_start_date.slice(8, 10)) : Number(terms.collection_day);
      const wanted = Math.max(1, Math.min(28, nominated || 1));
      const candidate = `${first.slice(0, 8)}${String(wanted).padStart(2, '0')}`;
      first = candidate < first ? dynamicCollectionDate(candidate, 2) : candidate;
    }
    if (first > term.term_end_date) throw new Error('Provider notice window leaves no collection within the purchased term');
    const row = {
      tenant_id: agreement.tenant_id, billing_agreement_id: agreement.id,
      member_id: agreement.member_id || null, organization_id: agreement.organization_id || null,
      provider: 'gocardless', gocardless_mandate_id: agreement.gocardless_mandate_id,
      amount_minor: terms.monthly_amount_minor, currency: terms.currency, interval_unit: 'monthly',
      day_of_month: Number(first.slice(8)), status: 'mandate_pending',
      membership_year: terms.membership_year, start_date: first,
      instalments_total: terms.instalment_count, idempotency_key: idempotencyKey,
      environment: agreement.environment || 'sandbox',
      dynamic_next_collection_date: first,
      metadata: { collection_mode: 'dynamic', dynamic_first_date: first, agreement_id: agreement.id },
    };
    const inserted = await db.from('membership_payment_plans').insert(row).select().single();
    if (inserted.error?.code === '23505') {
      plan = checked(await db.from('membership_payment_plans').select('*')
        .eq('tenant_id', agreement.tenant_id).eq('idempotency_key', idempotencyKey).single(), 'Reload dynamic plan');
    } else {
      plan = checked(inserted, 'Create dynamic plan'); created = true;
    }
  }
  const result = await collectDynamicPlan(plan, { ...deps, db, gc });
  return { created, plan: result.plan || plan, detail: result.detail };
}

export async function collectDynamicPlan(plan, { db = supabase, gc, now = () => new Date() } = {}) {
  // A cron batch may have loaded this plan before an administrator amended its
  // operational cadence. SQL reservation still checks the locked latest plan.
  plan = checked(await db.from('membership_payment_plans').select('*')
    .eq('tenant_id', plan.tenant_id).eq('id', plan.id).single(), 'Reload dynamic schedule');
  const agreement = checked(await db.from('membership_billing_agreements').select('*')
    .eq('tenant_id', plan.tenant_id).eq('id', plan.billing_agreement_id).single(), 'Load dynamic agreement');
  assertCollectible(agreement, plan);
  // BNMS pilot processing-not-before: midnight Europe/London (BST), NOT
  // an instruction to debit on October 1. Identity, not mutable metadata,
  // determines this safety gate, including retries of existing reservations.
  const bnmsPilot = agreement.tenant_id === 'ff2df806-b321-4254-b651-3af11fccf1db'
    && agreement.member_id === '33e5d54d-162e-436d-9bff-ec6676d198f9';
  const bnmsBeta = agreement.tenant_id === 'ff2df806-b321-4254-b651-3af11fccf1db'
    && plan.metadata?.bnms_beta_held === true;
  if (bnmsBeta) {
    // BNMS beta processing-not-before. A mutable plan flag is not release
    // authority: require the append-only, tenant/owner/plan-bound release.
    const release = checked(await db.from('bnms_dd_beta_release').select('*')
      .eq('tenant_id', agreement.tenant_id).eq('member_id', agreement.member_id)
      .eq('plan_id', plan.id).maybeSingle(), 'Load reviewed beta release');
    if (!release || Date.parse(release.processing_not_before) !== Date.parse('2026-09-30T23:00:00Z')) {
      throw new Error('BNMS beta reviewed release and processing gate are required');
    }
  }
  const bnmsProcessing = bnmsPilot || bnmsBeta;
  if (bnmsProcessing) {
    const timestamp = now().getTime();
    if (!Number.isFinite(timestamp)) throw new Error('BNMS pilot processing clock is invalid');
    if (timestamp < Date.parse('2026-09-30T23:00:00Z')) {
      return { plan, detail: 'BNMS processing starts 1 October 2026 Europe/London' };
    }
  }
  const arrears = checked(await db.from('membership_monthly_arrears_period').select('id')
    .eq('tenant_id', plan.tenant_id).eq('plan_id', plan.id).is('settled_at', null).limit(1), 'Check dynamic collection arrears');
  if (arrears?.length) throw new Error('Dynamic collection is blocked while arrears remain outstanding');
  const terms = agreement.metadata.dd;
  const term = terms.commitment;
  const reservations = checked(await db.from(DYNAMIC_RESERVATIONS).select('*')
    .eq('tenant_id', plan.tenant_id).eq('plan_id', plan.id).order('collection_number', { ascending: false }).limit(1), 'Load dynamic reservation');
  const last = reservations?.[0];
  let reservation = last?.status === 'reserved' ? last : null;
  if (last?.status === 'blocked') throw new Error(last.blocked_reason || 'Dynamic collection reservation is blocked');
  const number = reservation?.collection_number || (last?.collection_number || 0) + 1;
  const intendedDate = reservation?.due_date || dynamicCollectionDate(plan.metadata.dynamic_first_date, number);
  if (number > terms.instalment_count || intendedDate > term.term_end_date) {
    checked(await db.from('membership_payment_plans').update({ dynamic_next_collection_date: null })
      .eq('tenant_id', plan.tenant_id).eq('id', plan.id)
      .eq('dynamic_next_collection_date', plan.dynamic_next_collection_date), 'Complete dynamic schedule');
    return { plan, detail: 'All collections for this term are reserved; renewal is separate' };
  }
  const client = gc || await gocardlessForTenant(plan.tenant_id);
  const mandate = await client.getMandate(agreement.gocardless_mandate_id);
  if (mandate?.status !== 'active' || !mandate.next_possible_charge_date) throw new Error('Dynamic mandate is not active or has no earliest provider charge date');
  const today = bnmsProcessing
    ? new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now())
    : day(now());
  if (bnmsProcessing && mandate.next_possible_charge_date < today) {
    throw new Error('BNMS pilot provider charge date is in the past; refresh provider evidence');
  }
  if (!reservation) {
    // Only request the provider's authoritative working date. Sending an
    // unverified weekend/holiday date lets GC roll it forward AFTER the effect.
    // Keep the intended monthly cadence separately and never cross term end.
    if (mandate.next_possible_charge_date < intendedDate) return { plan, detail: 'Waiting for provider submission window' };
    if (bnmsPilot
      && number === 1 && term.term_start_date === '2026-10-01'
      && intendedDate !== '2026-10-01') {
      throw new Error('BNMS pilot intended October 1 cadence drifted; review required');
    }
    const latest = day(new Date(Date.parse(`${intendedDate}T00:00:00Z`) + 7 * 86_400_000));
    if (mandate.next_possible_charge_date > term.term_end_date
      || mandate.next_possible_charge_date > latest) throw new Error(`Provider notice deadline leaves no safe charge date for ${intendedDate}; review required`);
    const price = await resolveDynamicCollectionPrice(agreement, intendedDate, { db });
    reservation = checked(await db.rpc('reserve_gocardless_dynamic_collection', {
      p_tenant_id: plan.tenant_id, p_plan_id: plan.id, p_collection_number: number,
      p_due_date: intendedDate, p_price_snapshot: price,
      p_provider_evidence: { checked_at: now().toISOString(), status: mandate.status, next_possible_charge_date: mandate.next_possible_charge_date, notice_checked_on: today },
      p_idempotency_key: buildIdempotencyKey('dd-dynamic-payment', plan.tenant_id, plan.id, term.term_key, number),
    }), 'Reserve dynamic collection');
  }
  if (bnmsProcessing && reservation.requested_charge_date < today) {
    throw new Error('BNMS pilot reserved charge date is in the past; reconcile before retry');
  }
  // Revalidate serialized owner pause, arrears, cancellation and consent after
  // any pricing/provider reads, including on a crash/retry of a reservation.
  reservation = checked(await db.rpc('reserve_gocardless_dynamic_collection', {
    p_tenant_id: plan.tenant_id, p_plan_id: plan.id, p_collection_number: reservation.collection_number,
    p_due_date: reservation.due_date, p_price_snapshot: reservation.price_snapshot,
    p_provider_evidence: reservation.provider_evidence, p_idempotency_key: reservation.idempotency_key,
  }), 'Authorize reserved dynamic collection');
  const payment = await client.createPayment({
    mandateId: agreement.gocardless_mandate_id, amountMinor: reservation.amount_minor,
    currency: reservation.currency, chargeDate: reservation.requested_charge_date,
    description: `Membership ${terms.membership_year} monthly collection`,
    metadata: { tenant_id: plan.tenant_id, plan_id: plan.id, collection_reservation_id: reservation.id },
    idempotencyKey: reservation.idempotency_key,
  });
  assertDynamicPayment(reservation, payment, agreement.gocardless_mandate_id);
  await attachDynamicPayment(reservation, payment, { db });
  return { plan: { ...plan, amount_minor: reservation.amount_minor, next_charge_date: payment.charge_date }, detail: 'Dynamic collection scheduled with provider' };
}

export async function attachDynamicPayment(reservation, payment, { db = supabase } = {}) {
  return checked(await db.rpc('attach_gocardless_dynamic_payment', {
    p_tenant_id: reservation.tenant_id, p_reservation_id: reservation.id,
    p_payment: payment,
  }), 'Attach dynamic collection provider evidence');
}

// Handles a webhook arriving after provider success but before local attach.
// Metadata alone is never authority: the immutable reservation is checked.
export async function resolveDynamicPayment(paymentId, { db = supabase, gc } = {}) {
  const lookup = await db.from(DYNAMIC_RESERVATIONS).select('*')
    .eq('gocardless_payment_id', paymentId).maybeSingle();
  if (['42P01', 'PGRST205'].includes(lookup.error?.code)) return null;
  let reservation = checked(lookup, 'Find dynamic payment reservation');
  let payment = null;
  if (!reservation && typeof gc?.getPayment === 'function' && !gc.gocardlessForTenant) {
    payment = await gc.getPayment(paymentId);
    const metadata = payment?.metadata;
    if (!metadata?.collection_reservation_id) return null;
    reservation = checked(await db.from(DYNAMIC_RESERVATIONS).select('*')
      .eq('id', metadata.collection_reservation_id).eq('tenant_id', metadata.tenant_id)
      .eq('plan_id', metadata.plan_id).maybeSingle(), 'Recover dynamic reservation');
    if (!reservation) throw new Error('Provider dynamic collection has no matching reservation');
  }
  if (!reservation) return null;
  const plan = checked(await db.from('membership_payment_plans').select('*')
    .eq('id', reservation.plan_id).eq('tenant_id', reservation.tenant_id).single(), 'Resolve dynamic payment plan');
  const client = typeof gc?.gocardlessForTenant === 'function'
    ? await gc.gocardlessForTenant(reservation.tenant_id, { db })
    : gc || await gocardlessForTenant(reservation.tenant_id, { db });
  payment ||= await client.getPayment(paymentId);
  assertDynamicPayment(reservation, payment, plan.gocardless_mandate_id);
  await attachDynamicPayment(reservation, payment, { db });
  return { plan, reservation, payment };
}

export async function reconcileDynamicCollections({ db = supabase, clientForTenant = gocardlessForTenant, now = () => new Date(), limit = 100, budgetMs = 45000, clock = Date.now } = {}) {
  if (budgetMs <= 0) return { processed: 0, blocked: 0 };
  const started = clock();
  const horizon = day(new Date(now().getTime() + 35 * 86_400_000));
  const plans = checked(await db.from('membership_payment_plans').select('*')
    .eq('provider', 'gocardless').eq('metadata->>collection_mode', 'dynamic')
    .in('status', LIVE_STATUSES).lte('dynamic_next_collection_date', horizon)
    .or(`dynamic_next_check_at.is.null,dynamic_next_check_at.lte.${now().toISOString()}`)
    .order('dynamic_next_check_at', { ascending: true, nullsFirst: true })
    .order('dynamic_next_collection_date', { ascending: true }).limit(Math.min(limit, 100)), 'Load due dynamic plans');
  const result = { processed: 0, blocked: 0 };
  for (const plan of plans || []) {
    // Two provider calls can each take their configured 15s timeout. Do not
    // begin a second item without sufficient headroom to persist its outcome.
    const elapsed = clock() - started;
    if (elapsed >= budgetMs || ((result.processed + result.blocked) > 0 && budgetMs - elapsed < 30000)) break;
    const nextCheck = new Date(now().getTime() + 60 * 60 * 1000).toISOString();
    try {
      await collectDynamicPlan(plan, { db, gc: await clientForTenant(plan.tenant_id), now });
      checked(await db.from('membership_payment_plans').update({ dynamic_collection_error: null, dynamic_next_check_at: nextCheck })
        .eq('id', plan.id).eq('tenant_id', plan.tenant_id), 'Clear dynamic collection error');
      result.processed++;
    } catch (error) {
      checked(await db.from('membership_payment_plans').update({ dynamic_collection_error: String(error.message).slice(0, 1000), dynamic_next_check_at: nextCheck })
        .eq('id', plan.id).eq('tenant_id', plan.tenant_id), 'Record dynamic collection error');
      result.blocked++;
    }
  }
  return result;
}