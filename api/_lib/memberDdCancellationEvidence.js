// Server-side, read-only evidence for member-initiated Direct Debit
// cancellation. Never calls a payment provider. Every uncertainty fails closed
// to a named blocker; the browser never supplies counts, dates or roles.

const SUCCESS = new Set(['confirmed', 'paid_out']);
const IN_FLIGHT = new Set(['pending_customer_approval', 'pending_submission', 'submitted']);
const DD_METHODS = new Set(['direct_debit', 'gocardless', 'monthly_direct_debit', 'gocardless_monthly', 'direct_debit_monthly']);
const RETIRED_HISTORY = new Set(['replaced', 'cancelled_by_request', 'expired_checkout', 'expired', 'failed']);
const LIVE_AGREEMENT = new Set(['payment_setup_required', 'mandate_pending', 'first_payment_pending', 'active',
  'payment_grace_period', 'payment_overdue']);
const MAX_LINEAGE = 25;
const date = value => (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : null);

export const DD_CANCELLATION_MESSAGES = {
  not_installed: 'Online cancellation is not available yet. Please contact your membership team.',
  already_cancelled: 'Your membership has already been cancelled.',
  cancellation_scheduled: 'Your membership cancellation is already scheduled.',
  paused: 'Your membership is paused. Please contact your membership team to cancel.',
  no_current_membership: 'There is no current membership to cancel.',
  multiple_current_memberships: 'Your membership records need review. Please contact your membership team.',
  organisation_funded: 'Your membership is provided by your organisation and cannot be cancelled here.',
  not_direct_debit: 'Online cancellation is only available for monthly Direct Debit memberships.',
  agreement_unverified: 'Your Direct Debit arrangement could not be verified. Please contact your membership team.',
  outstanding_payments: 'There are outstanding or unresolved payments. Please contact your membership team.',
  collections_stopped: 'Collections for this membership are already stopped. Please contact your membership team.',
  other_purchase: 'Another membership purchase or payment arrangement needs review first. Please contact your membership team.',
  amended_purchase: 'Your membership has a pending change. Please contact your membership team.',
  lineage_unverified: 'Your payment history could not be verified. Please contact your membership team.',
  threshold_unverified: 'Your agreed number of payments could not be verified. Please contact your membership team.',
  legacy_history_unverified: 'Some earlier payments could not be verified. Please contact your membership team.',
  below_threshold: 'You can cancel online once all of your agreed monthly payments have been collected.',
  no_paid_coverage: 'Your latest payment has not completed yet. Please contact your membership team.',
  coverage_unverified: 'Your paid-up date could not be verified. Please contact your membership team.',
  fallback_role_missing: 'Online cancellation is not set up for this membership. Please contact your membership team.',
  fallback_role_invalid: 'Online cancellation is not set up for this membership. Please contact your membership team.',
  evidence_unavailable: 'Your membership details could not be checked right now. Please try again later.',
};

const blocked = (blocker, extra = {}) => ({ eligible: false, blocker, message: DD_CANCELLATION_MESSAGES[blocker], ...extra });
class Unverified extends Error { constructor(blocker) { super(blocker); this.blocker = blocker; } }
const unverified = blocker => { throw new Unverified(blocker); };

function addMonths(iso, months) {
  const [y, m, d] = iso.split('-').map(Number);
  const target = new Date(Date.UTC(y, m - 1 + months, d));
  // Coverage allocation is only exact for days that exist in every month.
  if (target.getUTCDate() !== d) return null;
  return target.toISOString().slice(0, 10);
}

export function wholeMonthsBetween(start, end) {
  if (!date(start) || !date(end) || end <= start) return null;
  const [sy, sm, sd] = start.split('-').map(Number);
  const [ey, em, ed] = end.split('-').map(Number);
  if (sd !== ed || sd > 28) return null;
  return (ey - sy) * 12 + (em - sm);
}

export function dayBefore(iso) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/**
 * Distinct successful collections. A provider payment ID is counted once,
 * whatever status changes or retries it went through. Refunded, partially
 * refunded, charged-back, failed, cancelled and in-flight payments never count.
 */
const LIVE_PLAN = new Set(['active', 'paused', 'pending']);
export function planCompleted(plan) {
  return plan?.status === 'expired' && !!plan.completed_at && !plan.needs_attention;
}

export function countSuccessfulCollections(payments = []) {
  const byId = new Map();
  for (const p of payments) {
    const key = p?.gocardless_payment_id;
    if (!key) unverified('lineage_unverified');
    if (byId.has(key) && byId.get(key).plan_id !== p.plan_id) unverified('lineage_unverified');
    byId.set(key, p);
  }
  let successful = 0; let inFlight = 0; const counted = [];
  for (const p of byId.values()) {
    const refunded = p.refund_status || Number(p.amount_refunded_minor || 0) > 0;
    if (SUCCESS.has(p.status) && !refunded) { successful++; counted.push(p); }
    else if (IN_FLIGHT.has(p.status)) inFlight++;
  }
  return { successful, inFlight, counted };
}

/**
 * Paid-through coverage from the purchased term, never "last payment plus a
 * month" or the next scheduled collection. A fully funded term covers the
 * whole term. Otherwise each settled instalment funds one month of the term
 * in order, which is only exact when the term is whole months long and the
 * agreed instalment count equals that number of months.
 * Returns the exclusive end date (the day access changes) or a blocker.
 */
export function resolvePaidCoverage({ termStart, renewalDate, instalmentCount, paidThisTerm, today }) {
  if (!date(termStart) || !date(renewalDate) || renewalDate <= termStart
      || !Number.isSafeInteger(instalmentCount) || instalmentCount <= 0
      || !Number.isSafeInteger(paidThisTerm) || paidThisTerm < 0) return { blocker: 'coverage_unverified' };
  let end;
  if (paidThisTerm >= instalmentCount) end = renewalDate;
  else {
    const months = wholeMonthsBetween(termStart, renewalDate);
    if (months !== instalmentCount) return { blocker: 'coverage_unverified' };
    end = paidThisTerm === 0 ? termStart : addMonths(termStart, paidThisTerm);
    if (!end) return { blocker: 'coverage_unverified' };
  }
  if (end <= today) return { blocker: 'no_paid_coverage' };
  return { effectiveDate: end, paidThroughDate: dayBefore(end) };
}

export function consentInstalmentCount(agreement) {
  const dd = agreement?.metadata?.dd;
  const count = dd?.instalment_count;
  if (!Number.isSafeInteger(count) || count <= 0) return null;
  const initial = dd.billing_request_payment;
  if (initial?.included === true && initial.remaining_instalments !== undefined
      && initial.remaining_instalments !== count - 1) return null;
  return count;
}

async function read(query) {
  const { data, error } = await query;
  if (error) {
    const e = new Error(error.message || 'read failed'); e.code = error.code; throw e;
  }
  return data;
}

async function paged(build, limit = 5000) {
  const rows = [];
  for (let offset = 0; offset < limit; offset += 500) {
    const data = await read(build().range(offset, offset + 499));
    if (!Array.isArray(data)) unverified('lineage_unverified');
    rows.push(...data);
    if (data.length < 500) return rows;
  }
  unverified('lineage_unverified');
}

const ownedAgreement = (a, tenantId, memberId) => a && a.tenant_id === tenantId && a.member_id === memberId
  && !a.organization_id && a.agreement_type === 'member' && a.provider === 'gocardless';

export function createMemberDdCancellationEvidence({ db, now = () => new Date() }) {
  async function plansFor(tenantId, memberId, agreementId) {
    const plans = await read(db.from('membership_payment_plans').select('*')
      .eq('tenant_id', tenantId).eq('member_id', memberId).eq('billing_agreement_id', agreementId)
      .order('created_at', { ascending: false }).order('id', { ascending: false }).limit(50));
    if (!Array.isArray(plans) || plans.length >= 50) unverified('lineage_unverified');
    if (plans.some(p => p.tenant_id !== tenantId || p.member_id !== memberId || p.organization_id
      || p.billing_agreement_id !== agreementId || p.provider !== 'gocardless')) unverified('agreement_unverified');
    return plans;
  }

  async function paymentsFor(tenantId, planIds) {
    if (!planIds.length) return [];
    return paged(() => db.from('gocardless_payments')
      .select('gocardless_payment_id, plan_id, tenant_id, status, refund_status, amount_refunded_minor, charge_date')
      .eq('tenant_id', tenantId).in('plan_id', planIds).order('id', { ascending: true }));
  }

  // Legacy first payments collected by a Billing Request before a plan existed
  // are owned only through the agreement's recorded initial payment ID.
  async function initialPayment(tenantId, agreement) {
    if (agreement.metadata?.dd?.billing_request_payment?.included !== true) return null;
    const paymentId = agreement.metadata?.gocardless_initial_payment?.id;
    if (!paymentId) unverified('lineage_unverified');
    const rows = await read(db.from('gocardless_payments')
      .select('gocardless_payment_id, plan_id, tenant_id, status, refund_status, amount_refunded_minor, charge_date')
      .eq('tenant_id', tenantId).eq('gocardless_payment_id', paymentId).limit(2));
    if (!Array.isArray(rows) || rows.length > 1) unverified('lineage_unverified');
    return rows[0] || { gocardless_payment_id: paymentId, plan_id: null, status: 'unknown' };
  }

  // Imported pre-migration collections count only through an exact adoption.
  async function legacyPayments(tenantId, memberId, agreement, history, plans) {
    if (agreement.metadata?.dd?.billing_request_mode !== 'migration_existing_mandate') return [];
    let adoption;
    try {
      adoption = await read(db.from('bnms_dd_pilot_adoption')
        .select('tenant_id, member_id, agreement_id, plan_id, history_id, historical_import_id')
        .eq('tenant_id', tenantId).eq('member_id', memberId).eq('agreement_id', agreement.id)
        .eq('history_id', history.id).limit(2));
    } catch { unverified('legacy_history_unverified'); }
    if (!Array.isArray(adoption) || adoption.length !== 1
        || !plans.some(p => p.id === adoption[0].plan_id)) unverified('legacy_history_unverified');
    let rows;
    try {
      rows = await read(db.from('bnms_dd_historical_payment')
        .select('tenant_id, member_id, import_id, period, charge_date, provider_status, historical_only')
        .eq('tenant_id', tenantId).eq('member_id', memberId)
        .eq('import_id', adoption[0].historical_import_id).eq('historical_only', true));
    } catch { unverified('legacy_history_unverified'); }
    if (!Array.isArray(rows) || rows.some(r => r.member_id !== memberId || r.tenant_id !== tenantId)) {
      unverified('legacy_history_unverified');
    }
    const periods = new Set();
    const counted = [];
    for (const row of rows) {
      if (row.provider_status !== 'paid_out') continue;
      const period = date(row.period || row.charge_date);
      if (!period) unverified('legacy_history_unverified');
      if (periods.has(period)) continue;
      periods.add(period); counted.push({ period });
    }
    return counted;
  }

  async function predecessorId(tenantId, agreement) {
    const fromMetadata = agreement.metadata?.dd?.renewal_of_agreement_id || agreement.metadata?.renewal_of_agreement_id || null;
    let fromRenewals = null;
    try {
      const rows = await read(db.from('membership_dd_renewals').select('previous_agreement_id, new_agreement_id, status')
        .eq('tenant_id', tenantId).eq('new_agreement_id', agreement.id).limit(3));
      const renewed = (rows || []).filter(r => r.status === 'renewed');
      if (renewed.length > 1) unverified('lineage_unverified');
      fromRenewals = renewed[0]?.previous_agreement_id || null;
    } catch (error) {
      if (error instanceof Unverified) throw error;
      if (!['42P01', 'PGRST205'].includes(error.code)) unverified('lineage_unverified');
    }
    if (fromMetadata && fromRenewals && fromMetadata !== fromRenewals) unverified('lineage_unverified');
    return fromMetadata || fromRenewals;
  }

  async function evaluate({ tenantId, memberId }) {
    const today = now().toISOString().slice(0, 10);
    try {
      const member = await read(db.from('member').select('id, tenant_id, role_id, membership_cancelled, membership_paused')
        .eq('tenant_id', tenantId).eq('id', memberId).maybeSingle());
      if (!member || member.tenant_id !== tenantId) return blocked('no_current_membership');
      if (member.membership_cancelled) return blocked('already_cancelled');
      if (member.membership_paused) return blocked('paused');
      const histories = await paged(() => db.from('member_membership_history').select('*')
        .eq('tenant_id', tenantId).eq('member_id', memberId).order('id', { ascending: true }), 1000);
      if (histories.some(h => h.member_id !== memberId || h.tenant_id !== tenantId)) unverified('lineage_unverified');
      const current = histories.filter(h => h.status === 'active' && date(h.term_start_date) <= today
        && date(h.membership_renewal_date) > today);
      if (!current.length) return blocked('no_current_membership');
      if (current.length > 1) return blocked('multiple_current_memberships');
      const source = current[0];
      if (source.organization_id || source.membership_source === 'organisation') return blocked('organisation_funded');
      if (!source.billing_agreement_id || !DD_METHODS.has(source.payment_method)) return blocked('not_direct_debit');
      if (source.commitment_snapshot?.payment_frequency === 'upfront') return blocked('not_direct_debit');
      // Another live purchase or arrangement would bypass the scheduled stop.
      if (histories.some(h => h.id !== source.id && !RETIRED_HISTORY.has(h.status || '')
        && (!h.membership_renewal_date || h.membership_renewal_date > today))) return blocked('other_purchase');
      const agreement = await read(db.from('membership_billing_agreements').select('*')
        .eq('tenant_id', tenantId).eq('member_id', memberId).eq('id', source.billing_agreement_id).maybeSingle());
      if (!agreement) return blocked('agreement_unverified');
      if (agreement.provider === 'stripe') return blocked('not_direct_debit');
      if (!ownedAgreement(agreement, tenantId, memberId)) return blocked('agreement_unverified');
      if (agreement.metadata?.dd?.kind && agreement.metadata.dd.kind !== 'monthly_direct_debit') return blocked('not_direct_debit');
      for (const table of ['member_change_authority', 'member_membership_amendment']) {
        const rows = await read(db.from(table).select('id').eq('tenant_id', tenantId).eq('source_record_id', source.id).limit(1));
        if (rows?.length) return blocked('amended_purchase');
      }
      const plans = await plansFor(tenantId, memberId, agreement.id);
      const plan = plans[0];
      if (!plan || plan.environment !== agreement.environment) return blocked('agreement_unverified');
      if (plan.interval_unit && plan.interval_unit !== 'monthly') return blocked('not_direct_debit');
      if (plan.collection_stopped_at) return blocked('collections_stopped');
      // A fixed subscription that finished after every instalment was collected
      // leaves its plan expired with a completion stamp; membership stays valid.
      const completed = planCompleted(plan);
      if (!(plan.status === 'active' || completed) || ['failed', 'charged_back', 'cancelled'].includes(plan.last_payment_status)
        || plan.grace_expires_at || !['active', 'mandate_pending', 'first_payment_pending'].includes(agreement.status)) {
        return blocked('outstanding_payments');
      }

      // Walk the uninterrupted renewal lineage back to its first consent.
      const sequence = [{ agreement, history: source, plans }];
      let cursor = sequence[0];
      for (let hop = 0; ; hop++) {
        if (hop > MAX_LINEAGE) unverified('lineage_unverified');
        const previousId = await predecessorId(tenantId, cursor.agreement);
        if (!previousId) break;
        const previous = await read(db.from('membership_billing_agreements').select('*')
          .eq('tenant_id', tenantId).eq('id', previousId).maybeSingle());
        if (!previous || !ownedAgreement(previous, tenantId, memberId)) unverified('lineage_unverified');
        const previousHistory = histories.filter(h => h.billing_agreement_id === previous.id);
        if (previousHistory.length !== 1) unverified('lineage_unverified');
        const h = previousHistory[0];
        // A genuine cancellation or a gap starts a new sequence.
        if (h.status === 'cancelled_by_request' || h.organization_id
          || date(h.membership_renewal_date) !== date(cursor.history.term_start_date)) break;
        const requests = await read(db.from('member_cancellation_request').select('id, withdrawn_at')
          .eq('tenant_id', tenantId).eq('member_id', memberId).eq('source_record_id', h.id));
        if ((requests || []).some(r => !r.withdrawn_at)) break;
        if (sequence.some(s => s.agreement.id === previous.id)) unverified('lineage_unverified');
        cursor = { agreement: previous, history: h, plans: await plansFor(tenantId, memberId, previous.id) };
        sequence.push(cursor);
      }
      // Renewed predecessors keep their agreement status, so only agreements
      // outside this uninterrupted lineage count as competing arrangements.
      const lineageIds = new Set(sequence.map(step => step.agreement.id));
      const others = await read(db.from('membership_billing_agreements').select('id, status, agreement_type')
        .eq('tenant_id', tenantId).eq('member_id', memberId).neq('id', agreement.id).limit(100));
      if (!Array.isArray(others) || others.length >= 100) unverified('lineage_unverified');
      const ended = a => histories.some(h => h.billing_agreement_id === a.id
        && (RETIRED_HISTORY.has(h.status || '') || (date(h.membership_renewal_date) && date(h.membership_renewal_date) <= today)));
      if (others.some(a => !lineageIds.has(a.id) && !ended(a) && a.agreement_type === 'member' && LIVE_AGREEMENT.has(a.status))) {
        return blocked('other_purchase');
      }
      // A predecessor that is still collecting would bypass the scheduled stop.
      if (sequence.slice(1).some(step => step.plans.some(p => LIVE_PLAN.has(p.status) && !p.collection_stopped_at))) {
        return blocked('other_purchase');
      }
      const original = sequence.at(-1);
      const threshold = consentInstalmentCount(original.agreement);
      const currentCount = consentInstalmentCount(agreement);
      if (!threshold || !currentCount) return blocked('threshold_unverified');
      // Unsettled arrears anywhere in the lineage are unresolved payments.
      const planIds = sequence.flatMap(s => s.plans.map(p => p.id));
      const arrears = await read(db.from('membership_monthly_arrears_period').select('id')
        .eq('tenant_id', tenantId).in('plan_id', planIds).is('settled_at', null).limit(1));
      if (arrears?.length) return blocked('outstanding_payments');

      let successful = 0; let inFlight = 0; let paidThisTerm = 0; const seenPayments = new Map();
      for (const step of sequence) {
        const payments = await paymentsFor(tenantId, step.plans.map(p => p.id));
        const initial = await initialPayment(tenantId, step.agreement);
        if (initial && !payments.some(p => p.gocardless_payment_id === initial.gocardless_payment_id)) {
          if (initial.plan_id && !step.plans.some(p => p.id === initial.plan_id)) unverified('lineage_unverified');
          if (initial.status === 'unknown') unverified('lineage_unverified');
          payments.push(initial);
        }
        // A provider payment can belong to only one step of the lineage.
        for (const p of payments) {
          if (seenPayments.has(p.gocardless_payment_id) && seenPayments.get(p.gocardless_payment_id) !== step) unverified('lineage_unverified');
          seenPayments.set(p.gocardless_payment_id, step);
        }
        const counted = countSuccessfulCollections(payments);
        const legacy = await legacyPayments(tenantId, memberId, step.agreement, step.history, step.plans);
        successful += counted.successful + legacy.length;
        inFlight += counted.inFlight;
        if (step === sequence[0]) {
          paidThisTerm = counted.successful + legacy.filter(l => l.period >= date(source.term_start_date)
            && l.period < date(source.membership_renewal_date)).length;
        }
      }
      const evidence = {
        sourceRecordId: source.id, agreementId: agreement.id, planId: plan.id,
        sequenceStartAgreementId: original.agreement.id, sequenceLength: sequence.length,
        lineageAgreementIds: sequence.map(step => step.agreement.id), planCompleted: completed,
        threshold, successfulCollections: successful, collectionsInFlight: inFlight,
        tierLabel: source.tier_label || null, termStartDate: date(source.term_start_date),
        renewalDate: date(source.membership_renewal_date),
      };
      if (successful < threshold) return blocked('below_threshold', { evidence });
      const coverage = resolvePaidCoverage({ termStart: evidence.termStartDate, renewalDate: evidence.renewalDate,
        instalmentCount: currentCount, paidThisTerm, today });
      if (coverage.blocker) return blocked(coverage.blocker, { evidence });

      const config = source.config_id ? await read(db.from('membership_tier_config')
        .select('id, tenant_id, dd_arrears_fallback_role_id').eq('tenant_id', tenantId).eq('id', source.config_id).maybeSingle()) : null;
      const roleId = config?.tenant_id === tenantId ? config.dd_arrears_fallback_role_id : null;
      if (!roleId) return blocked('fallback_role_missing', { evidence });
      const role = await read(db.from('role').select('id, tenant_id, name, is_tenant_admin')
        .eq('tenant_id', tenantId).eq('id', roleId).maybeSingle());
      if (!role || role.tenant_id !== tenantId || role.is_tenant_admin) return blocked('fallback_role_invalid', { evidence });
      return {
        eligible: true, blocker: null,
        evidence: { ...evidence, ...coverage, fallbackRole: { id: role.id, name: role.name || null } },
        snapshots: { source, agreement, plan, member },
      };
    } catch (error) {
      if (error instanceof Unverified) return blocked(error.blocker);
      return blocked('evidence_unavailable');
    }
  }
  return { evaluate };
}
