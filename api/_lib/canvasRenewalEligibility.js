import { addDays, normalizeAnnualRenewalConfig } from './annualRenewalPolicy.js';
import { shapeLegacyCurrentMembership } from '../membership/member-membership.js';

const day = value => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(+parsed) && parsed.toISOString().slice(0, 10) === value ? value : null;
};
const hidden = () => ({ eligible: false });
const upfrontPeriod = record => record.billing_period === 'annual'
  || (!!record.term_key && ['quarterly', 'monthly'].includes(record.billing_period)
    && record.commitment_snapshot?.payment_frequency === 'upfront');

// Read-only display policy. In particular, an attested expiry-only legacy row
// does not acquire a fabricated start, rolling commitment or renewal authority.
export function canvasRenewalEligibility({ record, config, history = [], today, paused = false, hasRecurring = false }) {
  if (!record || record.membership_source !== 'personal' || paused || hasRecurring
      || !['active', 'paid', 'expired'].includes(record.status)
      || record.payment_status !== 'paid' || record.billing_agreement_id
      || !['upfront', 'card', 'stripe', 'invoice', 'bank_transfer'].includes(record.payment_method)
      || !upfrontPeriod(record) || record.commitment_snapshot?.payment_frequency === 'monthly'
      || !day(today) || !config || config.structure_scope_type !== 'member'
      || (config.tenant_id && config.tenant_id !== record.tenant_id)) return hidden();
  const end = day(record.term_end_date);
  if (!end) return hidden();
  const legacy = shapeLegacyCurrentMembership(record, record.tenant_id, new Date(`${end}T00:00:00Z`));
  const start = day(record.term_start_date);
  if (!legacy && (!start || start > end || start > today)) return hidden();
  const rolling = !!record.term_key;
  const next = addDays(end, 1).toISOString().slice(0, 10);
  if (rolling && (!record.commitment_snapshot || day(record.membership_renewal_date) !== next)) return hidden();
  // A successor reservation (including unpaid/scheduled) must not offer a
  // second renewal. Ambiguous overlapping retained terms also fail closed.
  if (history.some(other => other.id !== record.id
      && !['cancelled', 'canceled', 'failed'].includes(other.status)
      && (other.previous_term_id === record.id || !day(other.term_start_date)
        || other.term_start_date >= (start || end)))) return hidden();
  const savedConfig = record.commitment_snapshot?.config || config;
  if (savedConfig.tenant_id && savedConfig.tenant_id !== record.tenant_id) return hidden();
  // Missing settings are not evidence of an assigned renewal window. Explicit
  // zero follows the canonical policy: only the anchor day, not "unlimited".
  for (const key of ['renewal_open_days', 'renewal_grace_days']) {
    if (savedConfig[key] == null || savedConfig[key] === ''
        || !Number.isInteger(Number(savedConfig[key]))
        || Number(savedConfig[key]) < 0 || Number(savedConfig[key]) > 366) return hidden();
  }
  const policy = normalizeAnnualRenewalConfig(savedConfig);
  // classifyAnnualRenewal anchors rolling terms at nextStart, fixed annual
  // terms at their inclusive end. Preserve that distinction for legacy rows.
  const anchor = rolling ? next : end;
  const opens = addDays(anchor, -policy.windowDays).toISOString().slice(0, 10);
  const closes = addDays(anchor, policy.graceDays).toISOString().slice(0, 10);
  return {
    eligible: today >= opens && today <= closes,
    inGrace: today > end && today <= closes,
    graceEndDate: closes,
    paidThroughDate: end,
  };
}

export async function loadCanvasRenewalEligibility(db, { selected, owner, history, today, plan }) {
  const record = selected?.record;
  if (!record || record.membership_source !== 'personal' || owner.membership_paused
      || plan || record.billing_agreement_id || record.payment_status !== 'paid'
      || !upfrontPeriod(record)
      || !['upfront', 'card', 'stripe', 'invoice', 'bank_transfer'].includes(record.payment_method)) return hidden();
  const tenantId = owner.tenant_id;
  const read = async query => {
    const rows = [];
    for (let offset = 0; ; offset += 500) {
      const { data, error } = await query.order('id', { ascending: true }).range(offset, offset + 499);
      if (error || !Array.isArray(data)) throw new Error('Renewal eligibility evidence unavailable');
      rows.push(...data);
      if (data.length < 500) return rows;
    }
  };
  try {
    const agreements = await read(db.from('membership_billing_agreements').select('tenant_id, member_id, status')
      .eq('tenant_id', tenantId).eq('member_id', owner.id));
    if (agreements.some(row => row.tenant_id !== tenantId || row.member_id !== owner.id
        || !['cancelled', 'canceled', 'expired', 'completed'].includes(row.status))) return hidden();
    let config = record.commitment_snapshot?.config;
    let policySource = config ? 'saved_snapshot' : 'saved_history_config';
    if (!config && record.config_id) {
      const configs = await read(db.from('membership_tier_config').select('*')
        .eq('tenant_id', tenantId).eq('id', record.config_id));
      if (configs.length !== 1 || configs[0].tenant_id !== tenantId || configs[0].id !== record.config_id) return hidden();
      config = configs[0];
    }
    if (!config) {
      policySource = 'display_only_renewal_boundary';
      const expiry = day(record.term_end_date);
      if (!expiry || !shapeLegacyCurrentMembership(record, tenantId, new Date(`${expiry}T00:00:00Z`))) return hidden();
      const configs = await read(db.from('membership_tier_config').select('*').eq('tenant_id', tenantId));
      const members = await read(db.from('member').select('*').eq('tenant_id', tenantId).eq('id', owner.id));
      if (members.length !== 1 || members[0].tenant_id !== tenantId || members[0].id !== owner.id
          || configs.some(row => row.tenant_id !== tenantId)) return hidden();
      // Preferences have no tenant column: ownership comes from the scoped
      // member lookup and exact member ID, just as in the payment report.
      const preferences = await read(db.from('member_preference_value').select('member_id, field_id, value').eq('member_id', owner.id));
      if (preferences.some(row => row.member_id !== owner.id)) return hidden();
      const { upfrontRenewalProjection } = await import('./membershipPaymentReport.js');
      const projection = upfrontRenewalProjection({
        record, member: members[0], tenantId, configs,
        preferences: preferences.map(row => ({ ...row, tenant_id: tenantId })),
      });
      config = configs.find(row => row.id === projection.nextStructureId);
    }
    const result = canvasRenewalEligibility({ record, config, history, today });
    return result.graceEndDate ? { ...result, policySource } : result;
  } catch {
    // Eligibility is optional display evidence. Read failure never enables a
    // CTA or destroys the independently available payment details.
    return { eligible: false, reason: 'eligibility_evidence_unavailable' };
  }
}