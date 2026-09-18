import { supabase } from '../_lib/database.js';
import { getSessionMember } from '../_lib/session.js';
import { getTenantContext, hasAdminAccess, hasFeatureAccess } from '../_lib/tenantContext.js';
import { shapePersistedCommitment } from './member-membership.js';
import { shapePlan } from './payment-plan.js';

// This endpoint is deliberately self-only, including for administrators. It
// reads retained commitments, never live pricing, provider APIs or simulations.
const HISTORY_COLUMNS = 'id, tenant_id, membership_year, tier_label, status, payment_method, billing_period, term_key, term_start_date, term_end_date, membership_renewal_date, commitment_snapshot';
// Only personal billing is supported here. Do not require organisation billing
// columns (or invoice settlement columns) to display an organisation membership.
const PERSONAL_HISTORY_COLUMNS = `${HISTORY_COLUMNS}, member_id, billing_agreement_id, payment_status`;
const ORGANISATION_HISTORY_COLUMNS = `${HISTORY_COLUMNS}, organization_id`;
const pending = new Set(['pending', 'pending_activation', 'pending_payment', 'pending_payment_setup', 'payment_setup_required', 'mandate_pending', 'first_payment_pending', 'scheduled', 'unpaid']);
const failed = new Set(['failed', 'payment_failed', 'payment_overdue', 'payment_grace_period']);
const stopped = new Set(['paused', 'cancelled', 'canceled', 'payment_plan_cancelled']);
const text = (value) => typeof value === 'string' && value.trim() ? value.trim() : null;

export function canvasDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(value)) return null;
  if (value.includes('T') && !Number.isFinite(Date.parse(value))) return null;
  const day = value.slice(0, 10);
  const parsed = new Date(`${day}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === day ? day : null;
}

function dated(record, today) {
  const commitment = shapePersistedCommitment(record, new Date(`${today}T00:00:00Z`));
  // Legacy dated terms need not carry the newer rolling commitment key or
  // snapshot. Explicit retained term dates are evidence; year/created_at aren't.
  const start = canvasDate(commitment?.startDate || record.term_start_date);
  const renewal = canvasDate(commitment?.renewalDate || record.membership_renewal_date);
  const end = canvasDate(commitment?.endDate || record.term_end_date);
  const invalidOrder = start && ((renewal && renewal <= start) || (end && end < start));
  let lifecycle = 'unknown';
  if (!invalidOrder && start) {
    if (start > today || record.status === 'scheduled') lifecycle = 'scheduled';
    else if (renewal ? today < renewal : end && today <= end) lifecycle = 'current';
    else if (renewal || end) lifecycle = 'past';
  }
  if (lifecycle === 'current' && ['expired', 'cancelled', 'canceled'].includes(record.status)) lifecycle = 'past';
  return { record, commitment, start, renewal: invalidOrder ? null : renewal, lifecycle, validCommencement: !invalidOrder };
}

export function selectCanvasCommitment(personal, organisation, today) {
  const sources = [personal, organisation].map(rows => rows.map(row => dated(row, today)));
  const descending = (a, b) => (b.start || '').localeCompare(a.start || '')
    || String(a.record.id).localeCompare(String(b.record.id));
  // Source priority applies to today's term, not the newest recorded row.
  for (const source of sources) {
    const current = source.filter(row => row.lifecycle === 'current').sort(descending)[0];
    if (current) return { ...current, source: source.map(row => row.record) };
  }
  for (const lifecycle of ['scheduled', 'past', 'unknown']) {
    for (const source of sources) {
      const candidates = source.filter(row => row.lifecycle === lifecycle).sort(descending);
      const chosen = lifecycle === 'scheduled' ? candidates.at(-1) : candidates[0];
      if (chosen) return { ...chosen, source: source.map(row => row.record) };
    }
  }
  return null;
}

function paymentMethod(record, commitment, plan) {
  const method = text(commitment?.paymentMethod || record.payment_method);
  const monthly = commitment?.paymentFrequency === 'monthly'
    || record.billing_period === 'monthly' || plan?.interval_unit === 'monthly';
  if (['monthly_direct_debit', 'gocardless_monthly', 'direct_debit_monthly'].includes(method)) return 'monthly_direct_debit';
  if (['monthly_card', 'card_monthly', 'stripe_monthly_card'].includes(method)) return 'monthly_card';
  if (['direct_debit', 'gocardless'].includes(method)) return monthly ? 'monthly_direct_debit' : 'direct_debit';
  if (['card', 'stripe'].includes(method)) return monthly ? 'monthly_card' : 'card';
  if (['bank_transfer', 'invoice'].includes(method)) return method;
  if (plan?.provider === 'gocardless') return monthly ? 'monthly_direct_debit' : 'direct_debit';
  if (plan?.provider === 'stripe') return monthly ? 'monthly_card' : 'card';
  return 'unavailable';
}

export function buildCanvasSummary({ selected, plan = null, paused = false, today }) {
  if (!selected) return {
    membership: { state: 'none', memberSince: null, membershipType: null, renewalDate: null },
    payment: { state: 'none', method: 'unavailable', nextPayment: null },
  };
  const { record, commitment, lifecycle, source } = selected;
  const starts = source.map(row => dated(row, today))
    .filter(row => row.validCommencement && row.start && row.start <= today && row.record.status !== 'scheduled')
    .map(row => row.start).sort();
  // A partial/unpaid ledger is a payment fact, not evidence that access ended.
  let membershipState = lifecycle === 'current' ? 'active'
    : lifecycle === 'scheduled' ? 'pending' : lifecycle === 'past' ? 'expired' : 'unavailable';
  if (lifecycle === 'current') {
    if (paused || record.status === 'paused') membershipState = 'paused';
    else if (['expired', 'cancelled', 'canceled'].includes(record.status)) membershipState = 'expired';
    else if (pending.has(record.status)) membershipState = 'pending';
    else if (['failed', 'activation_failed'].includes(record.status)) membershipState = 'failed';
    // Payment grace/overdue is not an access entitlement. Those statuses
    // belong to billing plans, whose arrears policy can preserve or revoke
    // access independently. Unknown history lifecycle values fail closed.
    else if (!['active', 'paid', 'partial', 'partially_paid'].includes(record.status)) membershipState = 'unavailable';
  }
  const membership = {
    state: membershipState,
    memberSince: starts[0] || null,
    membershipType: text(commitment?.tierLabel) || text(commitment?.structureName) || text(record.tier_label),
    renewalDate: selected.renewal || null,
  };
  // Organisation payer details are not supported by the member billing cards.
  if (record.membership_source === 'organisation') {
    return { membership, payment: { state: 'unavailable', method: 'unavailable', nextPayment: null } };
  }
  const method = paymentMethod(record, commitment, plan);
  if (!plan) {
    // Settlement and recurring setup are different facts. A confirmed upfront
    // payment needs no billing agreement. Never use access status, an invoice
    // reference or one paid monthly instalment as evidence of full settlement.
    const frequency = commitment?.paymentFrequency;
    const annual = (record.billing_period || commitment?.billingPeriod) === 'annual';
    const upfront = frequency === 'upfront' || (!frequency && annual);
    const monthly = record.billing_period === 'monthly' || commitment?.billingPeriod === 'monthly'
      || frequency === 'monthly';
    const paidUpfront = lifecycle === 'current' && record.payment_status === 'paid'
      && !record.billing_agreement_id && upfront && !monthly
      && ['card', 'invoice', 'bank_transfer'].includes(method);
    return { membership, payment: { state: paidUpfront ? 'paid' : 'unavailable', method, nextPayment: null } };
  }
  const status = plan.status;
  const agreementStatus = plan?.membership_billing_agreements?.status;
  let state = 'unavailable';
  if (paused || plan?.collection_stopped_at || stopped.has(status) || stopped.has(agreementStatus)) state = 'paused';
  else if (agreementStatus === 'expired') state = 'expired';
  else if (failed.has(status) || failed.has(plan?.last_payment_status)) state = 'failed';
  else if (status === 'expired' || status === 'completed') state = 'expired';
  else if (pending.has(status)) state = 'pending';
  else if (status === 'active') state = 'active';
  let nextPayment = null;
  if (plan && ['active', 'pending', 'failed'].includes(state)) {
    const next = canvasDate(shapePlan(plan).nextPlannedCollectionDate);
    if (next && next >= today) nextPayment = next;
  }
  return { membership, payment: { state, method, nextPayment } };
}

function belongsTo(row, tenantId, column, ownerId) {
  return row?.tenant_id === tenantId && row[column] === ownerId;
}

async function readHistory(db, tenantId, column, ownerId, table, source) {
  // Explicit paging prevents PostgREST's default row cap losing commencement.
  const rows = [];
  for (let offset = 0; ; offset += 500) {
    const columns = source === 'personal' ? PERSONAL_HISTORY_COLUMNS : ORGANISATION_HISTORY_COLUMNS;
    const { data, error } = await db.from(table).select(columns)
      .eq('tenant_id', tenantId).eq(column, ownerId)
      .order('id', { ascending: true }).range(offset, offset + 499);
    if (error) throw error;
    if (!Array.isArray(data) || data.some(row => !belongsTo(row, tenantId, column, ownerId))) {
      throw new Error('Membership history ownership mismatch');
    }
    rows.push(...data.map(row => ({ ...row, membership_source: source })));
    if (data.length < 500) return rows;
  }
}

async function matchingPlan(db, selected, tenantId, memberId) {
  const record = selected?.record;
  if (!record || record.membership_source !== 'personal' || !record.billing_agreement_id) return null;
  const { data: agreement, error } = await db.from('membership_billing_agreements')
    .select('id, tenant_id, member_id, organization_id, provider, status, metadata, term_key, term_start_date, commitment_snapshot')
    .eq('tenant_id', tenantId).eq('member_id', memberId)
    .eq('id', record.billing_agreement_id).maybeSingle();
  if (error) throw error;
  if (!agreement) return null;
  if (!belongsTo(agreement, tenantId, 'member_id', memberId) || agreement.organization_id
      || agreement.id !== record.billing_agreement_id) throw new Error('Billing agreement ownership mismatch');
  const key = agreement.term_key || agreement.commitment_snapshot?.term_key;
  const start = canvasDate(agreement.term_start_date || agreement.commitment_snapshot?.term_start_date);
  // Do not attach the latest member plan (or a renewed agreement) to an old term.
  const selectedKey = selected.commitment?.termKey;
  if ((key && selectedKey && key !== selectedKey) || (start && selected.start && start !== selected.start)) return null;
  if (!(key && selectedKey === key) && !(start && start === selected.start)) return null;
  const { data: plans, error: planError } = await db.from('membership_payment_plans')
    .select('id, tenant_id, member_id, organization_id, billing_agreement_id, provider, status, interval_unit, membership_year, next_charge_date, last_payment_status, collection_stopped_at, metadata')
    .eq('tenant_id', tenantId).eq('member_id', memberId)
    .eq('billing_agreement_id', agreement.id)
    .order('created_at', { ascending: false }).order('id', { ascending: false }).limit(1);
  if (planError) throw planError;
  const plan = plans?.[0];
  if (!plan) return null;
  if (!belongsTo(plan, tenantId, 'member_id', memberId) || plan.organization_id
      || plan.billing_agreement_id !== agreement.id) throw new Error('Payment plan ownership mismatch');
  if (agreement.provider && plan.provider && agreement.provider !== plan.provider) return null;
  if (plan.membership_year && record.membership_year && plan.membership_year !== record.membership_year) return null;
  const { data: arrears, error: arrearsError } = await db.from('membership_monthly_arrears_period')
    .select('tenant_id, plan_id, settled_at')
    .eq('tenant_id', tenantId).eq('plan_id', plan.id).is('settled_at', null).limit(1);
  if (arrearsError) throw arrearsError;
  if ((arrears || []).some(row => !belongsTo(row, tenantId, 'plan_id', plan.id))) throw new Error('Arrears ownership mismatch');
  return { ...plan, membership_billing_agreements: agreement, membership_monthly_arrears_period: arrears || [] };
}

export function createCanvasSummaryHandler(dependencies = {}) {
  const db = dependencies.db === undefined ? supabase : dependencies.db;
  const getMember = dependencies.getSessionMember || getSessionMember;
  const getContext = dependencies.getTenantContext || getTenantContext;
  const checkAdmin = dependencies.hasAdminAccess || hasAdminAccess;
  const checkFeature = dependencies.hasFeatureAccess || hasFeatureAccess;
  const now = dependencies.now || (() => new Date());
  return async function handler(req, res) {
    res.setHeader('Cache-Control', 'private, no-store, max-age=0');
    res.setHeader('Vary', 'Cookie, Authorization, Host');
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      return res.status(405).json({ error: 'Method not allowed' });
    }
    // No selectors are accepted, even when they repeat the session's own IDs.
    if (Object.keys(req.query || {}).length || Object.keys(req.body || {}).length) {
      return res.status(400).json({ error: 'Membership summary does not accept identity overrides or parameters' });
    }
    if (!db) return res.status(503).json({ error: 'Database not configured' });
    try {
      const [member, context] = await Promise.all([getMember(req), getContext(req)]);
      if (!member?.id) return res.status(401).json({ error: 'Member authentication required' });
      const tenantId = member.tenant_id || member.organization?.tenant_id;
      if (context?.tenantMismatch || (tenantId && context?.tenantId && tenantId !== context.tenantId)) {
        return res.status(409).json({ error: 'Tenant context mismatch' });
      }
      if (!tenantId || !context?.tenantId) return res.status(403).json({ error: 'Membership tenant context required' });
      const adminContext = !context.tenantUserId
        ? { ...context, tenantId, memberId: member.id, roleId: member.role_id || null } : context;
      if (!(await checkAdmin(adminContext)) && (!member.role_id
          || !(await checkFeature(member.role_id, 'commerce.history', member.member_excluded_features)))) {
        return res.status(403).json({ error: 'Membership history access permission required' });
      }
      const { data: owner, error } = await db.from('member')
        .select('id, tenant_id, organization_id, membership_paused')
        .eq('tenant_id', tenantId).eq('id', member.id).maybeSingle();
      if (error) throw error;
      if (!owner) return res.status(404).json({ error: 'Member not found' });
      if (!belongsTo(owner, tenantId, 'id', member.id)) throw new Error('Member ownership mismatch');
      // Organisation entitlement comes only from the current scoped member row.
      const personal = await readHistory(db, tenantId, 'member_id', member.id, 'member_membership_history', 'personal');
      const organisation = owner.organization_id
        ? await readHistory(db, tenantId, 'organization_id', owner.organization_id, 'organisation_membership_history', 'organisation') : [];
      const today = now().toISOString().slice(0, 10);
      const selected = selectCanvasCommitment(personal, organisation, today);
      const plan = await matchingPlan(db, selected, tenantId, member.id);
      return res.json(buildCanvasSummary({ selected, plan, paused: owner.membership_paused === true, today }));
    } catch {
      return res.status(500).json({ error: 'Unable to load membership summary' });
    }
  };
}

export default createCanvasSummaryHandler();