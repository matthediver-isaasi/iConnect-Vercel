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

const COMMON_INVOICE_COLUMNS = [
  'id',
  'tenant_id',
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

const TABLE_BY_SOURCE = {
  [PERSONAL_SOURCE]: 'member_membership_history',
  [ORGANISATION_SOURCE]: 'organisation_membership_history',
};

async function fetchInvoiceRecord(db, source, recordId, tenantId) {
  const table = TABLE_BY_SOURCE[source];
  const { data, error } = await db
    .from(table)
    .select(INVOICE_COLUMNS_BY_SOURCE[source])
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
      if (!isAdmin) {
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

      const memberId = sessionMember?.id || tenantContext?.memberId;
      const organizationId = sessionMember?.organization_id || tenantContext?.organizationId;

      let recordsBySource;
      if (requestedSource) {
        recordsBySource = {
          [requestedSource]: await fetchInvoiceRecord(db, requestedSource, recordId, appTenantId),
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
          ),
          fetchInvoiceRecord(
            db,
            PERSONAL_SOURCE,
            recordId,
            appTenantId,
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
      if (!hasInvoiceReference(record)) {
        return res.status(404).json({ error: 'Invoice not found for this membership record' });
      }

      const invoiceId = record.accounting_invoice_id || record.xero_invoice_id;
      // Rows written before provider pinning are legacy Xero invoices.
      const providerName = record.accounting_provider || 'xero';
      const provider = await getProviderByName(providerName);
      const pdfBuffer = await provider.fetchInvoicePdf(invoiceId, appTenantId);

      const inline = query.inline === 'true';
      const invoiceNumber = record.accounting_invoice_number || record.xero_invoice_number;

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Length', pdfBuffer.length);
      const disposition = inline ? 'inline' : 'attachment';
      res.setHeader(
        'Content-Disposition',
        `${disposition}; filename="membership-invoice-${invoiceNumber || recordId}.pdf"`,
      );

      return res.send(pdfBuffer);
    } catch (error) {
      console.error('[membership-invoice] Error serving invoice PDF:', error);
      return res.status(500).json({ error: 'Failed to fetch invoice from accounting provider' });
    }
  };
}

export default createMembershipInvoiceHandler();