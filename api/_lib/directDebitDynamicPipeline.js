// Shared dynamic collection orchestration. Only injected reads and explicit
// effects are available here; the recording interpreter stops at each effect.
import { createHash } from 'node:crypto';
import { matchBand } from './tierBandMatcher.js';
import { matchesSelections } from './selectionMatcher.js';
import { findAlphaAdoption, BNMS_ALPHA_PROCESSING_NOT_BEFORE } from './bnmsAlphaAccounting.js';
import { resolveManualAccountingContext } from './bnmsManualCohort.js';

export const DYNAMIC_RESERVATIONS = 'gocardless_collection_reservations';
const LIVE_STATUSES = ['active', 'mandate_pending', 'first_payment_pending'];
const day = value => new Date(value).toISOString().slice(0, 10);
const equal = (a, b) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();
const checked = (result, context) => {
  if (result.error) throw new Error(`${context}: ${result.error.message}`);
  return result.data;
};
const key = (...parts) => createHash('sha256').update(parts.join('|')).digest('hex');

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

export async function resolveDynamicCollectionPrice(agreement, intendedDate, { db } = {}) {
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
    if (!equal(config.field_id, purchased.field_id) || !equal(config.field_source, purchased.field_source)
      || !equal(config.field_name, purchased.field_name)) throw new Error('Dynamic collection pricing basis changed; review required');
    const bands = checked(await db.from('membership_tier_band').select('*')
      .eq('tenant_id', agreement.tenant_id).eq('config_id', config.id), 'Resolve collection bands');
    const basis = commitment.commitment_snapshot?.pricing?.field_value ?? terms.field_value;
    const purchasedBand = commitment.commitment_snapshot?.pricing?.band;
    const eligible = (bands || []).filter(candidate => basis != null
      ? matchBand(basis, [candidate])
      : purchasedBand && ['min_value', 'max_value', 'match_value'].every(name => equal(candidate[name], purchasedBand[name])));
    if (eligible.length !== 1) throw new Error('Dynamic collection requires exactly one matching price band for its saved pricing basis');
    band = eligible[0];
  }
  const value = Number(band ? band.dd_monthly_amount : config.dd_monthly_amount);
  const minor = Math.round(value * 100);
  if (!Number.isFinite(value) || !Number.isSafeInteger(minor) || minor <= 0) throw new Error('Active structure has no positive monthly collection price');
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

export function selectDynamicCollections(db, now, limit = 100) {
  const horizon = day(new Date(now.getTime() + 35 * 86_400_000));
  return db.from('membership_payment_plans').select('*')
    .eq('provider', 'gocardless').eq('metadata->>collection_mode', 'dynamic')
    .in('status', LIVE_STATUSES).lte('dynamic_next_collection_date', horizon)
    .or(`dynamic_next_check_at.is.null,dynamic_next_check_at.lte.${now.toISOString()}`)
    .order('dynamic_next_check_at', { ascending: true, nullsFirst: true })
    .order('dynamic_next_collection_date', { ascending: true }).limit(Math.min(limit, 100));
}

export async function runDynamicCollection({ db, plan, now = new Date(), getGc, effects, trace = () => {} }) {
  const selected = checked(await selectDynamicCollections(db, now).eq('tenant_id', plan.tenant_id).eq('id', plan.id),
    'Select scoped dynamic plan');
  if (!selected?.length) {
    trace({ stage: 'dynamic-collection', status: 'skipped', reason: 'Plan is not due in the dynamic collection batch (provider, mode, lifecycle, horizon or next-check gate).' });
    return { plan, detail: 'Not due for dynamic collection batch' };
  }
  return processDynamicCollection({ db, plan, now, getGc, effects, trace });
}

// Also used outside the cron when a just-created dynamic plan first collects.
// That entry intentionally does not apply the cron's polling/backoff envelope.
export async function processDynamicCollection({ db, plan, now, getGc, effects, trace = () => {} }) {
  const skip = reason => {
    trace({ stage: 'dynamic-collection', status: 'skipped', reason });
    return { plan, detail: reason };
  };
  plan = checked(await db.from('membership_payment_plans').select('*')
    .eq('tenant_id', plan.tenant_id).eq('id', plan.id).single(), 'Reload dynamic schedule');
  const agreement = checked(await db.from('membership_billing_agreements').select('*')
    .eq('tenant_id', plan.tenant_id).eq('id', plan.billing_agreement_id).single(), 'Load dynamic agreement');
  if (!isDynamicAgreement(agreement) || !LIVE_STATUSES.includes(agreement.status)
    || !LIVE_STATUSES.includes(plan.status) || plan.collection_stopped_at
    || agreement.metadata?.dd?.arrears_state || plan.metadata?.catch_up_intent
    || plan.gocardless_subscription_id) throw new Error('Dynamic collection is blocked by agreement or plan lifecycle');
  const bnmsPilot = agreement.tenant_id === 'ff2df806-b321-4254-b651-3af11fccf1db'
    && agreement.member_id === '33e5d54d-162e-436d-9bff-ec6676d198f9';
  const bnmsBeta = agreement.tenant_id === 'ff2df806-b321-4254-b651-3af11fccf1db'
    && plan.metadata?.bnms_beta_held === true;
  if (bnmsBeta) {
    const release = checked(await db.from('bnms_dd_beta_release').select('*')
      .eq('tenant_id', agreement.tenant_id).eq('member_id', agreement.member_id)
      .eq('plan_id', plan.id).maybeSingle(), 'Load reviewed beta release');
    if (!release || Date.parse(release.processing_not_before) !== Date.parse('2026-09-30T23:00:00Z')) {
      throw new Error('BNMS beta reviewed release and processing gate are required');
    }
  }
  const alphaAdoption = bnmsPilot || bnmsBeta ? null : await findAlphaAdoption(agreement, db);
  if (alphaAdoption) {
    const release = checked(await db.from('bnms_dd_alpha_release').select('*')
      .eq('adoption_id', alphaAdoption.id).eq('tenant_id', agreement.tenant_id)
      .eq('member_id', agreement.member_id).eq('plan_id', plan.id).maybeSingle(), 'Load reviewed alpha release');
    if (alphaAdoption.plan_id !== plan.id || !release
      || Date.parse(release.processing_not_before) !== Date.parse(BNMS_ALPHA_PROCESSING_NOT_BEFORE)
      || release.evidence?.agreementId !== agreement.id || release.evidence?.adoptionId !== alphaAdoption.id
      || release.evidence?.memberId !== agreement.member_id || release.evidence?.planId !== plan.id) {
      throw new Error('BNMS alpha reviewed release and processing gate are required');
    }
  } else if (plan.metadata?.bnms_alpha_held === true) throw new Error('BNMS alpha plan requires immutable adoption');
  const manualContext = bnmsPilot || bnmsBeta || alphaAdoption ? null : await resolveManualAccountingContext(agreement, db);
  if (manualContext && manualContext.planId !== plan.id) throw new Error('Manual cohort plan ownership mismatch');
  const bnmsProcessing = bnmsPilot || bnmsBeta || Boolean(alphaAdoption) || Boolean(manualContext);
  if (bnmsProcessing) {
    if (!Number.isFinite(now.getTime())) throw new Error('BNMS pilot processing clock is invalid');
    if (now.getTime() < Date.parse('2026-09-30T23:00:00Z')) return skip('BNMS processing starts 1 October 2026 Europe/London');
  }
  const arrears = checked(await db.from('membership_monthly_arrears_period').select('id')
    .eq('tenant_id', plan.tenant_id).eq('plan_id', plan.id).is('settled_at', null).limit(1), 'Check dynamic collection arrears');
  if (arrears?.length) throw new Error('Dynamic collection is blocked while arrears remain outstanding');
  const terms = agreement.metadata.dd;
  const term = terms.commitment;
  const reservations = checked(await db.from(DYNAMIC_RESERVATIONS).select('*')
    .eq('tenant_id', plan.tenant_id).eq('plan_id', plan.id).order('collection_number', { ascending: false }).limit(1), 'Load dynamic reservation');
  const last = reservations?.[0];
  const reservation = last?.status === 'reserved' ? last : null;
  if (last?.status === 'blocked') throw new Error(last.blocked_reason || 'Dynamic collection reservation is blocked');
  const number = reservation?.collection_number || (last?.collection_number || 0) + 1;
  const intendedDate = reservation?.due_date || dynamicCollectionDate(plan.metadata.dynamic_first_date, number);
  if (number > terms.instalment_count || intendedDate > term.term_end_date) {
    await effects.perform({ type: 'dynamic.finish_schedule', description: 'Clear the exhausted dynamic collection schedule; renewal remains separate.',
      payload: { planId: plan.id, tenantId: plan.tenant_id, expectedDate: plan.dynamic_next_collection_date } });
    return { plan, detail: 'All collections for this term are reserved; renewal is separate' };
  }
  const client = await getGc(plan.tenant_id);
  const mandate = await client.getMandate(agreement.gocardless_mandate_id);
  if (mandate?.status !== 'active' || !mandate.next_possible_charge_date) throw new Error('Dynamic mandate is not active or has no earliest provider charge date');
  const today = bnmsProcessing
    ? new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
    : day(now);
  if (bnmsProcessing && mandate.next_possible_charge_date < today) throw new Error('BNMS pilot provider charge date is in the past; refresh provider evidence');
  let params;
  if (!reservation) {
    if (mandate.next_possible_charge_date < intendedDate) return skip('Waiting for provider submission window');
    if (bnmsPilot && number === 1 && term.term_start_date === '2026-10-01' && intendedDate !== '2026-10-01') {
      throw new Error('BNMS pilot intended October 1 cadence drifted; review required');
    }
    const latest = day(new Date(Date.parse(`${intendedDate}T00:00:00Z`) + 7 * 86_400_000));
    if (mandate.next_possible_charge_date > term.term_end_date || mandate.next_possible_charge_date > latest) {
      throw new Error(`Provider notice deadline leaves no safe charge date for ${intendedDate}; review required`);
    }
    const price = await resolveDynamicCollectionPrice(agreement, intendedDate, { db });
    params = {
      p_tenant_id: plan.tenant_id, p_plan_id: plan.id, p_collection_number: number,
      p_due_date: intendedDate, p_price_snapshot: price,
      p_provider_evidence: { checked_at: now.toISOString(), status: mandate.status, next_possible_charge_date: mandate.next_possible_charge_date, notice_checked_on: today },
      p_idempotency_key: key('dd-dynamic-payment', plan.tenant_id, plan.id, term.term_key, number),
    };
  } else {
    if (bnmsProcessing && reservation.requested_charge_date < today) throw new Error('BNMS pilot reserved charge date is in the past; reconcile before retry');
    params = {
      p_tenant_id: plan.tenant_id, p_plan_id: plan.id, p_collection_number: reservation.collection_number,
      p_due_date: reservation.due_date, p_price_snapshot: reservation.price_snapshot,
      p_provider_evidence: reservation.provider_evidence, p_idempotency_key: reservation.idempotency_key,
    };
  }
  return effects.perform({
    type: 'dynamic.reserve_collection',
    description: `${reservation ? 'Reauthorize the existing' : 'Reserve a new'} dynamic collection. Collection submission and payment attachment depend on the winning reservation and its locked owner-pause, arrears, cancellation and consent checks.`,
    amountMinor: reservation?.amount_minor ?? params.p_price_snapshot.monthly_amount_minor,
    currency: reservation?.currency ?? params.p_price_snapshot.currency,
    date: reservation?.requested_charge_date ?? mandate.next_possible_charge_date,
    conditional: true,
    payload: { params, existing: Boolean(reservation), plan, agreement, today, bnmsProcessing },
  });
}

export function selectDynamicCompletions(db, now, limit = 20) {
  return db.from('membership_payment_plans').select('*')
    .eq('provider', 'gocardless').eq('metadata->>collection_mode', 'dynamic')
    .is('completed_at', null).neq('status', 'payment_plan_cancelled')
    .or(`dynamic_completion_next_check_at.is.null,dynamic_completion_next_check_at.lte.${now.toISOString()}`)
    .order('dynamic_completion_next_check_at', { ascending: true, nullsFirst: true }).limit(Math.min(limit, 100));
}

export async function processDynamicCompletion({ plan, effects }) {
  if (plan?.metadata?.collection_mode !== 'dynamic') return { completed: false };
  return effects.perform({
    type: 'dynamic.complete_term',
    description: 'Ask the atomic completion transaction to check all reserved payments and settle the term if eligible. Membership settlement and the completion email outbox depend on its result; no completion is assumed.',
    conditional: true,
    payload: { p_tenant_id: plan.tenant_id, p_plan_id: plan.id },
  });
}

export async function runDynamicCompletion({ db, plan, now = new Date(), effects, trace = () => {} }) {
  const selected = checked(await selectDynamicCompletions(db, now).eq('tenant_id', plan.tenant_id).eq('id', plan.id), 'Select scoped dynamic completion');
  if (!selected?.length) {
    trace({ stage: 'dynamic-completion', status: 'skipped', reason: 'Plan is not in the dynamic completion batch (provider, mode, completion, cancellation or next-check gate).' });
    return { completed: false };
  }
  return processDynamicCompletion({ plan, effects });
}

export function selectDynamicNotifications(db, now, limit = 20) {
  return db.from('gocardless_dynamic_term_completions').select('*')
    .eq('notification_status', 'pending').lte('notification_next_check_at', now.toISOString())
    .order('notification_next_check_at', { ascending: true }).limit(Math.min(limit, 100));
}

export async function processDynamicNotification({ completion, effects }) {
  if (completion.notification_status === 'sent') return { sent: true, duplicate: true };
  if (completion.notification_status === 'review') return { sent: false, review: true };
  return effects.perform({
    type: 'dynamic.completion_notice',
    description: completion.notification_messages
      ? 'Claim each retained completion-email recipient before delivery. Existing delivery leases and uncertain acceptance must be resolved before sending.'
      : 'Prepare and reserve the completion-email recipient manifest before any delivery. Recipients, claims and transport acceptance remain conditional.',
    conditional: true, payload: { completion },
  });
}

export async function runDynamicNotification({ db, plan, now = new Date(), effects, trace = () => {} }) {
  const selected = checked(await selectDynamicNotifications(db, now).eq('tenant_id', plan.tenant_id).eq('plan_id', plan.id), 'Select scoped completion notification');
  if (!selected?.length) {
    trace({ stage: 'dynamic-completion-notification', status: 'skipped', reason: 'No due pending completion notification exists for this plan.' });
    return { sent: false };
  }
  return processDynamicNotification({ completion: selected[0], effects });
}