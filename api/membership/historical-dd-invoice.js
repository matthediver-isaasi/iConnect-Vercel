import { supabase } from '../_lib/database.js';
import { getSessionMember } from '../_lib/session.js';
import {
  getTenantContext,
  hasAdminAccess,
  hasFeatureAccess,
} from '../_lib/tenantContext.js';
import { fetchXeroInvoicePdf } from '../_lib/xero.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HISTORY_PERMISSION = 'commerce.history';
const INVOICE_PERMISSION = 'commerce.history.access-invoices';
const MIGRATION_ERROR_CODES = new Set(['42P01', '42703']);

function safeFilenamePart(value) {
  const safe = String(value || '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '')
    .slice(0, 100);
  return safe || 'invoice';
}

function isConnectionError(error) {
  const message = String(error?.message || '');
  const status = Number(error?.status || error?.statusCode)
    || Number(message.match(/(?:HTTP\s+|Xero:\s*)(\d{3})\b/i)?.[1]);
  return status === 401
    || status === 403
    || /(?:no xero token|authenticate|authentication incomplete|credentials not configured|refresh token|reconnect xero|token lookup|token-refresh)/i.test(message);
}

function isProviderNotFound(error) {
  return Number(error?.status || error?.statusCode) === 404
    || /Xero:\s*404\b/i.test(String(error?.message || ''));
}

export function createHistoricalDdInvoiceHandler(dependencies = {}) {
  const db = dependencies.db === undefined ? supabase : dependencies.db;
  const getMember = dependencies.getSessionMember || getSessionMember;
  const getContext = dependencies.getTenantContext || getTenantContext;
  const checkAdmin = dependencies.hasAdminAccess || hasAdminAccess;
  const checkFeature = dependencies.hasFeatureAccess || hasFeatureAccess;
  const fetchInvoicePdf = dependencies.fetchXeroInvoicePdf || fetchXeroInvoicePdf;

  return async function handler(req, res) {
    res.setHeader('Cache-Control', 'private, no-store');
    if (req.method !== 'GET') {
      return res.status(405).json({ error: 'Method not allowed' });
    }
    if (!db) return res.status(503).json({ error: 'Database not configured' });

    const recordId = Array.isArray(req.query?.recordId) ? null : req.query?.recordId;
    if (!recordId) return res.status(400).json({ error: 'recordId is required' });
    if (!UUID_RE.test(recordId)) {
      return res.status(400).json({ error: 'recordId must be a valid UUID' });
    }
    if (req.query?.inline !== undefined
        && (Array.isArray(req.query.inline)
          || !['true', 'false'].includes(String(req.query.inline)))) {
      return res.status(400).json({ error: 'inline must be true or false' });
    }
    const source = req.query?.source === undefined
      ? 'pilot_historical_ledger'
      : (Array.isArray(req.query.source) ? null : req.query.source);
    if (!['pilot_historical_ledger', 'beta_provider_history'].includes(source)) {
      return res.status(400).json({ error: 'source is invalid' });
    }

    let sessionMember;
    let context;
    try {
      [sessionMember, context] = await Promise.all([getMember(req), getContext(req)]);
    } catch (error) {
      console.error('[historical-dd-invoice] Authentication failed:', error);
      return res.status(500).json({ error: 'Failed to authenticate invoice request' });
    }
    if (!sessionMember && !context?.isAuthenticated) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    if (context?.tenantMismatch) {
      return res.status(409).json({ error: 'Tenant context mismatch' });
    }

    const memberTenantId = sessionMember?.tenant_id
      || sessionMember?.organization?.tenant_id
      || null;
    if (memberTenantId && context?.tenantId && memberTenantId !== context.tenantId) {
      return res.status(409).json({ error: 'Tenant context mismatch' });
    }
    const tenantId = memberTenantId || context?.tenantId;
    if (!tenantId) {
      return res.status(403).json({ error: 'Tenant context required for invoice access' });
    }

    try {
      const adminContext = sessionMember && !context?.tenantUserId
        ? {
          ...context,
          isAuthenticated: true,
          tenantId,
          memberId: sessionMember.id,
          roleId: sessionMember.role_id || null,
        }
        : context;
      const isAdmin = await checkAdmin(adminContext);

      if (!isAdmin) {
        // The persisted session member is the principal. Context role and
        // exclusions are deliberately never fallbacks for portal access.
        const roleId = sessionMember?.role_id;
        const exclusions = sessionMember?.member_excluded_features;
        const canAccessHistory = !!roleId
          && await checkFeature(roleId, HISTORY_PERMISSION, exclusions);
        const canAccessInvoices = canAccessHistory
          && await checkFeature(roleId, INVOICE_PERMISSION, exclusions);
        if (!canAccessHistory) {
          return res.status(403).json({ error: 'Membership history access permission required' });
        }
        if (!canAccessInvoices) {
          return res.status(403).json({ error: 'Invoice access permission required' });
        }
      }

      const recordQuery = source === 'beta_provider_history'
        ? db
          .from('bnms_dd_beta_provider_history')
          .select('id, tenant_id, member_id, accounting_reconciled')
          .eq('id', recordId)
          .eq('tenant_id', tenantId)
          .eq('accounting_reconciled', false)
        : db
          .from('bnms_dd_historical_payment')
          .select('id, tenant_id, member_id, xero_invoice_id, xero_invoice_number, historical_only')
          .eq('id', recordId)
          .eq('tenant_id', tenantId)
          .eq('historical_only', true);
      const { data: persistedRecord, error: recordError } = await recordQuery.maybeSingle();
      if (recordError) {
        if (MIGRATION_ERROR_CODES.has(recordError.code)) {
          return res.status(503).json({
            error: source === 'beta_provider_history'
              ? 'Beta historical Direct Debit storage is not installed'
              : 'Historical Direct Debit storage is not installed',
            code: source === 'beta_provider_history'
              ? 'HISTORICAL_DD_BETA_MIGRATION_NOT_INSTALLED'
              : 'HISTORICAL_DD_MIGRATION_NOT_INSTALLED',
          });
        }
        throw recordError;
      }
      if (!persistedRecord) {
        return res.status(404).json({ error: 'Historical Direct Debit invoice not found' });
      }
      if (!isAdmin && (!sessionMember?.id || persistedRecord.member_id !== sessionMember.id)) {
        return res.status(403).json({ error: 'Not authorized to view this invoice' });
      }

      let record = persistedRecord;
      if (source === 'beta_provider_history') {
        const { data: link, error: linkError } = await db
          .from('bnms_dd_beta_invoice_link')
          .select('history_id, tenant_id, member_id, xero_invoice_id, xero_invoice_number')
          .eq('history_id', persistedRecord.id)
          .eq('tenant_id', tenantId)
          .eq('member_id', persistedRecord.member_id)
          .maybeSingle();
        if (linkError) {
          if (MIGRATION_ERROR_CODES.has(linkError.code)) {
            return res.status(503).json({
              error: 'Beta historical invoice reconciliation storage is not installed',
              code: 'HISTORICAL_DD_BETA_INVOICE_LINK_MIGRATION_NOT_INSTALLED',
            });
          }
          throw linkError;
        }
        if (!link) {
          return res.status(404).json({ error: 'No invoice is linked to this historical payment' });
        }
        record = link;
      }
      if (!record.xero_invoice_id) {
        return res.status(404).json({ error: 'No invoice is linked to this historical payment' });
      }

      let pdf;
      try {
        pdf = await fetchInvoicePdf(record.xero_invoice_id, tenantId);
      } catch (error) {
        console.error('[historical-dd-invoice] Xero PDF fetch failed:', error);
        if (isConnectionError(error)) {
          return res.status(503).json({
            error: 'Xero connection is unavailable for this tenant',
            code: 'XERO_CONNECTION_UNAVAILABLE',
          });
        }
        if (isProviderNotFound(error)) {
          return res.status(404).json({ error: 'Invoice PDF was not found in Xero' });
        }
        return res.status(502).json({ error: 'Failed to fetch invoice PDF from Xero' });
      }

      const disposition = req.query?.inline === 'true' ? 'inline' : 'attachment';
      const filenamePart = safeFilenamePart(record.xero_invoice_number || record.id);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Length', pdf.length);
      res.setHeader(
        'Content-Disposition',
        `${disposition}; filename="membership-invoice-${filenamePart}.pdf"`,
      );
      return res.send(pdf);
    } catch (error) {
      console.error('[historical-dd-invoice] Invoice lookup failed:', error);
      return res.status(500).json({ error: 'Failed to load historical Direct Debit invoice' });
    }
  };
}

export default createHistoricalDdInvoiceHandler();