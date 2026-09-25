import { selectCanvasCommitment, buildCanvasSummary } from '../membership/canvas-summary.js';
import { isDeletedRelationshipMember } from './customObjectMemberEligibility.js';
import { shapeLegacyCurrentMembership } from '../membership/member-membership.js';

export const isEligiblePaymentReportMember = (row, tenantId) =>
  row?.tenant_id === tenantId && !isDeletedRelationshipMember(row);

export const PAYMENT_REPORT_METHODS = [
  ['card', 'Card'], ['monthly_card', 'Monthly card'],
  ['direct_debit', 'Direct Debit'], ['monthly_direct_debit', 'Monthly Direct Debit'],
  ['invoice', 'Invoice'], ['bank_transfer', 'Bank transfer'], ['upfront', 'Upfront'], ['other', 'Unknown / other'],
].map(([value, label]) => ({ value, label }));

const stopped = new Set(['paused', 'cancelled', 'canceled', 'completed', 'expired', 'suspended', 'restricted']);
const live = new Set(['active', 'mandate_pending', 'first_payment_pending']);
const pendingPayments = new Set(['pending_customer_approval', 'pending_submission', 'submitted']);

function dateOnly(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? value : null;
}

// Reporting only: these dates do not authorise billing or create successor terms.
export function upfrontRenewalProjection({ record, member, tenantId, configs = [], preferences = [] }) {
  const currentExpiryDate = dateOnly(record.term_end_date);
  let renewalDate = dateOnly(record.membership_renewal_date);
  let renewalLabel = renewalDate ? 'Saved renewal date' : 'Renewal date missing';
  if (!renewalDate && currentExpiryDate) {
    const next = new Date(`${currentExpiryDate}T00:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    renewalDate = dateOnly(next.toISOString().slice(0, 10));
    if (renewalDate) renewalLabel = 'Expected renewal';
  }
  const normalize = value => typeof value === 'string' || typeof value === 'number'
    ? String(value).trim().toLowerCase() : '';
  const matches = renewalDate ? configs.filter(config => {
    if (config.tenant_id !== tenantId || config.is_active === false || config.structure_scope_type !== 'member') return false;
    if (config.effective_from && (!dateOnly(config.effective_from) || config.effective_from > renewalDate)) return false;
    if (config.effective_to && (!dateOnly(config.effective_to) || config.effective_to < renewalDate)) return false;
    if (!config.structure_field_id) return !config.structure_match_value;
    const field = config.structure_field_id;
    // tenant_id on preferences is trusted scope enrichment by the endpoint,
    // not a column on member_preference_value.
    const values = field.startsWith('core:') ? [member[field.slice(5)]] : preferences
      .filter(p => p.tenant_id === tenantId && p.member_id === member.id && p.field_id === field).map(p => p.value);
    return values.length === 1 && !!normalize(values[0])
      && normalize(values[0]) === normalize(config.structure_match_value);
  }) : [];
  // A matching scoped structure takes precedence over the member default.
  const scoped = matches.filter(config => config.structure_field_id);
  const eligible = scoped.length ? scoped : matches;
  const nextStructure = eligible.length === 1 ? eligible[0] : null;
  return {
    currentExpiryDate, renewalDate, renewalLabel,
    paymentArrangement: 'Upfront — no automatic collection scheduled',
    nextStructureId: nextStructure?.id || null,
    nextStructureName: nextStructure?.name || null,
    nextStructureState: !renewalDate ? 'Review required — renewal date missing'
      : eligible.length > 1 ? 'Review required — overlapping structures'
        : !nextStructure?.name ? 'Review required — no uniquely named applicable structure'
          : 'Expected structure — not a commitment',
  };
}

function owned(row, tenantId, memberId) {
  return row?.tenant_id === tenantId && row.member_id === memberId && !row.organization_id;
}

function validPlan(record, agreement, plan, tenantId) {
  if (!owned(agreement, tenantId, record.member_id) || !owned(plan, tenantId, record.member_id)
    || plan.billing_agreement_id !== agreement.id
    || !['stripe', 'gocardless'].includes(agreement.provider) || plan.provider !== agreement.provider
    || plan.environment !== agreement.environment) return false;
  return (agreement.provider === 'stripe' ? ['test', 'live'] : ['sandbox', 'live']).includes(agreement.environment);
}

function schedule({ selected, agreement, plan, payments, paused, method, today, providerSchedule }) {
  const unavailable = { nextPaymentDate: null, scheduleState: 'unavailable' };
  const none = { nextPaymentDate: null, scheduleState: 'not_scheduled' };
  if (paused || stopped.has(selected.record.status)
    || stopped.has(plan?.status) || stopped.has(agreement?.status) || plan?.collection_stopped_at) return none;
  if (['upfront', 'card', 'invoice', 'bank_transfer'].includes(method) && !selected.record.billing_agreement_id) return none;
  if (!plan || !live.has(plan.status) || !live.has(agreement.status)) return unavailable;
  const inTerm = value => {
    const date = dateOnly(value);
    return date && date >= today && (!selected.start || date >= selected.start)
      && (!selected.renewal || date < selected.renewal)
      && (!selected.commitment.endDate || date <= selected.commitment.endDate) ? date : null;
  };
  const providerDate = inTerm(providerSchedule?.nextConfirmedDate);
  if (providerDate) return { nextPaymentDate: providerDate, scheduleState: 'confirmed' };
  if (providerSchedule?.evidence === 'provider_subscription' && !providerSchedule.nextConfirmedDate) return none;
  // Never trust an old next_charge_date mirror. The endpoint's bounded,
  // tenant-scoped resolver can supply verified provider scheduling evidence;
  // absent that evidence Stripe timing stays explicitly unavailable.
  if (agreement.provider !== 'gocardless'
    || !['direct_debit', 'monthly_direct_debit'].includes(method)
    || !agreement.gocardless_mandate_id
    || (plan.gocardless_mandate_id && plan.gocardless_mandate_id !== agreement.gocardless_mandate_id)) return unavailable;
  const confirmed = payments.filter(payment =>
    payment.tenant_id === plan.tenant_id && payment.plan_id === plan.id
    && payment.environment === agreement.environment
    && payment.gocardless_mandate_id === agreement.gocardless_mandate_id
    && (!plan.gocardless_subscription_id || payment.gocardless_subscription_id === plan.gocardless_subscription_id)
    && pendingPayments.has(payment.status))
    .map(payment => inTerm(payment.charge_date)).filter(Boolean).sort()[0];
  if (confirmed) return { nextPaymentDate: confirmed, scheduleState: 'confirmed' };
  const policy = agreement.metadata?.dd?.collection_policy;
  const planned = inTerm(plan.dynamic_next_collection_date);
  if (!plan.gocardless_subscription_id && plan.metadata?.collection_mode === 'dynamic'
    && policy?.version === 1 && policy.pricing_policy === 'dynamic' && planned) {
    return { nextPaymentDate: planned, scheduleState: 'planned' };
  }
  return unavailable;
}

export function comparePaymentReportRows(a, b) {
  return (a.nextPaymentDate || '9999-99-99').localeCompare(b.nextPaymentDate || '9999-99-99')
    || a.name.localeCompare(b.name) || a.memberId.localeCompare(b.memberId);
}

/** Complete personal dataset first; choose one commitment before method filtering. */
export function projectMembershipPaymentReport({
  tenantId, members, history, agreements = [], plans = [], payments = [], today = new Date().toISOString().slice(0, 10),
  providerSchedules = new Map(), collectScheduleRequest, configs = [], preferences = [],
}) {
  const memberMap = new Map(members.filter(row => isEligiblePaymentReportMember(row, tenantId)).map(row => [row.id, row]));
  const agreementMap = new Map(agreements.filter(row => row.tenant_id === tenantId).map(row => [row.id, row]));
  const plansByAgreement = new Map();
  for (const plan of plans.filter(row => row.tenant_id === tenantId)
    .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')) || b.id.localeCompare(a.id))) {
    if (!plansByAgreement.has(plan.billing_agreement_id)) plansByAgreement.set(plan.billing_agreement_id, plan);
  }
  const paymentsByPlan = new Map();
  for (const payment of payments) {
    if (!paymentsByPlan.has(payment.plan_id)) paymentsByPlan.set(payment.plan_id, []);
    paymentsByPlan.get(payment.plan_id).push(payment);
  }
  const candidates = new Map();
  for (const record of history) {
    const member = memberMap.get(record.member_id);
    if (!member || record.tenant_id !== tenantId || record.organization_id
      || record.membership_source === 'organisation' || ['cancelled', 'canceled', 'expired'].includes(record.status)) continue;
    const selected = selectCanvasCommitment([{ ...record, membership_source: 'personal' }], [], today);
    if (!selected || !['current', 'scheduled'].includes(selected.lifecycle)) continue;
    const agreement = agreementMap.get(record.billing_agreement_id);
    const candidatePlan = plansByAgreement.get(agreement?.id);
    const plan = validPlan(record, agreement, candidatePlan, tenantId) ? candidatePlan : null;
    // Reuse the same method aliases and persisted commitment shaping as Canvas.
    const summary = buildCanvasSummary({ selected, plan, paused: member.membership_paused, today });
    const method = record.payment_method === 'upfront' && !record.billing_agreement_id
      ? 'upfront' : summary.payment.method === 'unavailable' ? 'other' : summary.payment.method;
    const upfront = !record.billing_agreement_id && !plan
      && (record.billing_period || selected.commitment?.billingPeriod) === 'annual'
      && ['upfront', 'card', 'invoice', 'bank_transfer'].includes(method);
    const row = {
      memberId: member.id,
      name: `${member.first_name || ''} ${member.last_name || ''}`.trim() || member.email || 'Unnamed member',
      email: member.email || null,
      tier: summary.membership.membershipType,
      status: member.membership_paused ? 'paused' : record.status || summary.membership.state,
      paymentMethod: method,
      ...schedule({ selected, agreement: plan ? agreement : null, plan,
        payments: paymentsByPlan.get(plan?.id) || [], paused: member.membership_paused, method, today,
        providerSchedule: providerSchedules.get(plan?.id) }),
      ...(upfront ? upfrontRenewalProjection({ record, member, tenantId, configs, preferences }) : {}),
    };
    if (row.scheduleState === 'unavailable' && plan && !member.membership_paused
      && !stopped.has(record.status) && !plan.collection_stopped_at
      && live.has(plan.status) && live.has(agreement.status)
      && ((agreement.provider === 'stripe' && method === 'monthly_card')
        || (agreement.provider === 'gocardless' && plan.gocardless_subscription_id
          && ['direct_debit', 'monthly_direct_debit'].includes(method)))) {
      collectScheduleRequest?.({ tenantId, agreement, plan, today, record, member });
    }
    if (!candidates.has(member.id)) candidates.set(member.id, []);
    candidates.get(member.id).push({ row, selected });
  }
  const rows = [...candidates.values()].map(items => items.sort((a, b) =>
    comparePaymentReportRows(a.row, b.row)
    || (a.selected.lifecycle === 'current' ? 0 : 1) - (b.selected.lifecycle === 'current' ? 0 : 1)
    || (a.selected.lifecycle === 'current'
      ? (b.selected.start || '').localeCompare(a.selected.start || '')
      : (a.selected.start || '').localeCompare(b.selected.start || ''))
    || String(a.selected.record.id).localeCompare(String(b.selected.record.id)))[0].row);
  // Legacy recognition is display evidence only, never a rolling commitment or
  // collection request. Existing current/scheduled candidates always win.
  const included = new Set(rows.map(row => row.memberId));
  for (const record of [...history].sort((a, b) => String(a.id).localeCompare(String(b.id)))) {
    const member = memberMap.get(record.member_id);
    if (!member || included.has(member.id) || record.organization_id
      || record.membership_source === 'organisation') continue;
    const legacy = shapeLegacyCurrentMembership(
      { ...record, membership_source: 'personal' }, tenantId, new Date(`${today}T00:00:00Z`));
    if (!legacy) continue;
    rows.push({
      memberId: member.id,
      name: `${member.first_name || ''} ${member.last_name || ''}`.trim() || member.email || 'Unnamed member',
      email: member.email || null,
      tier: legacy.tierLabel,
      status: member.membership_paused ? 'paused' : 'active',
      paymentMethod: 'upfront',
      nextPaymentDate: null,
      scheduleState: 'not_scheduled',
      ...upfrontRenewalProjection({ record, member, tenantId, configs, preferences }),
    });
    included.add(member.id);
  }
  return rows.sort(comparePaymentReportRows);
}