import { calculateMembershipYearWindow } from './membershipYear.js';

const DAY = 86_400_000;
const MONTHLY_PERIODS = new Set(['monthly', 'monthly_card', 'monthly_direct_debit']);
const ACTIVE_AGREEMENT_STATUSES = new Set([
  'payment_setup_required', 'mandate_pending', 'first_payment_pending',
  'active', 'payment_grace_period', 'payment_overdue',
]);

export function dateOnly(value) {
  if (!value) return null;
  const date = value instanceof Date
    ? new Date(value)
    : new Date(String(value).includes('T') ? value : `${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return null;
  date.setUTCHours(0, 0, 0, 0);
  return date;
}

export function toDateString(value) {
  const date = dateOnly(value);
  return date ? date.toISOString().slice(0, 10) : null;
}

export function addDays(value, days) {
  const date = dateOnly(value);
  if (!date) return null;
  date.setUTCDate(date.getUTCDate() + days);
  return date;
}

function boundedInteger(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 366 ? parsed : fallback;
}

export function normalizeAnnualRenewalConfig(config = {}) {
  return {
    windowDays: boundedInteger(config.renewal_open_days, 0),
    graceDays: boundedInteger(config.renewal_grace_days, 0),
    disableLogin: config.renewal_disable_login === true,
    changeRole: config.renewal_change_role === true,
    fallbackRoleId: config.renewal_change_role === true
      && typeof config.renewal_fallback_role_id === 'string'
      && config.renewal_fallback_role_id.trim()
      ? config.renewal_fallback_role_id.trim()
      : null,
  };
}

export function isAnnualNonRecurring(record = {}) {
  const period = String(record.billing_period || 'annual').toLowerCase();
  return period === 'annual' && !MONTHLY_PERIODS.has(period);
}

function fullYearEnd(start) {
  const end = dateOnly(start);
  end.setUTCFullYear(end.getUTCFullYear() + 1);
  end.setUTCDate(end.getUTCDate() - 1);
  return end;
}

function windowFromLabel(label, config) {
  const match = String(label || '').match(/^(\d{4})(?:\s*[/-]\s*(\d{2,4}))?$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = (config?.membership_start_month || 1) - 1;
  const day = config?.membership_start_day || 1;
  const start = new Date(Date.UTC(year, month, day));
  return { start, end: fullYearEnd(start) };
}

export function deriveAnnualTerm(history = {}, config = {}, now = new Date()) {
  const persistedStart = dateOnly(history.term_start_date);
  const persistedEnd = dateOnly(history.term_end_date);
  if (persistedStart || persistedEnd) {
    const start = persistedStart || addDays(persistedEnd, -364);
    const end = persistedEnd || fullYearEnd(start);
    return { start, end, nextStart: addDays(end, 1) };
  }
  const labelled = windowFromLabel(history.membership_year, config);
  const window = labelled || calculateMembershipYearWindow(config, now);
  return {
    start: dateOnly(window.start),
    end: dateOnly(window.end),
    nextStart: addDays(window.end, 1),
  };
}

export function classifyAnnualRenewal({
  previousRecord,
  targetMembershipYear,
  config,
  now = new Date(),
  hasActiveMonthlyAgreement = false,
  existingTargetRecord = null,
} = {}) {
  const targetWindow = targetMembershipYear?.start
    ? { start: dateOnly(targetMembershipYear.start), end: dateOnly(targetMembershipYear.end) }
    : null;
  if (!previousRecord) {
    return {
      applicable: false,
      eligible: true,
      state: 'initial',
      message: 'This is the first annual membership term.',
      target: targetWindow,
      policy: normalizeAnnualRenewalConfig(config),
    };
  }
  if (!isAnnualNonRecurring(previousRecord) || hasActiveMonthlyAgreement) {
    return {
      applicable: false,
      eligible: false,
      code: 'recurring_membership_managed_separately',
      state: 'recurring',
      message: 'This membership is already managed by a recurring monthly payment plan.',
      policy: normalizeAnnualRenewalConfig(config),
    };
  }

  const policy = normalizeAnnualRenewalConfig(config);
  const previousTerm = deriveAnnualTerm(previousRecord, config, now);
  const targetStart = addDays(previousTerm.end, 1);
  const targetEnd = fullYearEnd(targetStart);
  const openDate = addDays(previousTerm.end, -policy.windowDays);
  const graceCutoff = addDays(previousTerm.end, policy.graceDays);
  const today = dateOnly(now);

  if (existingTargetRecord) {
    return {
      applicable: true, eligible: false, code: 'annual_renewal_already_exists',
      state: 'renewed', message: `The next term is already recorded and starts on ${toDateString(targetStart)}.`,
      policy, previousTerm, target: { start: targetStart, end: targetEnd }, openDate, graceCutoff,
    };
  }
  if (today < openDate) {
    return {
      applicable: true, eligible: false, code: 'annual_renewal_not_open',
      state: 'renewable_soon', message: `Renewal opens on ${toDateString(openDate)}.`,
      policy, previousTerm, target: { start: targetStart, end: targetEnd }, openDate, graceCutoff,
    };
  }
  if (today > graceCutoff) {
    return {
      applicable: true, eligible: false, code: 'annual_renewal_grace_expired',
      state: 'expired', message: `The renewal grace period ended on ${toDateString(graceCutoff)}. Please contact an administrator.`,
      policy, previousTerm, target: { start: targetStart, end: targetEnd }, openDate, graceCutoff,
    };
  }
  const state = today <= previousTerm.end ? 'open' : 'grace';
  return {
    applicable: true, eligible: true, state,
    message: state === 'open'
      ? `Renewal is open. The current term remains active through ${toDateString(previousTerm.end)}.`
      : `The term ended on ${toDateString(previousTerm.end)}; renewal remains available through ${toDateString(graceCutoff)}.`,
    policy, previousTerm, target: { start: targetStart, end: targetEnd }, openDate, graceCutoff,
  };
}

async function loadEntityHistory(client, { tenantId, memberId, organizationId }) {
  const table = memberId ? 'member_membership_history' : 'organisation_membership_history';
  const idColumn = memberId ? 'member_id' : 'organization_id';
  const id = memberId || organizationId;
  const { data, error } = await client.from(table)
    .select('id, membership_year, billing_period, status, payment_status, config_id, term_start_date, term_end_date, scheduled_activation_date, created_at')
    .eq('tenant_id', tenantId)
    .eq(idColumn, id)
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) throw new Error(`Could not load membership history: ${error.message}`);
  return data || [];
}

export async function hasActiveMonthlyBillingAgreement(client, { tenantId, memberId }) {
  if (!memberId) return false;
  const { data, error } = await client.from('membership_billing_agreements')
    .select('id, status, provider')
    .eq('tenant_id', tenantId)
    .eq('member_id', memberId)
    .in('status', [...ACTIVE_AGREEMENT_STATUSES]);
  if (error) throw new Error(`Could not resolve monthly billing agreement: ${error.message}`);
  return (data || []).some((row) => ['gocardless', 'stripe'].includes(row.provider || 'gocardless'));
}

export async function resolveEntityAnnualRenewalEligibility(client, {
  tenantId,
  memberId = null,
  organizationId = null,
  config,
  membershipYear,
  now = new Date(),
}) {
  if (String(config?.billing_period || 'annual').toLowerCase() !== 'annual') {
    return { applicable: false, eligible: true, state: 'recurring', lifecycle: { kind: 'recurring' } };
  }
  const rows = await loadEntityHistory(client, { tenantId, memberId, organizationId });
  const targetLabel = membershipYear?.label || null;
  const existingTargetRecord = rows.find((row) => row.membership_year === targetLabel) || null;
  const targetStart = dateOnly(membershipYear?.start);
  const candidates = rows
    .filter((row) => row.membership_year !== targetLabel)
    .map((row) => ({ row, term: deriveAnnualTerm(row, config, now) }))
    .filter(({ term }) => !targetStart || term.start < targetStart)
    .sort((a, b) => b.term.end - a.term.end);
  const previousRecord = candidates[0]?.row || null;
  const hasMonthly = previousRecord && !isAnnualNonRecurring(previousRecord)
    ? true
    : await hasActiveMonthlyBillingAgreement(client, { tenantId, memberId });
  const result = classifyAnnualRenewal({
    previousRecord,
    targetMembershipYear: membershipYear,
    config,
    now,
    hasActiveMonthlyAgreement: hasMonthly,
    existingTargetRecord,
  });
  const target = result.target || {
    start: dateOnly(membershipYear?.start),
    end: dateOnly(membershipYear?.end),
  };
  return {
    ...result,
    lifecycle: {
      kind: result.state,
      configured: true,
      termStart: toDateString(target?.start),
      termEnd: toDateString(target?.end),
      currentTermEnd: toDateString(result.previousTerm?.end),
      renewalOpenDate: toDateString(result.openDate),
      renewalGraceEndDate: toDateString(result.graceCutoff),
      isEarly: !!target?.start && dateOnly(now) < target.start,
      message: result.message,
    },
  };
}

export async function resolveAnnualRenewal(client, { tenantId, history, config = null, now = new Date() }) {
  if (!history) throw new Error('A membership history record is required.');
  let tier = config;
  if (!tier && history.config_id) {
    const { data, error } = await client.from('membership_tier_config')
      .select('*').eq('id', history.config_id).eq('tenant_id', tenantId).maybeSingle();
    if (error) throw new Error(`Could not load annual renewal configuration: ${error.message}`);
    tier = data;
  }
  if (!tier || !isAnnualNonRecurring(history)) return { applicable: false };
  const policy = normalizeAnnualRenewalConfig(tier);
  const term = deriveAnnualTerm(history, tier, now);
  const graceCutoff = addDays(term.end, policy.graceDays);
  const expired = dateOnly(now) > graceCutoff;
  return {
    applicable: true,
    state: expired ? 'expired' : (dateOnly(now) > term.end ? 'grace' : 'open'),
    policy,
    term,
    graceCutoff,
  };
}

export function annualRecordSchedule(eligibility) {
  const start = eligibility?.lifecycle?.termStart || null;
  const end = eligibility?.lifecycle?.termEnd || null;
  const early = eligibility?.lifecycle?.isEarly === true;
  return {
    status: early ? 'scheduled' : 'active',
    scheduled_activation_date: early ? start : null,
    term_start_date: start,
    term_end_date: end,
    annual_renewal_state: eligibility?.state === 'initial' ? 'open' : eligibility?.state || 'open',
  };
}