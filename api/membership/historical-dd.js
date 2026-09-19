import { supabase } from '../_lib/database.js';
import { getSessionMember } from '../_lib/session.js';
import {
  getTenantContext,
  hasAdminAccess,
  hasFeatureAccess,
} from '../_lib/tenantContext.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MIGRATION_ERROR_CODES = new Set(['42P01', '42703']);
const HISTORY_PERMISSION = 'commerce.history';
const INVOICE_PERMISSION = 'commerce.history.access-invoices';

export function xeroInvoiceUrl(invoiceId) {
  return UUID_RE.test(String(invoiceId || ''))
    ? `https://go.xero.com/AccountsReceivable/View.aspx?InvoiceID=${encodeURIComponent(invoiceId)}`
    : null;
}

export function createHistoricalDdHandler(dependencies = {}) {
  const db = dependencies.db === undefined ? supabase : dependencies.db;
  const getMember = dependencies.getSessionMember || getSessionMember;
  const getContext = dependencies.getTenantContext || getTenantContext;
  const checkAdmin = dependencies.hasAdminAccess || hasAdminAccess;
  const checkFeature = dependencies.hasFeatureAccess || hasFeatureAccess;

  return async function handler(req, res) {
    if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
    if (!db) return res.status(503).json({ error: 'Database not configured' });
    const requestedMemberId = Array.isArray(req.query?.memberId) ? null : req.query?.memberId;
    if (!requestedMemberId) return res.status(400).json({ error: 'memberId is required' });

    let sessionMember;
    let context;
    try {
      [sessionMember, context] = await Promise.all([getMember(req), getContext(req)]);
    } catch (error) {
      console.error('[historical-dd] Authentication failed:', error);
      return res.status(500).json({ error: 'Failed to authenticate historical Direct Debit request' });
    }
    if (!sessionMember && !context?.isAuthenticated) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    if (context?.tenantMismatch) return res.status(409).json({ error: 'Tenant context mismatch' });

    const isSelf = String(sessionMember?.id || '') === String(requestedMemberId);
    let isAdmin = false;
    if (context?.isAuthenticated && context?.tenantId) {
      try {
        isAdmin = await checkAdmin(context);
      } catch {
        isAdmin = false;
      }
    }
    if (!isSelf && !isAdmin) {
      return res.status(403).json({ error: 'Not authorized to view historical Direct Debit payments' });
    }

    const tenantId = isSelf
      ? (sessionMember?.tenant_id || sessionMember?.organization?.tenant_id || context?.tenantId)
      : context.tenantId;
    if (!tenantId) return res.status(403).json({ error: 'Tenant context required' });
    if (isSelf && context?.tenantId && context.tenantId !== tenantId) {
      return res.status(409).json({ error: 'Tenant context mismatch' });
    }

    let canAccessInvoices = isAdmin;
    if (!isAdmin) {
      const roleId = sessionMember?.role_id || context?.roleId;
      const exclusions = sessionMember?.member_excluded_features
        || context?.memberExcludedFeatures;
      const canAccessHistory = !!roleId
        && await checkFeature(roleId, HISTORY_PERMISSION, exclusions);
      if (!canAccessHistory) {
        return res.status(403).json({ error: 'Membership history access permission required' });
      }
      canAccessInvoices = await checkFeature(roleId, INVOICE_PERMISSION, exclusions);
    }

    const { data: member, error: memberError } = await db
      .from('member')
      .select('id, tenant_id')
      .eq('id', requestedMemberId)
      .eq('tenant_id', tenantId)
      .maybeSingle();
    if (memberError) {
      console.error('[historical-dd] Member lookup failed:', memberError);
      return res.status(500).json({ error: 'Failed to verify historical Direct Debit owner' });
    }
    if (!member) return res.status(404).json({ error: 'Member not found' });

    const { data, error } = await db
      .from('bnms_dd_historical_payment')
      .select('id, tenant_id, member_id, period, charge_date, amount_minor, currency, provider_payment_id, provider_status, xero_invoice_id, xero_invoice_number, historical_only')
      .eq('tenant_id', tenantId)
      .eq('member_id', requestedMemberId)
      .eq('historical_only', true)
      .order('period', { ascending: false });
    if (error) {
      if (MIGRATION_ERROR_CODES.has(error.code)) {
        return res.status(503).json({
          error: 'Historical Direct Debit storage is not installed',
          code: 'HISTORICAL_DD_MIGRATION_NOT_INSTALLED',
        });
      }
      console.error('[historical-dd] Payment lookup failed:', error);
      return res.status(500).json({ error: 'Failed to load historical Direct Debit payments' });
    }

    return res.json({
      payments: (data || []).map((row) => ({
        id: row.id,
        period: row.period,
        charge_date: row.charge_date,
        amount_minor: row.amount_minor,
        currency: row.currency,
        provider_payment_id: row.provider_payment_id,
        provider_status: row.provider_status,
        xero_invoice_id: canAccessInvoices ? row.xero_invoice_id : null,
        xero_invoice_number: canAccessInvoices ? row.xero_invoice_number : null,
        xero_invoice_url: canAccessInvoices ? xeroInvoiceUrl(row.xero_invoice_id) : null,
        historical_only: true,
      })),
    });
  };
}

export default createHistoricalDdHandler();