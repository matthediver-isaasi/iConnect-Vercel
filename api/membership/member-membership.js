import { supabase } from '../_lib/database.js';
import { getSessionMember } from '../_lib/session.js';
import { getTenantContext, hasAdminAccess } from '../_lib/tenantContext.js';
import { getConfigForMember } from '../_lib/membershipConfigResolver.js';
import { simulateMembershipForMember } from '../_lib/membershipSimulation.js';
import { calculateMembershipYearWindow, calculateNextMembershipYearWindow } from '../_lib/membershipYear.js';

const INSTALMENT_PAGE_SIZE = 25;
const INSTALMENT_MAX_PAGE = 1000;
const INSTALMENT_TABLE_MISSING_CODES = new Set(['42P01', '42703']);
const VALID_HISTORY_SOURCES = new Set(['personal', 'organisation']);
const GC_COLLECTED_STATUSES = ['confirmed', 'paid_out'];

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
    .select(`id, tenant_id, ${ownerSelect}, membership_year, billing_period, billing_agreement_id`)
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
    .select('id, tenant_id, member_id, organization_id, agreement_type, provider, status, metadata')
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
          return handleInstalmentGet(req, res, {
            db,
            tenantId,
            tenantContext,
            getMember,
            checkAdmin,
          });
        }
        return handleGet(req, res, tenantId, db, {
          tenantContext,
          getMember,
          checkAdmin,
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

async function handleGet(req, res, tenantId, db = supabase, {
  tenantContext = null,
  getMember = getSessionMember,
  checkAdmin = hasAdminAccess,
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

  const config = await getConfigForMember(tenantId, memberId);

  if (!config) {
    return res.json({
      member: { id: member.id, name: `${member.first_name || ''} ${member.last_name || ''}`.trim(), email: member.email || null },
      config: null,
      currentYearCost: null,
      nextYearPreview: null,
      history: [],
      pause,
    });
  }

  const currentYear = calculateMembershipYearWindow(config);
  const nextYear = calculateNextMembershipYearWindow(config);

  let history = [];
  try {
    const { data: historyRecords } = await db
      .from('member_membership_history')
      .select('*')
      .eq('tenant_id', tenantId)
      .eq('member_id', memberId)
      .order('membership_year', { ascending: false });
    history = historyRecords || [];
  } catch (err) {
    console.log('[Member Membership] History table may not exist yet:', err.message);
  }

  const currentYearStartDate = currentYear.start.toISOString().split('T')[0];
  const nextYearStartDate = nextYear.start.toISOString().split('T')[0];

  let currentYearCost = null;
  let nextYearPreview = null;

  const currentYearRecord = history.find(h => h.membership_year === currentYear.label);

  if (currentYearRecord) {
    const recAnnual = parseFloat(currentYearRecord.annual_cost);
    const recCustomTotal = parseFloat(currentYearRecord.custom_discount_total || 0);
    const recProrata = currentYearRecord.prorata_cost != null ? parseFloat(currentYearRecord.prorata_cost) : null;
    const recFreeDiscount = parseFloat(currentYearRecord.free_period_discount || 0);
    const recFinal = parseFloat(currentYearRecord.final_cost);
    const hasProRata = recProrata !== null;

    currentYearCost = {
      membershipYear: currentYear.label,
      startDate: currentYearStartDate,
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
      freePeriodAmount: config.free_period_amount,
      freePeriodUnit: config.free_period_unit,
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
  } else {
    try {
      const simResult = await simulateMembershipForMember(tenantId, memberId, {
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

  try {
    const nextSimResult = await simulateMembershipForMember(tenantId, memberId, {
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
    },
    pause,
    currentYearCost,
    nextYearPreview,
    history,
    currentYear: currentYear.label,
  });
}
