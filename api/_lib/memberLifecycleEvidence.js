import { lifecycleDay } from '../../shared/memberLifecyclePolicy.mjs';
import { deriveAnnualTerm, addDays, toDateString, isAnnualNonRecurring } from './annualRenewalPolicy.js';
import { resolveMemberAmendmentReadOverlays } from './membershipAmendmentReadOverlay.js';
import { checkMemberDeletionBilling } from './memberDeletionBillingSafety.js';
import { assessLifecycleCpd } from './memberLifecycleCpdEvidence.js';
import { assessLifecycleLogins } from './memberLoginEvidence.js';
import { loadLifecycleAttendance } from './memberLifecycleAttendance.js';
import { loadLifecycleObligations } from './memberLifecycleObligations.js';
import { lifecycleEvidenceFingerprint, reviewedMembershipAbsence, reviewedLoginCoverage } from './memberLifecycleProvenance.js';

// Never return a query builder from async: Supabase builders are thenables.
export async function lifecycleRows(db, table, tenantId, filters = [], { pageSize = 200, maxRows = 10000, keyColumns = ['id'] } = {}) {
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 1000
    || !Number.isInteger(maxRows) || maxRows < 1) throw new Error('Invalid lifecycle read bounds');
  const rows = [];
  let initialCount = null;
  for (let offset = 0; ; offset += pageSize) {
    let query = db.from(table).select('*', { count: 'exact' }).eq('tenant_id', tenantId);
    for (const [key, value, operator = 'eq'] of filters) {
      if (!['eq', 'imatch'].includes(operator)) throw new Error('Unsupported lifecycle source filter');
      query = operator === 'eq' ? query.eq(key, value) : query.filter(key, operator, value);
    }
    for (const column of keyColumns) query = query.order(column);
    const { data, error, count } = await query.range(offset, offset + pageSize - 1);
    if (error || !Array.isArray(data) || !Number.isInteger(count) || count < 0) {
      throw new Error(`Lifecycle source unavailable: ${table}`);
    }
    if (data.some(row => row.tenant_id !== tenantId)) throw new Error('Lifecycle source scope mismatch');
    if (initialCount === null) initialCount = count;
    if (count !== initialCount) throw new Error('Lifecycle source changed while reading');
    if (count > maxRows) throw new Error(`Lifecycle source exceeds safe preview bound: ${table}`);
    if (!keyColumns.length || data.some(row => keyColumns.some(key => row[key] == null))) throw new Error('Lifecycle source identity is missing');
    rows.push(...data);
    if (rows.length > maxRows) throw new Error(`Lifecycle source exceeds safe preview bound: ${table}`);
    if (rows.length >= count) {
      if (rows.length !== count || new Set(rows.map(row => JSON.stringify(keyColumns.map(key => row[key])))).size !== rows.length) {
        throw new Error('Lifecycle source changed while reading');
      }
      return rows;
    }
    if (data.length !== pageSize) throw new Error('Lifecycle source returned an incomplete page');
  }
}

const retired = new Set(['cancelled', 'canceled', 'void', 'expired_checkout', 'replaced', 'cancelled_by_request']);
export function assessLifecycleMembership(histories, { tenantId, memberId, today }) {
  if (!Array.isArray(histories) || histories.some(row => row.tenant_id !== tenantId
    || row.member_id !== memberId || row.organization_id)) throw new Error('Invalid membership provenance');
  const retained = histories.filter(row => !retired.has(row.status));
  if (!retained.length) return { historyKind: 'unknown' };
  // Even pending/unverified terms protect against an automated loss of access.
  if (retained.some(row => ['pending', 'pending_payment_setup', 'scheduled'].includes(row.status))) {
    return { historyKind: 'former', pendingRenewal: true };
  }
  const terms = retained.map(row => {
    if (!row.term_start_date || !row.term_end_date) throw new Error('Membership term evidence is incomplete');
    const start = lifecycleDay(row.term_start_date), end = lifecycleDay(row.term_end_date);
    if (start > end) throw new Error('Membership term is invalid');
    return { row, start, end };
  }).sort((a, b) => a.start.localeCompare(b.start));
  if (terms.some(term => term.start > today)) return { historyKind: 'former', futureEntitlement: true };
  if (terms.some(term => term.end >= today && ['active', 'historical'].includes(term.row.status))) {
    return { historyKind: 'former', active: true };
  }
  for (let i = 1; i < terms.length; i++) {
    if (terms[i - 1].end >= terms[i].start) throw new Error('Membership terms overlap');
  }
  const prior = terms.at(-1).row;
  if (prior.payment_status !== 'paid' || !isAnnualNonRecurring(prior)) throw new Error('Membership settlement needs review');
  const config = prior.effective_commitment_snapshot?.config || prior.renewal_policy_snapshot
    || prior.commitment_snapshot?.config || prior.incentive_snapshot?.config;
  if (!config || config.tenant_id !== tenantId || config.structure_scope_type !== 'member'
    || !Number.isInteger(config.renewal_grace_days) || config.renewal_grace_days < 0
    || config.renewal_grace_days > 366) throw new Error('Saved membership grace policy is unavailable');
  const term = deriveAnnualTerm(prior, config, new Date(`${today}T12:00:00Z`));
  return {
    historyKind: 'former',
    graceEndDate: toDateString(addDays(prior.term_key ? term.nextStart : term.end, config.renewal_grace_days)),
    expiryChangesAccess: config.renewal_change_role === true || config.renewal_disable_login === true,
  };
}

/**
 * Conservative, read-only preview adapter. Execution must use a locked database
 * snapshot, not this multi-request read. Missing source coverage remains explicit.
 */
export async function loadMemberLifecycleEvidence(db, tenantId, member, policy, now = new Date(), deps = {}) {
  const read = deps.readRows || lifecycleRows;
  const evidence = {
    tenantId, memberId: member.id, membershipComplete: false, obligationsComplete: false,
    membership: { historyKind: 'unknown' }, activity: {}, blockers: [],
    unavailableSources: [],
  };
  const today = lifecycleDay(now, policy.timezone);
  try {
    const saved = await read(db, 'member_membership_history', tenantId, [['member_id', member.id]]);
    const histories = await (deps.overlays || resolveMemberAmendmentReadOverlays)({
      db, tenantId, history: saved, asOf: today, renewal: true,
    });
    evidence.membershipFingerprint = lifecycleEvidenceFingerprint(histories);
    evidence.membershipRows = histories.length;
    evidence.membership = reviewedMembershipAbsence(histories, member.lifecycle_history_review, evidence.membershipFingerprint, today)
      || assessLifecycleMembership(histories, { tenantId, memberId: member.id, today });
    // Organisation entitlement must not be inferred from missing individual history.
    if (member.organization_id) {
      const orgHistory = await read(db, 'organisation_membership_history', tenantId, [['organization_id', member.organization_id]]);
      if (orgHistory.some(row => !retired.has(row.status))) evidence.blockers.push('organisation_entitlement_requires_review');
    }
    const elections = await read(db, 'membership_successor_election', tenantId, [['member_id', member.id]]);
    if (elections.some(row => row.status !== 'released')) evidence.membership.pendingRenewal = true;
    evidence.membershipComplete = true;
    if (evidence.membership.expiryChangesAccess) evidence.blockers.push('existing_expiry_access_policy_requires_coordination');
  } catch { evidence.unavailableSources.push('membership'); }
  try {
    // The shared disposal helper supports legacy consumers with optional
    // counts. Lifecycle decisions require independently complete ranged reads.
    const agreements = await read(db, 'membership_billing_agreements', tenantId, [['member_id', member.id]]);
    await read(db, 'membership_payment_plans', tenantId, [['member_id', member.id]]);
    for (const agreement of agreements) {
      await read(db, 'membership_payment_plans', tenantId, [['billing_agreement_id', agreement.id]]);
    }
    const billing = await (deps.billing || checkMemberDeletionBilling)(db, { tenantId, memberId: member.id });
    if (billing.failures?.length || billing.status === 503) throw new Error('Billing evidence incomplete');
    if (!billing.success) evidence.blockers.push('unresolved_recurring_billing');
    const obligations = await (deps.obligations || loadLifecycleObligations)(db, tenantId, member, policy, now, read);
    evidence.obligationsComplete = obligations.complete === true;
    evidence.blockers.push(...obligations.blockers);
    if (!evidence.obligationsComplete) evidence.unavailableSources.push('outstanding_obligations');
  } catch { evidence.unavailableSources.push('billing'); }
  // last_activity and credential last_login lack complete per-tenant successful
  // member-login provenance; existing CPD display fallbacks can use import time.
  // They cannot safely be presented as authoritative lifecycle evidence.
  for (const type of policy.activities) {
    evidence.activity[type] = { complete: false, lastOccurredAt: null };
    if (type === 'cpd_activity') {
      try {
        const ledger = await read(db, 'member_cpd_effective_ledger', tenantId, [['effective_member_id', member.id]]);
        evidence.activity[type] = assessLifecycleCpd(ledger, {
          tenantId, memberId: member.id, timezone: policy.timezone, now,
        });
        if (evidence.activity[type].complete) continue;
      } catch {
        evidence.activity[type].reasons = ['cpd_source_unavailable'];
      }
    }
    if (type === 'portal_login') {
      try {
        const logins = await read(db, 'member_lifecycle_login_evidence', tenantId, [['member_id', member.id]]);
        evidence.activity[type] = assessLifecycleLogins(logins, {
          tenantId, memberId: member.id, timezone: policy.timezone, now,
        });
        evidence.activity[type] = reviewedLoginCoverage(evidence.activity[type], member.lifecycle_login_review, today);
        if (evidence.activity[type].complete) continue;
      } catch {
        evidence.activity[type].reasons = ['login_source_unavailable'];
      }
    }
    if (type === 'event_attendance') {
      try {
        evidence.activity[type] = await loadLifecycleAttendance(db, tenantId, member, policy, now, read);
        if (evidence.activity[type].complete) continue;
      } catch {
        evidence.activity[type].reasons = ['attendance_source_unavailable'];
      }
    }
    evidence.unavailableSources.push(type);
  }
  return evidence;
}
