import { getSessionMember } from '../_lib/session.js';
import {
  getTenantContext,
  hasAdminAccess,
  hasFeatureAccess,
} from '../_lib/tenantContext.js';
import { getAccountingProviderByName } from '../_lib/accountingProvider.js';
import { supabase } from '../_lib/database.js';

const PERSONAL_SOURCE = 'personal';
const ORGANISATION_SOURCE = 'organisation';
const VALID_SOURCES = new Set([PERSONAL_SOURCE, ORGANISATION_SOURCE]);
const ACCESS_INVOICES_PERMISSION = 'commerce.history.access-invoices';
const PROVIDER_ERROR_MESSAGE = 'Unable to download this invoice right now. Please retry, or contact an administrator if the problem continues.';

const COMMON_INVOICE_COLUMNS = [
  'id',
  'tenant_id',
  'xero_invoice_id',
  'xero_invoice_number',
  'accounting_provider',
  'accounting_invoice_id',
  'accounting_invoice_number',
].join(', ');

const INSTALMENT_COMMON_COLUMNS = [
  'id',
  'tenant_id',
  'membership_year',
  'billing_period',
  'billing_agreement_id',
  'xero_invoice_id',
  'xero_invoice_number',
  'accounting_provider',
  'accounting_invoice_id',
  'accounting_invoice_number',
].join(', ');

const INVOICE_COLUMNS_BY_SOURCE = {
  personal: ['member_id', COMMON_INVOICE_COLUMNS].join(', '),
  organisation: ['organization_id', COMMON_INVOICE_COLUMNS].join(', '),
};

const INSTALMENT_COLUMNS_BY_SOURCE = {
  personal: ['member_id', INSTALMENT_COMMON_COLUMNS].join(', '),
  organisation: ['organization_id', INSTALMENT_COMMON_COLUMNS].join(', '),
};
const TABLE_BY_SOURCE = {
  [PERSONAL_SOURCE]: 'member_membership_history',
  [ORGANISATION_SOURCE]: 'organisation_membership_history',
};

async function fetchInvoiceRecord(db, source, recordId, tenantId, { instalment = false } = {}) {
  const table = TABLE_BY_SOURCE[source];
  const { data, error } = await db
    .from(table)
    .select((instalment ? INSTALMENT_COLUMNS_BY_SOURCE : INVOICE_COLUMNS_BY_SOURCE)[source])
    .eq('id', recordId)
    .eq('tenant_id', tenantId)
    .maybeSingle();

  if (error) throw error;
  return data || null;
}

function hasInvoiceReference(record) {
  return !!(record?.accounting_invoice_id || record?.xero_invoice_id);
}

function recordBelongsToMember(record, source, memberId, organizationId) {
  if (source === PERSONAL_SOURCE) {
    return !!memberId && record?.member_id === memberId;
  }
  return !!organizationId && record?.organization_id === organizationId;
}

function isInstalmentSelector(query) {
  return query?.instalment === 'true'
    || query?.instalments === 'true';
}

function hasInvalidInstalmentSelector(query) {
  for (const key of ['instalment', 'instalments']) {
    if (query?.[key] !== undefined
        && (Array.isArray(query[key]) || !['true', 'false'].includes(String(query[key])))) {
      return true;
    }
  }
  return false;
}

function agreementOwnsHistory(agreement, record, source) {
  if (!agreement || agreement.tenant_id !== record.tenant_id) return false;
  if (source === PERSONAL_SOURCE) {
    return agreement.member_id === record.member_id && !agreement.organization_id;
  }
  return agreement.organization_id === record.organization_id && !agreement.member_id;
}

function instalmentPaymentReference(query) {
  return query?.paymentRef
    || query?.paymentId
    || query?.externalPaymentId
    || null;
}

function ledgerInvoiceId(row) {
  return row?.accounting_invoice_id || row?.xero_invoice_id || null;
}

function ledgerInvoiceNumber(row) {
  return row?.accounting_invoice_number || row?.xero_invoice_number || null;
}

function safeFilenamePart(value) {
  const safe = String(value || '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '')
    .slice(0, 100);
  return safe || 'invoice';
}

async function fetchInstalmentInvoiceRow({
  db,
  record,
  source,
  tenantId,
  query,
}) {
  if (!record?.billing_agreement_id) {
    return { error: { status: 404, message: 'No billing agreement is attached to this membership record' } };
  }

  const { data: agreement, error: agreementError } = await db
    .from('membership_billing_agreements')
    .select('id, tenant_id, member_id, organization_id, provider, status, metadata')
    .eq('id', record.billing_agreement_id)
    .eq('tenant_id', tenantId)
    .maybeSingle();
  if (agreementError) throw agreementError;
  if (!agreement || !agreementOwnsHistory(agreement, record, source)) {
    return { error: { status: 403, message: 'Membership billing agreement ownership mismatch' } };
  }

  if (!['stripe', 'gocardless'].includes(agreement.provider)) {
    return { error: { status: 500, message: 'Unsupported membership billing agreement provider' } };
  }
  const provider = agreement.provider;
  const paymentRef = instalmentPaymentReference(query);
  const instalmentId = query?.instalmentId || null;
  let ledgerRows = [];
  let plans = [];

  if (provider === 'stripe') {
    let ledgerQuery = db
      .from('membership_instalment_invoices')
      .select('id, tenant_id, billing_agreement_id, plan_id, external_payment_id, accounting_provider, accounting_invoice_id, accounting_invoice_number, xero_invoice_id, xero_invoice_number, accounting_sync_status, accounting_sync_error, amount_minor, currency, created_at, accounting_synced_at')
      .eq('tenant_id', tenantId)
      .eq('billing_agreement_id', agreement.id);
    if (instalmentId) ledgerQuery = ledgerQuery.eq('id', instalmentId);
    if (paymentRef) ledgerQuery = ledgerQuery.eq('external_payment_id', paymentRef);
    if (typeof ledgerQuery.limit === 'function') ledgerQuery = ledgerQuery.limit(1);
    const { data, error } = await ledgerQuery;
    if (error) {
      if (error.code === '42P01' || error.code === '42703') {
        return { error: { status: 404, message: 'Instalment accounting ledger is not available' } };
      }
      throw error;
    }
    ledgerRows = Array.isArray(data) ? data : (data ? [data] : []);
  } else {
    let planQuery = db
      .from('membership_payment_plans')
      .select('id, tenant_id, billing_agreement_id, member_id, organization_id')
      .eq('tenant_id', tenantId)
      .eq('billing_agreement_id', agreement.id);
    if (typeof planQuery.limit === 'function') planQuery = planQuery.limit(100);
    const planResult = await planQuery;
    if (planResult?.error) throw planResult.error;
    plans = Array.isArray(planResult?.data) ? planResult.data : [];
    const planIds = plans
      .filter((plan) => plan.member_id == null || plan.member_id === record.member_id)
      .filter((plan) => plan.organization_id == null || plan.organization_id === record.organization_id)
      .map((plan) => plan.id)
      .filter(Boolean);
    if (planIds.length > 0) {
      let ledgerQuery = db
        .from('gocardless_payments')
        .select('id, tenant_id, plan_id, gocardless_payment_id, accounting_provider, accounting_invoice_id, accounting_invoice_number, xero_invoice_id, xero_invoice_number, accounting_sync_status, accounting_sync_error, amount_minor, currency, status, charge_date, confirmed_at, created_at, accounting_synced_at')
        .eq('tenant_id', tenantId)
        .in('plan_id', planIds)
        .in('status', ['confirmed', 'paid_out']);
      if (instalmentId) ledgerQuery = ledgerQuery.eq('id', instalmentId);
      if (paymentRef) ledgerQuery = ledgerQuery.eq('gocardless_payment_id', paymentRef);
      if (typeof ledgerQuery.limit === 'function') ledgerQuery = ledgerQuery.limit(1);
      const { data, error } = await ledgerQuery;
      if (error) {
        if (error.code === '42P01' || error.code === '42703') {
          return { error: { status: 404, message: 'Instalment accounting ledger is not available' } };
        }
        throw error;
      }
      ledgerRows = Array.isArray(data) ? data : (data ? [data] : []);
    }
  }

  const row = ledgerRows[0] || null;
  if (!row) {
    return { error: { status: 404, message: 'Instalment invoice not found for this membership record' } };
  }

  // A ledger query is always scoped through the tenant and the history's
  // agreement. Keep this assertion explicit so a future query change cannot
  // accidentally turn an external payment reference into a cross-member read.
  if (row.tenant_id !== tenantId
      || (provider === 'stripe' && row.billing_agreement_id !== agreement.id)
      || (provider === 'gocardless'
        && !plans.some((plan) => plan.id === row.plan_id))) {
    return { error: { status: 403, message: 'Instalment invoice ownership mismatch' } };
  }

  return { agreement, row, provider };
}

/**
 * Resolve a membership invoice without relying on the member's current
 * organisation assignment. The optional source is a selector only; it never
 * grants access. With no source, both ledgers are considered so old
 * record-ID-only callers and tenant admins continue to work.
 */
export function createMembershipInvoiceHandler(dependencies = {}) {
  const db = dependencies.db === undefined ? supabase : dependencies.db;
  const getMember = dependencies.getSessionMember || getSessionMember;
  const getContext = dependencies.getTenantContext || getTenantContext;
  const checkAdmin = dependencies.hasAdminAccess || hasAdminAccess;
  const checkFeature = dependencies.hasFeatureAccess || hasFeatureAccess;
  // Invoice rows retain the provider that originally issued them. Do not
  // resolve the tenant's currently-active provider for historical invoices.
  const getProviderByName = dependencies.getAccountingProviderByName
    || getAccountingProviderByName;

  return async function handler(req, res) {
    res.setHeader('Cache-Control', 'private, no-store');
    if (req.method !== 'GET') {
      return res.status(405).json({ error: 'Method not allowed' });
    }

    if (!db) {
      return res.status(503).json({ error: 'Database not configured' });
    }

    let tenantContext;
    let sessionMember;
    try {
      [tenantContext, sessionMember] = await Promise.all([
        getContext(req),
        getMember(req),
      ]);
    } catch (error) {
      console.error('[membership-invoice] Error resolving authentication:', error);
      return res.status(500).json({ error: 'Failed to authenticate invoice request' });
    }

    if (!tenantContext?.isAuthenticated && !sessionMember) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    // getTenantContext deliberately returns a tenantMismatch sentinel instead
    // of throwing. Never let that context (or a stale context supplied by a
    // caller) select a different tenant from the authenticated member.
    if (tenantContext?.tenantMismatch) {
      return res.status(409).json({ error: 'Tenant context mismatch' });
    }

    const memberTenantId = sessionMember?.tenant_id
      || sessionMember?.organization?.tenant_id
      || null;
    if (memberTenantId && tenantContext?.tenantId
        && memberTenantId !== tenantContext.tenantId) {
      return res.status(409).json({ error: 'Tenant context mismatch' });
    }

    const query = req.query || {};
    const { recordId } = query;
    if (!recordId) {
      return res.status(400).json({ error: 'Record ID required' });
    }
    if (hasInvalidInstalmentSelector(query)) {
      return res.status(400).json({ error: 'Invalid instalment selector' });
    }
    const instalmentRequest = isInstalmentSelector(query);
    if (instalmentRequest
        && !instalmentPaymentReference(query)
        && !query.instalmentId) {
      return res.status(400).json({
        error: 'paymentRef or instalmentId is required for an instalment invoice',
      });
    }

    const requestedSource = query.source;
    if (requestedSource !== undefined
        && (!VALID_SOURCES.has(requestedSource) || Array.isArray(requestedSource))) {
      return res.status(400).json({ error: 'Invalid membership source' });
    }

    try {
      // A portal member is the authenticated principal. In particular, do
      // not use tenantContext.roleId or tenantContext.tenantId as a fallback
      // for a member request: a stale/cross-tenant context must never grant
      // the member another tenant's role permissions or invoice scope.
      const appTenantId = memberTenantId || tenantContext?.tenantId;
      if (!appTenantId) {
        return res.status(403).json({ error: 'Tenant context required for invoice access' });
      }

      const adminCheckContext = sessionMember && !tenantContext?.tenantUserId
        ? {
          ...tenantContext,
          tenantId: appTenantId,
          memberId: sessionMember.id,
          roleId: sessionMember.role_id || null,
        }
        : tenantContext;
      const isAdmin = await checkAdmin(adminCheckContext);
      if (!isAdmin && !instalmentRequest) {
        // RBAC must use the role attached to the authenticated member row.
        // tenantContext.roleId is intentionally not a fallback here.
        const roleId = sessionMember?.role_id;
        const canAccessInvoices = !!roleId
          && await checkFeature(
            roleId,
            ACCESS_INVOICES_PERMISSION,
            sessionMember?.member_excluded_features,
          );
        if (!canAccessInvoices) {
          return res.status(403).json({ error: 'Invoice access permission required' });
        }
      }

      // Instalment accounting is deliberately narrower than the legacy annual
      // invoice permission: an admin or the authenticated owning member only.
      // Never use a stale tenant-context member as proof of ownership.
      const memberId = instalmentRequest
        ? sessionMember?.id
        : (sessionMember?.id || tenantContext?.memberId);
      const organizationId = instalmentRequest
        ? sessionMember?.organization_id
        : (sessionMember?.organization_id || tenantContext?.organizationId);

      let recordsBySource;
      if (requestedSource) {
        recordsBySource = {
          [requestedSource]: await fetchInvoiceRecord(
            db,
            requestedSource,
            recordId,
            appTenantId,
            { instalment: instalmentRequest },
          ),
        };
      } else {
        // Query both ledgers for source-less record-ID requests. In addition
        // to avoiding organisation-dependent resolution, this makes every
        // query failure visible rather than silently returning a partial
        // result from the other ledger.
        const [organisationRecord, personalRecord] = await Promise.all([
          fetchInvoiceRecord(
            db,
            ORGANISATION_SOURCE,
            recordId,
            appTenantId,
            { instalment: instalmentRequest },
          ),
          fetchInvoiceRecord(
            db,
            PERSONAL_SOURCE,
            recordId,
            appTenantId,
            { instalment: instalmentRequest },
          ),
        ]);
        recordsBySource = {
          [ORGANISATION_SOURCE]: organisationRecord,
          [PERSONAL_SOURCE]: personalRecord,
        };
      }

      const candidateSources = requestedSource
        ? [requestedSource]
        : [ORGANISATION_SOURCE, PERSONAL_SOURCE];
      const candidateSource = candidateSources.find((source) => {
        const record = recordsBySource[source];
        if (!record) return false;
        return isAdmin || recordBelongsToMember(record, source, memberId, organizationId);
      });

      if (!candidateSource) {
        const hasRecord = Object.values(recordsBySource).some(Boolean);
        if (hasRecord && !isAdmin) {
          return res.status(403).json({ error: 'Not authorized to view this invoice' });
        }
        return res.status(404).json({ error: 'Invoice not found for this membership record' });
      }

      const record = recordsBySource[candidateSource];
      if (instalmentRequest) {
        const instalment = await fetchInstalmentInvoiceRow({
          db,
          record,
          source: candidateSource,
          tenantId: appTenantId,
          query,
        });
        if (instalment.error) {
          return res.status(instalment.error.status).json({ error: instalment.error.message });
        }
        const invoiceId = ledgerInvoiceId(instalment.row);
        if (!invoiceId) {
          return res.status(404).json({
            error: 'No accounting invoice is linked to this instalment',
          });
        }
        const providerName = instalment.row.accounting_provider || 'xero';
        let pdfBuffer;
        try {
          const provider = await getProviderByName(providerName);
          pdfBuffer = await provider.fetchInvoicePdf(invoiceId, appTenantId);
        } catch (error) {
          console.error('[membership-invoice] Accounting provider PDF fetch failed:', error);
          return res.status(502).json({ error: PROVIDER_ERROR_MESSAGE });
        }
        const inline = query.inline === 'true';
        const invoiceNumber = ledgerInvoiceNumber(instalment.row);
        const filenamePart = safeFilenamePart(invoiceNumber || recordId);

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Length', pdfBuffer.length);
        const disposition = inline ? 'inline' : 'attachment';
        res.setHeader(
          'Content-Disposition',
          `${disposition}; filename="membership-invoice-${filenamePart}.pdf"`,
        );
        return res.send(pdfBuffer);
      }

      if (!hasInvoiceReference(record)) {
        return res.status(404).json({ error: 'Invoice not found for this membership record' });
      }

      const invoiceId = record.accounting_invoice_id || record.xero_invoice_id;
      // Rows written before provider pinning are legacy Xero invoices.
      const providerName = record.accounting_provider || 'xero';
      let pdfBuffer;
      try {
        const provider = await getProviderByName(providerName);
        pdfBuffer = await provider.fetchInvoicePdf(invoiceId, appTenantId);
      } catch (error) {
        console.error('[membership-invoice] Accounting provider PDF fetch failed:', error);
        return res.status(502).json({ error: PROVIDER_ERROR_MESSAGE });
      }

      const inline = query.inline === 'true';
      const invoiceNumber = record.accounting_invoice_number || record.xero_invoice_number;
      const filenamePart = safeFilenamePart(invoiceNumber || recordId);

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Length', pdfBuffer.length);
      const disposition = inline ? 'inline' : 'attachment';
      res.setHeader(
        'Content-Disposition',
        `${disposition}; filename="membership-invoice-${filenamePart}.pdf"`,
      );

      return res.send(pdfBuffer);
    } catch (error) {
      console.error('[membership-invoice] Error serving invoice PDF:', error);
      return res.status(500).json({ error: 'Failed to fetch invoice from accounting provider' });
    }
  };
}

export default createMembershipInvoiceHandler();