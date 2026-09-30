import { resolveSavedCollectionPolicy } from '../../shared/gocardlessCollectionPolicy.js';
import { monthlySnapshotCommitment, monthlyRenewalIdentity, assertTrustedMonthlyTerm } from './monthlyRenewalTerms.js';
import { createDdRenewals } from './gocardlessDdRenewalsCore.js';
import { renewalCapabilities, findRenewalMandate } from './ddRenewalCapabilities.js';

export const RENEWAL_NOTICE_DAYS = 30;

export function deriveNextYearLabel(label) {
  if (!label || typeof label !== 'string') return null;
  const m = label.match(/^(\d{4})([\/-])(\d{2,4})$/);
  if (m) {
    const start = parseInt(m[1], 10) + 1;
    const end = m[3].length === 4 ? start + 1 : (start + 1) % 100;
    return `${start}${m[2]}${String(end).padStart(m[3].length, '0')}`;
  }
  return /^\d{4}$/.test(label) ? String(parseInt(label, 10) + 1) : null;
}

export function computeRenewalWindow(snapshot, noticeDays = RENEWAL_NOTICE_DAYS) {
  const commitment = monthlySnapshotCommitment(snapshot);
  const renewalDate = commitment?.membership_renewal_date || snapshot?.membership_renewal_date;
  if (renewalDate) {
    const yearEnd = new Date(`${renewalDate}T00:00:00.000Z`);
    if (!Number.isFinite(yearEnd.getTime())) return null;
    return { yearEnd, noticeDate: new Date(yearEnd.getTime() - noticeDays * 86_400_000) };
  }
  if (snapshot?.start_mode === 'immediate' || commitment) return null;
  const start = snapshot?.membership_year_start ? new Date(snapshot.membership_year_start) : null;
  if (!start || Number.isNaN(start.getTime())) return null;
  const yearEnd = new Date(Date.UTC(start.getUTCFullYear() + 1, start.getUTCMonth(), start.getUTCDate()));
  return { yearEnd, noticeDate: new Date(yearEnd.getTime() - noticeDays * 86_400_000) };
}

export function decideRenewalAction({ snapshot, planStatus, autoRenew, renewalRow, hasNextYearRecord = false, today = new Date(), expectedKind = 'monthly_direct_debit' }) {
  if (!snapshot || snapshot.kind !== expectedKind) return { action: 'none', reason: `not a ${expectedKind} agreement` };
  if (expectedKind === 'monthly_direct_debit') {
    const policy = resolveSavedCollectionPolicy(snapshot);
    if (policy.needs_review) return { action: 'none', reason: 'Direct Debit continuation consent needs review' };
    autoRenew = policy.end_policy === 'continue';
  }
  if (!['active', 'expired'].includes(planStatus)) return { action: 'none', reason: `plan status ${planStatus} not renewable` };
  const window = computeRenewalWindow(snapshot);
  if (!window) return { action: 'none', reason: 'no membership_year_start in snapshot' };
  if (renewalRow && ['renewed', 'confirmed', 'declined', 'failed'].includes(renewalRow.status)) {
    return { action: 'none', reason: `renewal already ${renewalRow.status}` };
  }
  if (hasNextYearRecord) return { action: 'none', reason: 'next-year membership already recorded elsewhere' };
  if (today < window.noticeDate) return { action: 'none', reason: 'before notice window' };
  if (monthlySnapshotCommitment(snapshot) && ['notice_processing', 'notice_error'].includes(renewalRow?.status)) {
    return { action: 'send_notice', mode: autoRenew ? 'auto' : 'confirm' };
  }
  if (!renewalRow) return { action: 'send_notice', mode: autoRenew ? 'auto' : 'confirm' };
  if (today < window.yearEnd) return { action: 'none', reason: 'notice sent; waiting for year end' };
  if (renewalRow.mode === 'auto' && autoRenew !== false) return { action: 'renew_auto' };
  return { action: 'await_confirmation', reason: 'confirmation-required renewal awaiting member' };
}

export const renewalAgreementQuery = (db, tenantId) => db.from('membership_billing_agreements')
  .select('*').eq('tenant_id', tenantId).eq('metadata->dd->>kind', 'monthly_direct_debit');

// This is the actual pre-effect part of the tenant renewal loop. Both callers
// use it; it deliberately does not obtain production simulation/client helpers.
export async function loadRenewalContext({ db, agreement, now, planId, checkLatest = true, pausedMemberIds }) {
  const tenantId = agreement.tenant_id;
  const ownerColumn = agreement.organization_id ? 'organization_id' : 'member_id';
  const ownerId = agreement.organization_id || agreement.member_id;
  const skip = reason => ({ status: 'skipped', reason });
  if (!ownerId || (agreement.organization_id && agreement.member_id)) {
    throw new Error('Direct Debit renewal has an ambiguous membership owner.');
  }
  if (agreement.metadata?.dd?.kind !== 'monthly_direct_debit') return skip('not a monthly_direct_debit agreement');
  if (agreement.metadata?.renewal_setup_pending) return skip('renewal setup is pending');
  if (checkLatest) {
    const { data: latest, error } = await renewalAgreementQuery(db, tenantId)
      .eq(ownerColumn, ownerId)
      .or('metadata->>renewal_setup_pending.is.null,metadata->>renewal_setup_pending.eq.false')
      .order('created_at', { ascending: false }).order('id', { ascending: false }).limit(1);
    if (error) throw new Error(`Could not check latest DD agreement: ${error.message}`);
    if (latest?.[0]?.id !== agreement.id) return skip('superseded by a later owner agreement');
  }
  let paused = pausedMemberIds?.has(agreement.member_id);
  if (pausedMemberIds == null && agreement.member_id) {
    const { data, error } = await db.from('member').select('id, membership_paused')
      .eq('tenant_id', tenantId).eq('id', agreement.member_id).maybeSingle();
    if (error) throw new Error(`Could not check paused memberships: ${error.message}`);
    paused = data?.membership_paused === true;
  }
  if (paused) return skip('Membership paused');
  const snapshot = agreement.metadata?.dd;
  await assertTrustedMonthlyTerm(db, tenantId, snapshot);
  const window = computeRenewalWindow(snapshot);
  if (!window) return skip('no reliable renewal window in snapshot');
  if (now < window.noticeDate) return skip('before notice window');
  const { data: plans, error: planError } = await db.from('membership_payment_plans')
    .select('id, status').eq('billing_agreement_id', agreement.id)
    .order('created_at', { ascending: false }).limit(1);
  if (planError) throw new Error(`Could not load DD payment plan: ${planError.message}`);
  const plan = plans?.[0];
  if (!plan?.id) return { status: 'blocked', reason: 'missing payment plan' };
  if (planId && plan.id !== planId) return skip('selected plan is not the latest agreement payment plan');
  const { count, error: arrearsError } = await db.from('membership_monthly_arrears_period')
    .select('id', { count: 'exact', head: true }).eq('tenant_id', tenantId)
    .eq('plan_id', plan.id).is('settled_at', null);
  if (arrearsError) return { status: 'blocked', reason: `open monthly arrears check failed: ${arrearsError.message}` };
  if ((count || 0) > 0) return { status: 'blocked', reason: 'unresolved monthly arrears block renewal' };
  const renewalYear = monthlyRenewalIdentity(snapshot) || deriveNextYearLabel(snapshot.membership_year) || `after ${snapshot.membership_year}`;
  const { data: renewalRow, error: renewalError } = await db.from('membership_dd_renewals')
    .select('*').eq('previous_agreement_id', agreement.id).eq('renewal_year', renewalYear).maybeSingle();
  if (renewalError) throw new Error(`Could not check DD renewal: ${renewalError.message}`);
  const { data: history, error: historyError } = await db
    .from(agreement.organization_id ? 'organisation_membership_history' : 'member_membership_history')
    .select('id, payment_method, billing_agreement_id').eq('tenant_id', tenantId)
    .eq(ownerColumn, ownerId).eq('membership_year', renewalYear).limit(1);
  if (historyError) throw new Error(`Could not check DD renewal history: ${historyError.message}`);
  return {
    status: 'ready', snapshot, planStatus: plan.status, renewalRow, renewalYear,
    ownerColumn, ownerId, hasNextYearRecord: !!history?.[0] && history[0].payment_method !== 'direct_debit',
  };
}

export async function runRenewals({ db, plan, agreement, now, effects, trace = () => {}, simulate, resolveConfig }) {
  const capabilities = renewalCapabilities(db, effects);
  const results = { details: [] };
  const options = {
    ...capabilities, agreement, planId: plan.id, now: () => new Date(now),
    findMandate: findRenewalMandate, simulate, resolveConfig,
  };
  await createDdRenewals(options).processTenantDdRenewals(agreement.tenant_id, results, options);
  capabilities.assertReads();
  const stages = results.details.map(detail => ({
    stage: detail.step, status: detail.status, reason: detail.reason || 'Renewal stage completed',
  }));
  if (!stages.length) stages.push({ stage: 'direct-debit-renewals', status: 'skipped', reason: 'No eligible renewal agreement' });
  for (const stage of stages) {
    if (typeof trace === 'function') trace(stage);
    else if (Array.isArray(trace)) trace.push(stage);
  }
  return stages.at(-1);
}