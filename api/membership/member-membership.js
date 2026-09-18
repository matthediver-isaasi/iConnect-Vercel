import { supabase } from '../_lib/database.js';
import { getSessionMember } from '../_lib/session.js';
import { getTenantContext, hasAdminAccess } from '../_lib/tenantContext.js';
import {
  findHistoricalMemberConfigs,
  getAllActiveConfigsStrict,
  getConfigByIdDirect,
  getConfigForMember,
} from '../_lib/membershipConfigResolver.js';
import { simulateMembershipForMember } from '../_lib/membershipSimulation.js';
import { calculateMembershipYearWindow, calculateNextMembershipYearWindow } from '../_lib/membershipYear.js';
import { resolveSavedCollectionPolicy } from '../../shared/gocardlessCollectionPolicy.js';
import { loadGoCardlessCollectionDetails } from '../_lib/gocardlessCollectionDetails.js';

const INSTALMENT_PAGE_SIZE = 25;
const INSTALMENT_MAX_PAGE = 1000;
const INSTALMENT_TABLE_MISSING_CODES = new Set(['42P01', '42703']);
const HISTORY_TABLE_MISSING_CODES = new Set(['42P01', 'PGRST205']);
const VALID_HISTORY_SOURCES = new Set(['personal', 'organisation']);
const GC_COLLECTED_STATUSES = ['confirmed', 'paid_out'];

function dateValue(value) {
  if (!value) return Number.NaN;
  const parsed = Date.parse(String(value).includes('T') ? value : `${value}T00:00:00.000Z`);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function firstPresent(...values) {
  return values.find((value) => value !== null && value !== undefined && value !== '') ?? null;
}

/**
 * Shape only persisted commitment fields. In particular, this helper never
 * consults the current tier configuration or a simulation: bought terms must
 * continue to describe the structure and price agreed at commencement.
 */
export function shapePersistedCommitment(record, now = new Date()) {
  const legacyDirectDebit = record?.billing_agreement_id
    && ['direct_debit', 'gocardless'].includes(record?.payment_method);
  if (!record?.term_key && !record?.membership_renewal_date && !record?.commitment_snapshot && !legacyDirectDebit) {
    return null;
  }
  const snapshot = record.commitment_snapshot && typeof record.commitment_snapshot === 'object'
    ? record.commitment_snapshot : {};
  const configSnapshot = snapshot.config && typeof snapshot.config === 'object'
    ? snapshot.config : {};
  const pricing = snapshot.pricing && typeof snapshot.pricing === 'object'
    ? snapshot.pricing : {};
  const amounts = snapshot.amounts && typeof snapshot.amounts === 'object'
    ? snapshot.amounts : {};
  const isDirectDebit = ['direct_debit', 'gocardless'].includes(
    record.payment_method || snapshot.payment_method,
  );
  const collectionPolicy = isDirectDebit
    ? resolveSavedCollectionPolicy({ ...snapshot, ...(record._ddTerms || {}) }) : null;
  const dynamic = collectionPolicy?.pricing_policy === 'dynamic';
  const startDate = firstPresent(record.term_start_date, snapshot.term_start_date);
  const renewalDate = firstPresent(record.membership_renewal_date, snapshot.membership_renewal_date);
  const today = new Date(now);
  today.setUTCHours(0, 0, 0, 0);
  const start = dateValue(startDate);
  const renewal = dateValue(renewalDate);
  let lifecycle = 'unknown';
  if (record.status === 'scheduled' || (Number.isFinite(start) && start > today.getTime())) {
    lifecycle = 'scheduled';
  } else if (Number.isFinite(start) && Number.isFinite(renewal)
      && start <= today.getTime() && today.getTime() < renewal) {
    lifecycle = 'current';
  } else if (Number.isFinite(renewal) && renewal <= today.getTime()) {
    lifecycle = 'past';
  }
  return {
    id: record.id,
    source: record.membership_source || 'personal',
    lifecycle,
    termKey: firstPresent(record.term_key, snapshot.term_key),
    startDate,
    endDate: firstPresent(record.term_end_date, snapshot.term_end_date),
    renewalDate,
    durationMonths: firstPresent(record.term_duration_months, snapshot.term_duration_months),
    anchorDate: firstPresent(record.term_anchor_date, snapshot.term_anchor_date),
    structureId: firstPresent(record.config_id, snapshot.config_id, configSnapshot.id),
    structureName: firstPresent(
      snapshot.structure_name,
      configSnapshot.name,
      record.tier_label,
    ),
    tierLabel: firstPresent(record.tier_label, pricing.tier_label, snapshot.tier_label),
    billingPeriod: firstPresent(snapshot.billing_period, configSnapshot.billing_period),
    agreedPrice: dynamic ? null : firstPresent(
      amounts.total_with_vat,
      amounts.final_cost,
      pricing.total_with_vat,
      pricing.final_cost,
      record.total_with_vat,
      record.final_cost,
    ),
    agreedNetPrice: dynamic ? null : firstPresent(amounts.final_cost, pricing.final_cost, record.final_cost),
    monthlyAmount: dynamic ? null : firstPresent(amounts.monthly_amount, pricing.monthly_amount, record._ddTerms?.monthly_amount),
    ...(isDirectDebit ? { collectionPolicy, collectionDetails: record._collectionDetails || null } : {}),
    currency: firstPresent(amounts.currency, pricing.currency, record.currency),
    paymentFrequency: firstPresent(
      record.payment_frequency,
      snapshot.payment_frequency,
      snapshot.collection_frequency,
    ),
    paymentMethod: firstPresent(record.payment_method, snapshot.payment_method),
    status: record.status || null,
  };
}

export function shapePersistedCommitments(history, now = new Date()) {
  return (history || [])
    .map((record) => shapePersistedCommitment(record, now))
    .filter(Boolean)
    .sort((left, right) => {
      const startDifference = dateValue(right.startDate) - dateValue(left.startDate);
      if (Number.isFinite(startDifference) && startDifference !== 0) return startDifference;
      return String(left.id || '').localeCompare(String(right.id || ''));
    });
}

/**
 * Enrich only an already-authorized owner's displayed terms. Neither a live
 * structure nor an unrelated agreement may supply consent for this read.
 */
export async function enrichDirectDebitCommitments({ db, tenantId, history, commitments, paused = false }) {
  const visible = commitments.filter((item) => ['current', 'scheduled', 'unknown'].includes(item.lifecycle)).slice(0, 20);
  for (const commitment of visible) {
    const record = history.find((row) => row.id === commitment.id
      && (row.membership_source || 'personal') === commitment.source);
    if (!record?.billing_agreement_id
      || !['direct_debit', 'gocardless'].includes(commitment.paymentMethod)) continue;
    try {
      const { data: agreement, error } = await db.from('membership_billing_agreements')
        .select('id,tenant_id,member_id,organization_id,provider,status,metadata')
        .eq('tenant_id', tenantId).eq('id', record.billing_agreement_id).maybeSingle();
      if (error || !agreementMatchesHistory(agreement, record, commitment.source)
        || (agreement.provider && agreement.provider !== 'gocardless')) throw new Error('Agreement evidence unavailable');
      const planResult = await db.from('membership_payment_plans')
        .select('*,membership_monthly_arrears_period(due_period,amount_minor,settled_at)')
        .eq('tenant_id', tenantId).eq('billing_agreement_id', agreement.id)
        .order('created_at', { ascending: false }).limit(1).maybeSingle();
      if (planResult.error) throw planResult.error;
      if (planResult.data && !planMatchesAgreement(planResult.data, agreement, record)) {
        throw new Error('Plan ownership does not match');
      }
      const terms = agreement.metadata?.dd || {};
      commitment.collectionPolicy = resolveSavedCollectionPolicy(terms);
      commitment.collectionDetails = await loadGoCardlessCollectionDetails({
        db, tenantId, agreement, plan: planResult.data, paused,
      });
      if (!commitment.startDate || !commitment.endDate) {
        commitment.collectionDetails.blockers.push('Membership term dates are not evidenced; administrator review is required');
      }
      if (commitment.collectionPolicy.pricing_policy === 'dynamic') {
        commitment.agreedPrice = null;
        commitment.agreedNetPrice = null;
        commitment.monthlyAmount = null;
      } else if (commitment.monthlyAmount == null && terms.monthly_amount != null) {
        commitment.monthlyAmount = Number(terms.monthly_amount);
      }
    } catch {
      commitment.collectionDetails = {
        state: 'unknown', amount: null, currency: commitment.currency,
        dueDate: null, providerStatus: null,
        blockers: ['Current collection evidence could not be loaded'],
      };
    }
  }
  return commitments;
}

/**
 * The member-detail page only needs a bounded window of the accounting
 * ledger.  Do not accept a caller supplied limit: changing the page size
 * would make both the response and the cost of this endpoint unbounded.
 */
function parseInstalmentPage(value) {
  if (value === undefined || value === null || value === '') return 1;
  if (Array.isArray(value) || !/^\d+$/.test(String(value))) return null;
  const page = Number(value);
  if (!Number.isSafeInteger(page) || page < 1 || page > INSTALMENT_MAX_PAGE) return null;
  return page;
}

function normaliseProvider(provider) {
  if (provider === 'stripe' || provider === 'gocardless') return provider;
  return null;
}

function agreementSnapshot(agreement) {
  const provider = normaliseProvider(agreement?.provider);
  const source = provider === 'stripe' ? 'card' : provider === 'gocardless' ? 'dd' : null;
  const snapshot = agreement?.metadata?.[source]
    || agreement?.metadata?.dd
    || agreement?.metadata?.card
    || {};
  return { provider, source, snapshot };
}

function toMinor(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function amountFromMinor(value) {
  const minor = toMinor(value);
  return minor === null ? null : minor / 100;
}

function sanitizeAccountingSyncReason(value) {
  if (typeof value !== 'string') return null;
  const sanitized = value
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
  return sanitized || null;
}

function accountingSyncDetails(row) {
  const status = row?.accounting_sync_status || null;
  const persistedReason = ['failed', 'skipped', 'invoice_unpaid'].includes(status)
    ? sanitizeAccountingSyncReason(row?.accounting_sync_error)
    : null;
  const missingProvider = status === 'skipped'
    && (!row?.accounting_provider
      || /no accounting provider connected/i.test(persistedReason || ''));
  const reason = missingProvider && !persistedReason
    ? 'no accounting provider connected'
    : persistedReason;
  return {
    state: missingProvider ? 'missing_provider' : status,
    reason,
    missingProvider,
  };
}

function historyBelongsToMember(record, source, member) {
  if (!record || !member) return false;
  if (source === 'personal') return record.member_id === member.id;
  return !!member.organization_id && record.organization_id === member.organization_id;
}

function agreementMatchesHistory(agreement, record, source) {
  if (!agreement || agreement.tenant_id !== record.tenant_id) return false;
  if (source === 'personal') {
    return agreement.member_id === record.member_id
      && !agreement.organization_id;
  }
  return agreement.organization_id === record.organization_id
    && !agreement.member_id;
}

function planMatchesAgreement(plan, agreement, record) {
  if (!plan || plan.tenant_id !== agreement.tenant_id
      || plan.billing_agreement_id !== agreement.id) return false;
  if (record.member_id && plan.member_id && plan.member_id !== record.member_id) return false;
  if (record.organization_id && plan.organization_id
      && plan.organization_id !== record.organization_id) return false;
  return true;
}

function instalmentInvoiceUrl(recordId, source, paymentRef) {
  const params = new URLSearchParams({
    source,
    instalment: 'true',
    paymentRef,
  });
  return `/api/membership-invoice/${encodeURIComponent(recordId)}?${params.toString()}`;
}

function applyDeterministicPage(query, page) {
  const offset = (page - 1) * INSTALMENT_PAGE_SIZE;
  const last = offset + INSTALMENT_PAGE_SIZE - 1;
  if (typeof query.range === 'function') return query.range(offset, last);
  // This fallback is for light endpoint mocks and old PostgREST clients. The
  // production Supabase client always has range(), so production reads remain
  // bounded at the database.
  return typeof query.limit === 'function' ? query.limit(INSTALMENT_PAGE_SIZE) : query;
}

function applyOrder(query, columns) {
  let result = query;
  for (const column of columns) {
    if (typeof result.order === 'function') {
      result = result.order(column.name, { ascending: column.ascending });
    }
  }
  return result;
}

async function fetchOneHistoryRecord(db, source, recordId, tenantId) {
  const table = source === 'personal'
    ? 'member_membership_history'
    : 'organisation_membership_history';
  const ownerColumn = source === 'personal' ? 'member_id' : 'organization_id';
  const ownerSelect = source === 'personal' ? 'member_id' : 'organization_id';
  const { data, error } = await db
    .from(table)
    .select(`id, tenant_id, ${ownerSelect}, membership_year, billing_period, billing_agreement_id, term_start_date, term_end_date, membership_renewal_date, term_duration_months, term_anchor_date, term_key, commitment_snapshot`)
    .eq('id', recordId)
    .eq('tenant_id', tenantId)
    .maybeSingle();
  if (error) throw error;
  return data ? { ...data, membership_source: source, _ownerColumn: ownerColumn } : null;
}

async function fetchPlanForAgreement(db, agreementId, tenantId) {
  let query = db
    .from('membership_payment_plans')
    .select('id, tenant_id, billing_agreement_id, member_id, organization_id, provider, status, amount_minor, currency, membership_year, instalments_total, instalments_paid, created_at')
    .eq('tenant_id', tenantId)
    .eq('billing_agreement_id', agreementId);
  query = applyOrder(query, [
    { name: 'created_at', ascending: false },
    { name: 'id', ascending: false },
  ]);
  if (typeof query.limit === 'function') query = query.limit(1);
  const { data, error } = await query;
  if (error) throw error;
  return Array.isArray(data) ? (data[0] || null) : data || null;
}

function shapeStripeInstalment(row, record, source) {
  const paymentRef = row.external_payment_id || row.id;
  const invoiceId = row.accounting_invoice_id || row.xero_invoice_id || null;
  const invoiceNumber = row.accounting_invoice_number || row.xero_invoice_number || null;
  const accountingSync = accountingSyncDetails(row);
  return {
    id: row.id || null,
    paymentRef,
    provider: 'stripe',
    status: row.accounting_sync_status || null,
    amountMinor: toMinor(row.amount_minor),
    amount: amountFromMinor(row.amount_minor),
    currency: row.currency || null,
    date: row.accounting_synced_at || row.created_at || null,
    createdAt: row.created_at || null,
    invoiceId,
    invoiceNumber,
    accountingInvoiceId: invoiceId,
    accountingInvoiceNumber: invoiceNumber,
    accountingProvider: row.accounting_provider || null,
    accountingSyncStatus: row.accounting_sync_status || null,
    accountingSyncState: accountingSync.state,
    accountingSyncReason: accountingSync.reason,
    accountingSyncError: accountingSync.reason,
    missingProvider: accountingSync.missingProvider,
    reason: accountingSync.reason,
    syncStatus: row.accounting_sync_status || null,
    syncState: accountingSync.state,
    syncReason: accountingSync.reason,
    syncError: accountingSync.reason,
    invoiceUrl: invoiceId ? instalmentInvoiceUrl(record.id, source, paymentRef) : null,
  };
}

function shapeGoCardlessInstalment(row, record, source, currency) {
  const paymentRef = row.gocardless_payment_id || row.id;
  const invoiceId = row.accounting_invoice_id || row.xero_invoice_id || null;
  const invoiceNumber = row.accounting_invoice_number || row.xero_invoice_number || null;
  const accountingSync = accountingSyncDetails(row);
  return {
    id: row.id || null,
    paymentRef,
    provider: 'gocardless',
    status: row.status || null,
    amountMinor: toMinor(row.amount_minor),
    amount: amountFromMinor(row.amount_minor),
    currency: row.currency || currency || null,
    date: row.confirmed_at || row.charge_date || row.created_at || null,
    chargeDate: row.charge_date || null,
    createdAt: row.created_at || null,
    invoiceId,
    invoiceNumber,
    accountingInvoiceId: invoiceId,
    accountingInvoiceNumber: invoiceNumber,
    accountingProvider: row.accounting_provider || null,
    accountingSyncStatus: row.accounting_sync_status || null,
    accountingSyncState: accountingSync.state,
    accountingSyncReason: accountingSync.reason,
    accountingSyncError: accountingSync.reason,
    missingProvider: accountingSync.missingProvider,
    reason: accountingSync.reason,
    syncStatus: row.accounting_sync_status || null,
    syncState: accountingSync.state,
    syncReason: accountingSync.reason,
    syncError: accountingSync.reason,
    invoiceUrl: invoiceId ? instalmentInvoiceUrl(record.id, source, paymentRef) : null,
  };
}

async function loadInstalmentAccounting({
  db,
  record,
  source,
  tenantId,
  agreement,
  plan,
  page,
}) {
  const { provider, source: snapshotSource, snapshot } = agreementSnapshot(agreement);
  if (!provider) {
    throw new Error('Unsupported membership billing agreement provider');
  }
  const parsedPlanCollectedCount = plan?.instalments_paid == null
    ? null
    : Number(plan.instalments_paid);
  const planCollectedCount = Number.isFinite(parsedPlanCollectedCount)
    ? parsedPlanCollectedCount
    : null;
  const baseLedger = {
    provider,
    source: provider === 'stripe'
      ? 'membership_instalment_invoices'
      : 'gocardless_payments',
    state: 'missing',
    missing: true,
    totalCount: 0,
    entries: [],
  };

  if (!plan && provider !== 'stripe') {
    return {
      provider,
      snapshotSource,
      snapshot,
      planCollectedCount,
      ledger: baseLedger,
    };
  }

  let result;
  if (provider === 'stripe') {
    let query = db
      .from('membership_instalment_invoices')
      .select('id, tenant_id, plan_id, billing_agreement_id, external_payment_id, amount_minor, currency, accounting_provider, accounting_invoice_id, accounting_invoice_number, xero_invoice_id, xero_invoice_number, accounting_sync_status, accounting_sync_error, accounting_synced_at, created_at', { count: 'exact' })
      .eq('tenant_id', tenantId)
      .eq('billing_agreement_id', agreement.id);
    query = applyOrder(query, [
      { name: 'created_at', ascending: true },
      { name: 'external_payment_id', ascending: true },
      { name: 'id', ascending: true },
    ]);
    query = applyDeterministicPage(query, page);
    result = await query;
  } else {
    const planIds = plan ? [plan.id] : [];
    if (planIds.length === 0) return { provider, snapshotSource, snapshot, planCollectedCount: 0, ledger: baseLedger };
    let query = db
      .from('gocardless_payments')
      .select('id, tenant_id, plan_id, gocardless_payment_id, amount_minor, currency, status, charge_date, confirmed_at, accounting_provider, accounting_invoice_id, accounting_invoice_number, xero_invoice_id, xero_invoice_number, accounting_sync_status, accounting_sync_error, accounting_synced_at, created_at', { count: 'exact' })
      .eq('tenant_id', tenantId)
      .in('plan_id', planIds)
      .in('status', GC_COLLECTED_STATUSES);
    query = applyOrder(query, [
      { name: 'charge_date', ascending: true },
      { name: 'created_at', ascending: true },
      { name: 'gocardless_payment_id', ascending: true },
      { name: 'id', ascending: true },
    ]);
    query = applyDeterministicPage(query, page);
    result = await query;
  }

  if (result?.error) {
    if (INSTALMENT_TABLE_MISSING_CODES.has(result.error.code)) {
      return {
        provider,
        snapshotSource,
        snapshot,
        planCollectedCount,
        ledger: {
          ...baseLedger,
          state: 'missing',
          error: 'Instalment accounting ledger is not available',
        },
      };
    }
    throw result.error;
  }

  const rows = Array.isArray(result?.data) ? result.data : [];
  const totalCount = Number.isFinite(Number(result?.count))
    ? Number(result.count)
    : rows.length;
  const entries = provider === 'stripe'
    ? rows.map((row) => shapeStripeInstalment(row, record, source))
    : rows.map((row) => shapeGoCardlessInstalment(row, record, source, plan?.currency));
  return {
    provider,
    snapshotSource,
    snapshot,
    planCollectedCount: planCollectedCount ?? totalCount,
    ledger: {
      provider,
      source: baseLedger.source,
      state: totalCount > 0 ? 'present' : 'empty',
      missing: false,
      totalCount,
      entries,
    },
  };
}

async function handleInstalmentGet(req, res, {
  db,
  tenantId,
  tenantContext,
  getMember,
  checkAdmin,
}) {
  const query = req.query || {};
  const { recordId } = query;
  if (!recordId || Array.isArray(recordId)) {
    return res.status(400).json({ error: 'recordId is required' });
  }
  if (query.instalments !== 'true' && query.instalments !== true) {
    return res.status(400).json({ error: 'instalments=true is required for instalment accounting' });
  }
  const page = parseInstalmentPage(query.page);
  if (!page) {
    return res.status(400).json({
      error: `page must be an integer between 1 and ${INSTALMENT_MAX_PAGE}`,
    });
  }
  const requestedSource = query.source;
  if (requestedSource !== undefined
      && (Array.isArray(requestedSource) || !VALID_HISTORY_SOURCES.has(requestedSource))) {
    return res.status(400).json({ error: 'Invalid membership source' });
  }

  if (tenantContext?.tenantMismatch) {
    return res.status(409).json({ error: 'Tenant context mismatch' });
  }
  const sessionMember = await getMember(req);
  const sessionTenantId = sessionMember?.tenant_id
    || sessionMember?.organization?.tenant_id
    || null;
  if (sessionTenantId && tenantId && sessionTenantId !== tenantId) {
    return res.status(409).json({ error: 'Tenant context mismatch' });
  }
  const adminContext = sessionMember && !tenantContext?.tenantUserId
    ? {
      ...tenantContext,
      tenantId,
      memberId: sessionMember.id,
      roleId: sessionMember.role_id || null,
    }
    : tenantContext;
  const isAdmin = await checkAdmin(adminContext);
  if (!isAdmin && !sessionMember) {
    return res.status(403).json({ error: 'Admin or owning member access required' });
  }

  const sources = requestedSource ? [requestedSource] : ['personal', 'organisation'];
  const records = (await Promise.all(
    sources.map((source) => fetchOneHistoryRecord(db, source, recordId, tenantId)),
  )).filter(Boolean);
  if (records.length === 0) {
    return res.status(404).json({ error: 'Membership history record not found' });
  }

  const candidate = records.find((record) => (
    isAdmin || historyBelongsToMember(record, record.membership_source, sessionMember)
  ));
  if (!candidate) {
    return res.status(403).json({ error: 'Not authorized to view this membership record' });
  }

  if (!candidate.billing_agreement_id) {
    return res.json({
      record: {
        id: candidate.id,
        source: candidate.membership_source,
        membershipYear: candidate.membership_year || null,
        billingPeriod: candidate.billing_period || 'annual',
        billingAgreementId: null,
        commitment: shapePersistedCommitment(candidate),
      },
      agreement: null,
      modeSnapshot: {
        provider: null,
        source: null,
        invoicingMode: 'annual',
        invoicing_mode: 'annual',
      },
      plan: null,
      planCollectedCount: null,
      ledger: {
        provider: null,
        source: null,
        state: 'not_applicable',
        missing: false,
        totalCount: 0,
        entries: [],
      },
      instalments: [],
      pagination: {
        page,
        pageSize: INSTALMENT_PAGE_SIZE,
        totalCount: 0,
        hasNextPage: false,
      },
    });
  }

  const { data: agreement, error: agreementError } = await db
    .from('membership_billing_agreements')
    .select('id, tenant_id, member_id, organization_id, agreement_type, provider, status, metadata, term_start_date, term_end_date, membership_renewal_date, term_duration_months, term_anchor_date, term_key, commitment_snapshot')
    .eq('id', candidate.billing_agreement_id)
    .eq('tenant_id', tenantId)
    .maybeSingle();
  if (agreementError) throw agreementError;
  if (!agreement || !agreementMatchesHistory(agreement, candidate, candidate.membership_source)) {
    return res.status(403).json({ error: 'Membership billing agreement ownership mismatch' });
  }
  if (!['stripe', 'gocardless'].includes(agreement.provider)) {
    return res.status(500).json({ error: 'Unsupported membership billing agreement provider' });
  }

  const plan = await fetchPlanForAgreement(db, agreement.id, tenantId);
  if (plan && !planMatchesAgreement(plan, agreement, candidate)) {
    return res.status(403).json({ error: 'Membership payment plan ownership mismatch' });
  }
  const accounting = await loadInstalmentAccounting({
    db,
    record: candidate,
    source: candidate.membership_source,
    tenantId,
    agreement,
    plan,
    page,
  });
  const snapshotMode = accounting.snapshot?.invoicing_mode
    || accounting.snapshot?.invoicingMode;
  const mode = snapshotMode === 'per_instalment'
    ? 'per_instalment'
    : 'annual';
  const totalCount = accounting.ledger.totalCount;
  const modeSnapshot = {
    ...accounting.snapshot,
    provider: accounting.provider,
    source: accounting.snapshotSource,
    invoicingMode: mode,
    invoicing_mode: mode,
    membershipYear: accounting.snapshot?.membership_year
      || accounting.snapshot?.membershipYear
      || candidate.membership_year
      || null,
    instalmentCount: accounting.snapshot?.instalment_count
      || accounting.snapshot?.dd_instalment_count
      || accounting.snapshot?.instalmentCount
      || plan?.instalments_total
      || null,
    amountMinor: accounting.snapshot?.monthly_amount_minor
      || accounting.snapshot?.instalment_amount_minor
      || accounting.snapshot?.amountMinor
      || plan?.amount_minor
      || null,
    currency: accounting.snapshot?.currency || plan?.currency || null,
  };
  const responsePlan = plan ? {
    id: plan.id,
    status: plan.status || null,
    amountMinor: toMinor(plan.amount_minor),
    currency: plan.currency || null,
    instalmentsTotal: plan.instalments_total ?? null,
    instalmentsPaid: plan.instalments_paid ?? null,
    collectedCount: accounting.planCollectedCount,
    membershipYear: plan.membership_year || null,
  } : null;
  return res.json({
    record: {
      id: candidate.id,
      source: candidate.membership_source,
      membershipYear: candidate.membership_year || null,
      billingPeriod: candidate.billing_period || null,
      memberId: candidate.member_id || null,
      organizationId: candidate.organization_id || null,
      billingAgreementId: agreement.id,
      commitment: shapePersistedCommitment(candidate),
    },
    agreement: {
      id: agreement.id,
      tenantId: agreement.tenant_id,
      memberId: agreement.member_id || null,
      organizationId: agreement.organization_id || null,
      provider: accounting.provider,
      status: agreement.status || null,
      mode: mode,
      modeSnapshot: accounting.snapshot,
      commitment: shapePersistedCommitment({
        ...candidate,
        term_start_date: agreement.term_start_date || candidate.term_start_date,
        term_end_date: agreement.term_end_date || candidate.term_end_date,
        membership_renewal_date: agreement.membership_renewal_date || candidate.membership_renewal_date,
        term_duration_months: agreement.term_duration_months || candidate.term_duration_months,
        term_anchor_date: agreement.term_anchor_date || candidate.term_anchor_date,
        term_key: agreement.term_key || candidate.term_key,
        commitment_snapshot: agreement.commitment_snapshot
          || agreement.metadata?.commitment
          || candidate.commitment_snapshot,
      }),
    },
    modeSnapshot,
    plan: responsePlan,
    planCollectedCount: accounting.planCollectedCount,
    ledger: {
      ...accounting.ledger,
      entries: accounting.ledger.entries,
    },
    instalments: accounting.ledger.entries,
    pagination: {
      page,
      pageSize: INSTALMENT_PAGE_SIZE,
      totalCount,
      hasNextPage: page * INSTALMENT_PAGE_SIZE < totalCount,
    },
  });
}

export function createMemberMembershipHandler(dependencies = {}) {
  const db = dependencies.db === undefined ? supabase : dependencies.db;
  const getContext = dependencies.getTenantContext || getTenantContext;
  const getMember = dependencies.getSessionMember || getSessionMember;
  const checkAdmin = dependencies.hasAdminAccess || hasAdminAccess;
  const resolveConfig = dependencies.getConfigForMember || getConfigForMember;
  const resolveConfigById = dependencies.getConfigByIdDirect || getConfigByIdDirect;
  const resolveActiveConfigs = dependencies.getAllActiveConfigs || getAllActiveConfigsStrict;
  const simulateMember = dependencies.simulateMembershipForMember || simulateMembershipForMember;

  return async function handler(req, res) {
    if (!db) {
      return res.status(500).json({ error: 'Database not configured' });
    }

    try {
      const tenantContext = await getContext(req);
      if (tenantContext?.tenantMismatch) {
        return res.status(409).json({ error: 'Tenant context mismatch' });
      }
      if (!tenantContext?.tenantId) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      const { tenantId } = tenantContext;

      if (req.method === 'GET') {
        if (req.query?.recordId !== undefined) {
          return await handleInstalmentGet(req, res, {
            db,
            tenantId,
            tenantContext,
            getMember,
            checkAdmin,
          });
        }
        return await handleGet(req, res, tenantId, db, {
          tenantContext,
          getMember,
          checkAdmin,
          resolveConfig,
          resolveConfigById,
          resolveActiveConfigs,
          simulateMember,
        });
      }

      return res.status(405).json({ error: 'Method not allowed' });
    } catch (error) {
      console.error('[Member Membership] Error:', error);
      return res.status(500).json({ error: 'Internal server error' });
    }
  };
}

export default createMemberMembershipHandler();

function mapSimResultToYearData(sim, startDate) {
  const effectiveFreeDiscount = sim.yearNumber === 2 ? (sim.rolloverDiscount || 0) : (sim.freeDiscount || 0);
  return {
    membershipYear: sim.membershipYear?.label || null,
    yearNumber: sim.yearNumber,
    startDate,
    tierLabel: sim.tierLabel || null,
    fieldValue: sim.fieldValue,
    annualCost: sim.annualCost,
    annualCostBeforeDiscounts: sim.annualCostBeforeDiscounts,
    customDiscountTotal: sim.customDiscountTotal || 0,
    customDiscountDetails: sim.customDiscountDetails || [],
    dailyCost: sim.dailyCost,
    totalDaysInYear: sim.totalDaysInYear,
    proRataEnabled: sim.proRataEnabled,
    prorataDays: sim.prorataDays,
    prorataCost: sim.prorataCost,
    freeDiscount: effectiveFreeDiscount,
    freePeriodDaysApplied: sim.freePeriodDaysApplied || 0,
    freePeriodAmount: sim.freePeriodAmount,
    freePeriodUnit: sim.freePeriodUnit,
    billableDays: sim.billableDays,
    finalCost: sim.finalCost,
    vatRatePercent: sim.vatRatePercent || null,
    vatAmount: sim.vatAmount || 0,
    totalWithVat: sim.totalWithVat || sim.finalCost,
    taxType: sim.taxType || null,
    taxLabel: sim.taxLabel || null,
    isNewMember: sim.isNewMember,
    currency: sim.currency || 'GBP',
    billingPeriod: sim.billingPeriod || 'annual',
    overrideApplied: sim.overrideApplied || false,
    overrideType: sim.overrideType || null,
    overrideNote: sim.overrideNote || null,
    overrideDiscountType: sim.overrideDiscountType || null,
    overrideDiscountValue: sim.overrideDiscountValue,
    overrideConfigId: sim.overrideConfigId || null,
    overrideConfigName: sim.overrideConfigName || null,
    originalAnnualCost: sim.overrideApplied ? sim.annualCostBeforeDiscounts : undefined,
  };
}

function hasValue(value) {
  return value !== null && value !== undefined && String(value).trim() !== '';
}

/**
 * Detect a current member selector without treating unrelated member
 * preferences as a tier selection. A historical paid snapshot is only safe
 * to display when there is no explicit current selector for any active
 * member-scoped structure (or for the recorded structure itself).
 */
async function hasExplicitMemberTierSelector(db, tenantId, memberId, configs = [], historicalConfig = null) {
  const selectorConfigs = (Array.isArray(configs) ? configs : [])
    .filter((config) => config?.structure_scope_type === 'member' && config?.structure_field_id)
    .filter((config, index, all) => (
      all.findIndex((candidate) => candidate.structure_field_id === config.structure_field_id) === index
    ));
  if (selectorConfigs.length === 0) return false;

  const coreConfigs = selectorConfigs.filter((config) => config.structure_field_id.startsWith('core:'));
  const customFieldIds = selectorConfigs
    .filter((config) => !config.structure_field_id.startsWith('core:'))
    .map((config) => config.structure_field_id);
  const values = new Map();

  if (coreConfigs.length > 0) {
    const columns = ['id', ...coreConfigs.map((config) => config.structure_field_id.slice(5))];
    const { data: memberRow, error } = await db
      .from('member')
      .select([...new Set(columns)].join(', '))
      .eq('id', memberId)
      .eq('tenant_id', tenantId)
      .maybeSingle();
    // A failed selector read must fail closed: displaying an old paid
    // snapshot over an explicit current selector is worse than showing no
    // live tier.
    if (error) return true;
    for (const config of coreConfigs) {
      const column = config.structure_field_id.slice(5);
      if (hasValue(memberRow?.[column])) values.set(config.structure_field_id, memberRow[column]);
    }
  }

  if (customFieldIds.length > 0) {
    const { data: preferenceRows, error } = await db
      .from('member_preference_value')
      .select('field_id, value')
      .eq('member_id', memberId)
      .in('field_id', customFieldIds);
    if (error) return true;
    for (const row of preferenceRows || []) {
      if (hasValue(row?.value)) values.set(row.field_id, row.value);
    }
  }

  const historicalFieldId = historicalConfig?.structure_field_id || null;
  const historicalMatch = historicalConfig?.structure_match_value;
  for (const [fieldId, value] of values) {
    // A persisted value matching the recorded structure is not a new
    // selection. Any value on another active selector, or a changed value on
    // the recorded selector, must win over an old paid snapshot.
    if (fieldId !== historicalFieldId) return true;
    if (String(value).toLowerCase().trim() !== String(historicalMatch ?? '').toLowerCase().trim()) {
      return true;
    }
  }
  return false;
}

function isTenantMemberConfig(config, tenantId) {
  return !!config
    && (!config.tenant_id || config.tenant_id === tenantId)
    && config.structure_scope_type === 'member';
}

async function handleGet(req, res, tenantId, db = supabase, {
  tenantContext = null,
  getMember = getSessionMember,
  checkAdmin = hasAdminAccess,
  resolveConfig = getConfigForMember,
  resolveConfigById = getConfigByIdDirect,
  resolveActiveConfigs = getAllActiveConfigsStrict,
  simulateMember = simulateMembershipForMember,
} = {}) {
  const { memberId } = req.query;

  if (!memberId || Array.isArray(memberId)) {
    return res.status(400).json({ error: 'memberId is required' });
  }

  // A tenant context establishes the database scope, not the member whose
  // record may be read. A portal member can only request their own ID;
  // tenant admins are the only callers allowed to inspect another member.
  // Resolve the session before querying `member` so a same-tenant memberId
  // cannot become an IDOR primitive.
  if (tenantContext?.tenantMismatch) {
    return res.status(409).json({ error: 'Tenant context mismatch' });
  }
  const sessionMember = await getMember(req);
  const sessionTenantId = sessionMember?.tenant_id
    || sessionMember?.organization?.tenant_id
    || null;
  if (sessionTenantId && tenantId && sessionTenantId !== tenantId) {
    return res.status(409).json({ error: 'Tenant context mismatch' });
  }
  const adminContext = sessionMember && !tenantContext?.tenantUserId
    ? {
      ...tenantContext,
      tenantId,
      memberId: sessionMember.id,
      roleId: sessionMember.role_id || null,
    }
    : tenantContext;
  const isAdmin = await checkAdmin(adminContext);
  if (!isAdmin && !sessionMember) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  if (!isAdmin && sessionMember.id !== memberId) {
    return res.status(403).json({ error: 'Not authorized to view this member' });
  }

  const { data: member } = await db
    .from('member')
    .select('id, first_name, last_name, email, tenant_id, organization_id')
    .eq('id', memberId)
    .eq('tenant_id', tenantId)
    .maybeSingle();

  if (!member) {
    return res.status(404).json({ error: 'Member not found' });
  }

  // Task #3586: expose membership pause state (read-only) so the membership
  // card can render the paused banner. Fetched separately + 42703-tolerant
  // because the pause columns exist on the production database only.
  let pause = null;
  {
    const { data: pauseRow, error: pauseError } = await db
      .from('member')
      .select('membership_paused, membership_paused_at, membership_pause_restart_date, membership_paused_by, membership_pause_reason')
      .eq('id', memberId)
      .eq('tenant_id', tenantId)
      .maybeSingle();
    if (!pauseError && pauseRow) {
      pause = {
        paused: pauseRow.membership_paused === true,
        pausedAt: pauseRow.membership_paused_at || null,
        restartDate: pauseRow.membership_pause_restart_date || null,
        pausedBy: pauseRow.membership_paused_by || null,
        reason: pauseRow.membership_pause_reason || null,
      };
    }
  }

  let personalHistory = [];
  let organisationHistory = [];
  try {
    const { data: historyRecords, error: historyError } = await db
      .from('member_membership_history')
      .select('*')
      .eq('tenant_id', tenantId)
      .eq('member_id', memberId)
      .order('membership_year', { ascending: false });
    if (historyError) throw historyError;
    personalHistory = (historyRecords || []).map((record) => ({
      ...record,
      membership_source: 'personal',
    }));
  } catch (err) {
    if (!HISTORY_TABLE_MISSING_CODES.has(err?.code)) throw err;
    console.log('[Member Membership] Personal history table may not exist yet:', err.message);
  }

  // A member can have both a personal ledger and a ledger owned by their
  // current organisation. Keep both rows in the member tab, but tag the
  // source explicitly so monthly detail requests cannot accidentally resolve
  // an organisation row against the personal history table (or vice versa).
  // The organisation lookup is always constrained by the authenticated
  // tenant and the organisation attached to the already-authorized member
  // row. It never trusts an organisation id supplied by the caller.
  if (member.organization_id) {
    try {
      const { data: historyRecords, error: historyError } = await db
        .from('organisation_membership_history')
        .select('*')
        .eq('tenant_id', tenantId)
        .eq('organization_id', member.organization_id)
        .order('membership_year', { ascending: false });
      if (historyError) throw historyError;
      organisationHistory = (historyRecords || []).map((record) => ({
        ...record,
        membership_source: 'organisation',
      }));
    } catch (err) {
      if (!HISTORY_TABLE_MISSING_CODES.has(err?.code)) throw err;
      console.log('[Member Membership] Organisation history table may not exist yet:', err.message);
    }
  }
  const history = [...personalHistory, ...organisationHistory].sort((left, right) => {
    const leftTermStart = dateValue(left.term_start_date);
    const rightTermStart = dateValue(right.term_start_date);
    if ((Number.isFinite(leftTermStart) || Number.isFinite(rightTermStart))
        && leftTermStart !== rightTermStart) {
      if (!Number.isFinite(leftTermStart)) return 1;
      if (!Number.isFinite(rightTermStart)) return -1;
      return rightTermStart - leftTermStart;
    }
    const leftYear = Number.parseInt(String(left.membership_year || ''), 10);
    const rightYear = Number.parseInt(String(right.membership_year || ''), 10);
    if (Number.isFinite(leftYear) && Number.isFinite(rightYear) && leftYear !== rightYear) {
      return rightYear - leftYear;
    }
    // Keep personal rows first for a shared year, matching the pre-existing
    // member-scoped history order while still returning one unified ledger.
    if (left.membership_source !== right.membership_source) {
      return left.membership_source === 'personal' ? -1 : 1;
    }
    return String(left.id || '').localeCompare(String(right.id || ''));
  });
  const commitments = shapePersistedCommitments(history);
  await enrichDirectDebitCommitments({ db, tenantId, history, commitments, paused: pause?.paused });
  const currentCommitments = commitments.filter((commitment) => (
    commitment.lifecycle === 'current' || commitment.lifecycle === 'scheduled'
    || (commitment.lifecycle === 'unknown'
      && commitment === commitments.find((item) => item.source === commitment.source)
      && ['direct_debit', 'gocardless'].includes(commitment.paymentMethod))
  ));

  const liveConfig = await resolveConfig(tenantId, memberId);
  let config = liveConfig;
  let historicalSnapshot = null;
  let activeMemberConfigs = [];
  let activeConfigLookupFailed = false;
  if (!config) {
    try {
      const activeConfigs = await resolveActiveConfigs(tenantId);
      activeMemberConfigs = (Array.isArray(activeConfigs) ? activeConfigs : [])
        .filter((candidate) => candidate?.structure_scope_type === 'member');
    } catch {
      // A resolver failure must not turn an old paid row into a synthetic
      // current tier. Keep the status truthful and fail closed below.
      activeConfigLookupFailed = true;
    }

    const historicalCandidates = findHistoricalMemberConfigs(personalHistory);
    for (const historicalRecord of activeConfigLookupFailed ? [] : historicalCandidates) {
      if (!historicalRecord?.config_id) continue;
      const historicalConfig = await resolveConfigById(tenantId, historicalRecord.config_id);
      if (!isTenantMemberConfig(historicalConfig, tenantId)) continue;

      // The saved config's schedule is used only to decide whether this
      // particular paid row is the current membership year. It is never used
      // to simulate a new price or to manufacture a future year.
      const historicalCurrentYear = calculateMembershipYearWindow(historicalConfig);
      if (historicalRecord.membership_year !== historicalCurrentYear.label) continue;

      const hasExplicitSelector = await hasExplicitMemberTierSelector(
        db,
        tenantId,
        memberId,
        [...activeMemberConfigs, historicalConfig],
        historicalConfig,
      );
      if (hasExplicitSelector) continue;

      historicalSnapshot = {
        record: historicalRecord,
        config: historicalConfig,
      };
      config = historicalConfig;
      break;
    }
  }
  const configResolvedFromPaidHistory = !!historicalSnapshot;
  const pricingCapability = configResolvedFromPaidHistory
    ? {
      mode: 'historical_read_only',
      status: 'paid_snapshot',
      readOnly: true,
      canSimulate: false,
      canEmail: false,
      canOverride: false,
      canRenew: false,
      canInvoice: false,
    }
    : config
      ? {
        mode: 'live',
        status: 'matched',
        readOnly: false,
        canSimulate: true,
        canEmail: true,
        canOverride: true,
        canRenew: true,
        canInvoice: true,
      }
      : {
        mode: 'unavailable',
        status: activeConfigLookupFailed
          ? 'pricing_unavailable'
          : activeMemberConfigs.length > 0 ? 'no_matching_tier' : 'none_configured',
        readOnly: true,
        canSimulate: false,
        canEmail: false,
        canOverride: false,
        canRenew: false,
        canInvoice: false,
      };
  if (!config) {
    return res.json({
      member: { id: member.id, name: `${member.first_name || ''} ${member.last_name || ''}`.trim(), email: member.email || null },
      config: null,
      currentYearCost: null,
      nextYearPreview: null,
      history,
      commitments,
      currentCommitments,
      pause,
      pricingCapability,
    });
  }

  const personalRollingCommitment = commitments.find((commitment) => (
    commitment.source === 'personal' && commitment.lifecycle === 'current'
  ));
  const personalRollingRecord = personalRollingCommitment
    ? personalHistory.find((record) => record.id === personalRollingCommitment.id)
    : null;
  const currentYear = personalRollingRecord
    ? { label: personalRollingRecord.term_key || personalRollingRecord.membership_year, start: null }
    : configResolvedFromPaidHistory
    ? { label: historicalSnapshot.record.membership_year, start: null }
    : calculateMembershipYearWindow(config);
  const nextYear = configResolvedFromPaidHistory || personalRollingRecord
    ? null : calculateNextMembershipYearWindow(config);
  const currentYearStartDate = currentYear.start
    ? currentYear.start.toISOString().split('T')[0]
    : null;
  const nextYearStartDate = nextYear?.start
    ? nextYear.start.toISOString().split('T')[0]
    : null;

  let currentYearCost = null;
  let nextYearPreview = null;

  // Pricing and simulation remain member-scoped. Organisation history is
  // included in the ledger display above, but must not make a member's
  // personal year card appear recorded.
  const currentYearRecord = personalRollingRecord || historicalSnapshot?.record
    || personalHistory.find(h => h.membership_year === currentYear.label);

  if (currentYearRecord) {
    const recAnnual = parseFloat(currentYearRecord.annual_cost);
    const recCustomTotal = parseFloat(currentYearRecord.custom_discount_total || 0);
    const recProrata = currentYearRecord.prorata_cost != null ? parseFloat(currentYearRecord.prorata_cost) : null;
    const recFreeDiscount = parseFloat(currentYearRecord.free_period_discount || 0);
    const recFinal = parseFloat(currentYearRecord.final_cost);
    const hasProRata = recProrata !== null;

    currentYearCost = {
      membershipYear: currentYear.label,
      startDate: currentYearRecord.term_start_date || currentYearStartDate,
      renewalDate: currentYearRecord.membership_renewal_date || null,
      endDate: currentYearRecord.term_end_date || null,
      durationMonths: currentYearRecord.term_duration_months || null,
      tierLabel: currentYearRecord.tier_label || null,
      fieldValue: currentYearRecord.field_value,
      annualCost: recAnnual,
      annualCostBeforeDiscounts: recCustomTotal > 0 ? parseFloat((recAnnual + recCustomTotal).toFixed(2)) : recAnnual,
      customDiscountTotal: recCustomTotal,
      customDiscountDetails: currentYearRecord.custom_discount_details || [],
      proRataEnabled: hasProRata,
      prorataCost: recProrata,
      freeDiscount: recFreeDiscount,
      finalCost: recFinal,
      currency: currentYearRecord.currency || config.currency || 'GBP',
      billingPeriod: currentYearRecord.billing_period || config.billing_period || 'annual',
      yearNumber: currentYearRecord.year_number || null,
      dailyCost: null,
      prorataDays: currentYearRecord.prorata_days || null,
      freePeriodDaysApplied: currentYearRecord.free_period_days_applied || 0,
      freePeriodAmount: configResolvedFromPaidHistory ? null : config.free_period_amount,
      freePeriodUnit: configResolvedFromPaidHistory ? null : config.free_period_unit,
      billableDays: null,
      vatRatePercent: currentYearRecord.vat_rate_percent != null ? parseFloat(currentYearRecord.vat_rate_percent) : null,
      vatAmount: currentYearRecord.vat_amount != null ? parseFloat(currentYearRecord.vat_amount) : 0,
      totalWithVat: currentYearRecord.total_with_vat != null ? parseFloat(currentYearRecord.total_with_vat) : recFinal,
      taxType: null,
      taxLabel: null,
      overrideApplied: currentYearRecord.override_applied || false,
      overrideType: currentYearRecord.override_type || null,
      isNewMember: false,
      recordedFromHistory: true,
    };
  } else if (!configResolvedFromPaidHistory) {
    try {
      const simResult = await simulateMember(tenantId, memberId, {
        source: 'tab',
        targetYear: currentYear.label,
      });
      if (simResult.success) {
        currentYearCost = mapSimResultToYearData(simResult, currentYearStartDate);
      }
    } catch (simErr) {
      console.warn('[Member Membership] Current year simulation failed:', simErr.message);
    }
  }

  if (!configResolvedFromPaidHistory && nextYear) {
    try {
      const nextSimResult = await simulateMember(tenantId, memberId, {
        source: 'tab',
        targetYear: nextYear.label,
        asOfDate: nextYearStartDate,
      });
      if (nextSimResult.success) {
        nextYearPreview = mapSimResultToYearData(nextSimResult, nextYearStartDate);
      }
    } catch (simErr) {
      console.warn('[Member Membership] Next year simulation failed:', simErr.message);
    }
  }

  return res.json({
    member: { id: member.id, name: `${member.first_name || ''} ${member.last_name || ''}`.trim(), email: member.email || null },
    config: {
      id: config.id,
      name: config.name,
      currency: config.currency || 'GBP',
      billing_period: config.billing_period || 'annual',
      effective_from: config.effective_from,
      membership_start_month: config.membership_start_month,
      membership_start_day: config.membership_start_day,
      online_card_payment: !!config.online_card_payment,
      source: configResolvedFromPaidHistory ? 'paid_history' : 'live',
    },
    pause,
    currentYearCost,
    nextYearPreview,
    history,
    commitments,
    currentCommitments,
    currentYear: currentYear.label,
    pricingCapability,
  });
}
