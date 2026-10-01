import { addDays, dateOnly } from './annualRenewalPolicy.js';

export const EXPIRY_POLICY_TABLE = 'membership_expiry_policy_assignment';

// Notes identify the reviewed import shape, never its renewal-policy authority.
export function isAttestedExpiryOnlyHistory(history, tenantId) {
  if (tenantId !== 'ff2df806-b321-4254-b651-3af11fccf1db' || history?.tenant_id !== tenantId
      || !history.member_id || history.organization_id
      || history.membership_year !== '2025/2026' || history.status !== 'active'
      || history.payment_status !== 'paid' || history.payment_method !== 'upfront'
      || history.billing_period !== 'annual' || history.currency !== 'GBP'
      || !history.tier_label || history.config_id != null || history.term_start_date != null
      || history.membership_renewal_date != null || history.term_key != null
      || history.term_duration_months != null || history.term_anchor_date != null
      || history.previous_term_id != null || history.commitment_snapshot != null
      || history.billing_agreement_id != null) return false;
  const expiry = history.term_end_date;
  if (typeof expiry !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(expiry)
      || !Number.isFinite(Date.parse(expiry))
      || new Date(expiry).toISOString().slice(0, 10) !== expiry || expiry > '2026-12-31') return false;
  let notes = history.notes;
  if (typeof notes === 'string') {
    try { notes = JSON.parse(notes); } catch { return false; }
  }
  if (notes?.source !== 'bnms_non_dd_current_backfill') return false;
  const missingCost = history.final_cost == null;
  const missingTotal = history.total_with_vat == null;
  return missingCost === missingTotal && (missingCost
    || (Number.isFinite(Number(history.final_cost)) && Number(history.final_cost) >= 0
      && Number(history.total_with_vat) === Number(history.final_cost)));
}

export async function loadExpiryOnlyRenewalPolicy(db, { tenantId, history }) {
  if (!isAttestedExpiryOnlyHistory(history, tenantId)) return null;
  const { data: row, error } = await db.from(EXPIRY_POLICY_TABLE).select('*')
    .eq('tenant_id', tenantId).eq('history_id', history.id).maybeSingle();
  // During additive rollout, absence means no authority and retained review.
  if (error && ['42P01', 'PGRST205'].includes(error.code)) return null;
  if (error) throw new Error(`Expiry-only renewal policy unavailable: ${error.message}`);
  if (!row) return null;
  return validateExpiryOnlyRenewalPolicy(db, { tenantId, history, row });
}

// Batch discovery avoids an N+1 for unresolved reviews. Validate one assigned
// row on demand so the caller can checkpoint its resolution before its budget.
export async function prepareExpiryOnlyRenewalPolicies(db, { tenantId, histories, guard = () => {} }) {
  const eligible = histories.filter(history => isAttestedExpiryOnlyHistory(history, tenantId));
  const policies = new Map(eligible.map(history => [history.id, null]));
  if (!eligible.length) return policies;
  let after = null;
  const rows = [];
  while (true) {
    guard();
    let query = db.from(EXPIRY_POLICY_TABLE).select('*').eq('tenant_id', tenantId)
      .in('history_id', eligible.map(history => history.id)).order('id', { ascending: true }).limit(100);
    if (after) query = query.gt('id', after);
    const { data, error } = await query;
    if (error && ['42P01', 'PGRST205'].includes(error.code)) return policies;
    if (error || !Array.isArray(data)) throw new Error('Expiry-only renewal policy batch unavailable');
    if (!data.length) break;
    rows.push(...data);
    after = data.at(-1).id;
  }
  for (const row of rows) {
    guard();
    const history = eligible.find(history => history.id === row.history_id);
    if (!history || policies.get(history.id)) throw new Error('Expiry-only renewal policy batch binding invalid');
    policies.set(history.id, () => validateExpiryOnlyRenewalPolicy(db, { tenantId, history, row }));
  }
  return policies;
}

async function validateExpiryOnlyRenewalPolicy(db, { tenantId, history, row }) {
  const { data: persisted, error: historyError } = await db.from('member_membership_history').select('*')
    .eq('tenant_id', tenantId).eq('id', history.id).eq('member_id', history.member_id).maybeSingle();
  if (historyError || !persisted || persisted.id !== history.id || persisted.member_id !== history.member_id
      || !isAttestedExpiryOnlyHistory(persisted, tenantId)
      || persisted.term_end_date !== history.term_end_date) {
    throw new Error('Expiry-only renewal policy history binding unavailable');
  }
  const policy = row.policy_snapshot;
  if (row.tenant_id !== tenantId || row.history_id !== history.id
      || row.member_id !== history.member_id || row.expiry_date !== history.term_end_date
      || !row.id || !row.config_id || !row.config_name || row.approval_source !== 'operator'
      || !policy || Object.keys(policy).sort().join(',') !== [
        'renewal_change_role', 'renewal_disable_login', 'renewal_fallback_role_id',
        'renewal_grace_days', 'renewal_open_days',
      ].join(',')
      || policy.renewal_open_days !== 90 || policy.renewal_grace_days !== 90
      || policy.renewal_disable_login !== true || policy.renewal_change_role !== false
      || policy.renewal_fallback_role_id !== null) {
    throw new Error('Expiry-only renewal policy binding or approved snapshot is invalid');
  }
  const { data: member, error: memberError } = await db.from('member').select('id, tenant_id')
    .eq('tenant_id', tenantId).eq('id', history.member_id).maybeSingle();
  if (memberError || member?.id !== history.member_id || member?.tenant_id !== tenantId) {
    throw new Error('Expiry-only renewal policy member binding unavailable');
  }
  const { data: config, error: configError } = await db.from('membership_tier_config')
    .select('id, tenant_id, structure_scope_type, billing_period')
    .eq('tenant_id', tenantId).eq('id', row.config_id).maybeSingle();
  if (configError || config?.id !== row.config_id || config?.tenant_id !== tenantId
      || config.structure_scope_type !== 'member' || config.billing_period !== 'annual') {
    throw new Error('Expiry-only renewal policy configuration binding unavailable');
  }
  // Snapshot is immutable: subsequent live settings/prices never restamp consent.
  return {
    assignmentId: row.id, tenantId, historyId: row.history_id, memberId: row.member_id,
    configId: row.config_id, configName: row.config_name, expiryDate: row.expiry_date,
    renewalOpenDays: policy.renewal_open_days, renewalGraceDays: policy.renewal_grace_days,
    disableLogin: policy.renewal_disable_login, changeRole: policy.renewal_change_role,
    fallbackRoleId: policy.renewal_fallback_role_id,
    graceEndDate: addDays(row.expiry_date, policy.renewal_grace_days).toISOString().slice(0, 10),
    firstExpiredDate: addDays(row.expiry_date, policy.renewal_grace_days + 1).toISOString().slice(0, 10),
    policySource: 'operator_assigned_expiry_only',
  };
}

export function expiryOnlyRenewalPolicyDisplay(policy) {
  return policy ? {
    policySource: policy.policySource, configId: policy.configId, configName: policy.configName,
    paidThroughDate: policy.expiryDate, graceEndDate: policy.graceEndDate,
    renewalGraceDays: policy.renewalGraceDays,
  } : null;
}

export function expiryOnlyPolicyConfig(policy) {
  return { tenant_id: policy.tenantId, id: policy.configId, name: policy.configName,
    structure_scope_type: 'member', billing_period: 'annual',
    renewal_open_days: policy.renewalOpenDays, renewal_grace_days: policy.renewalGraceDays,
    renewal_disable_login: policy.disableLogin, renewal_change_role: policy.changeRole,
    renewal_fallback_role_id: policy.fallbackRoleId };
}

export function expiryOnlyLifecycle(policy, now) {
  const end = dateOnly(policy.expiryDate);
  const graceCutoff = dateOnly(policy.graceEndDate);
  return { applicable: true, state: dateOnly(now) > graceCutoff ? 'expired'
    : dateOnly(now) > end ? 'grace' : 'open',
  term: { start: null, end, nextStart: addDays(end, 1) }, graceCutoff };
}