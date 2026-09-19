import { supabase } from '../_lib/database.js';
import { getSessionMember } from '../_lib/session.js';
import {
  getTenantContext,
  hasAdminAccess,
  hasFeatureAccess,
} from '../_lib/tenantContext.js';

const MIGRATION_ERROR_CODES = new Set(['42P01', '42703']);
const HISTORY_PERMISSION = 'commerce.history';
const INVOICE_PERMISSION = 'commerce.history.access-invoices';
const ALPHA_HISTORY_START_DATE = '2026-01-01';

export function createHistoricalDdHandler(dependencies = {}) {
  const db = dependencies.db === undefined ? supabase : dependencies.db;
  const getMember = dependencies.getSessionMember || getSessionMember;
  const getContext = dependencies.getTenantContext || getTenantContext;
  const checkAdmin = dependencies.hasAdminAccess || hasAdminAccess;
  const checkFeature = dependencies.hasFeatureAccess || hasFeatureAccess;

  return async function handler(req, res) {
    res.setHeader?.('Cache-Control', 'private, no-store');
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
        const adminContext = sessionMember && !context?.tenantUserId
          ? {
            ...context,
            memberId: sessionMember.id,
            roleId: sessionMember.role_id || null,
          }
          : context;
        isAdmin = await checkAdmin(adminContext);
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
      // Portal authorization must come from the authenticated member row, not
      // potentially stale role/exclusion values in tenant context.
      const roleId = sessionMember?.role_id;
      const exclusions = sessionMember?.member_excluded_features;
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

    const { data: pilotData, error: pilotError } = await db
      .from('bnms_dd_historical_payment')
      .select('id, tenant_id, member_id, period, charge_date, amount_minor, currency, provider_payment_id, provider_status, xero_invoice_id, xero_invoice_number, historical_only')
      .eq('tenant_id', tenantId)
      .eq('member_id', requestedMemberId)
      .eq('historical_only', true)
      .order('period', { ascending: false });
    if (pilotError) {
      if (MIGRATION_ERROR_CODES.has(pilotError.code)) {
        return res.status(503).json({
          error: 'Historical Direct Debit storage is not installed',
          code: 'HISTORICAL_DD_MIGRATION_NOT_INSTALLED',
        });
      }
      console.error('[historical-dd] Pilot payment lookup failed:', pilotError);
      return res.status(500).json({ error: 'Failed to load historical Direct Debit payments' });
    }

    const { data: betaData, error: betaError } = await db
      .from('bnms_dd_beta_provider_history')
      .select('id, tenant_id, member_id, charge_date, amount_minor, currency, provider_payment_id, provider_status, accounting_reconciled')
      .eq('tenant_id', tenantId)
      .eq('member_id', requestedMemberId)
      .eq('accounting_reconciled', false)
      .order('charge_date', { ascending: false });
    if (betaError) {
      if (MIGRATION_ERROR_CODES.has(betaError.code)) {
        return res.status(503).json({
          error: 'Beta historical Direct Debit storage is not installed',
          code: 'HISTORICAL_DD_BETA_MIGRATION_NOT_INSTALLED',
        });
      }
      console.error('[historical-dd] Beta provider history lookup failed:', betaError);
      return res.status(500).json({ error: 'Failed to load historical Direct Debit payments' });
    }

    const { data: betaInvoiceLinks, error: betaInvoiceLinkError } = await db
      .from('bnms_dd_beta_invoice_link')
      .select('history_id, tenant_id, member_id, xero_invoice_id, xero_invoice_number')
      .eq('tenant_id', tenantId)
      .eq('member_id', requestedMemberId)
      .order('created_at', { ascending: false });
    if (betaInvoiceLinkError) {
      if (MIGRATION_ERROR_CODES.has(betaInvoiceLinkError.code)) {
        return res.status(503).json({
          error: 'Beta historical invoice reconciliation storage is not installed',
          code: 'HISTORICAL_DD_BETA_INVOICE_LINK_MIGRATION_NOT_INSTALLED',
        });
      }
      console.error('[historical-dd] Beta invoice link lookup failed:', betaInvoiceLinkError);
      return res.status(500).json({ error: 'Failed to load historical Direct Debit invoices' });
    }

    // Do not infer reconciliation from the immutable provider-history flag.
    // Only an exact, tenant/member-scoped reconciliation link is authoritative.
    const betaLinksByHistoryId = new Map((betaInvoiceLinks || [])
      .filter((link) => link.tenant_id === tenantId && link.member_id === requestedMemberId)
      .map((link) => [link.history_id, link]));

    const { data: alphaData, error: alphaError } = await db
      .from('bnms_dd_alpha_provider_history')
      .select('id, adoption_id, tenant_id, member_id, charge_date, amount_minor, currency, provider_payment_id, provider_status')
      .eq('tenant_id', tenantId)
      .eq('member_id', requestedMemberId)
      .gte('charge_date', ALPHA_HISTORY_START_DATE)
      .order('charge_date', { ascending: false });
    if (alphaError) {
      if (MIGRATION_ERROR_CODES.has(alphaError.code)) {
        return res.status(503).json({
          error: 'Alpha historical Direct Debit storage is not installed',
          code: 'HISTORICAL_DD_ALPHA_MIGRATION_NOT_INSTALLED',
        });
      }
      console.error('[historical-dd] Alpha provider history lookup failed:', alphaError);
      return res.status(500).json({ error: 'Failed to load historical Direct Debit payments' });
    }

    const { data: alphaInvoiceLinks, error: alphaInvoiceLinkError } = await db
      .from('bnms_dd_alpha_invoice_link')
      .select('history_id, tenant_id, member_id, provider_payment_id, xero_invoice_id, xero_invoice_number')
      .eq('tenant_id', tenantId)
      .eq('member_id', requestedMemberId)
      .order('history_id', { ascending: false });
    if (alphaInvoiceLinkError) {
      if (MIGRATION_ERROR_CODES.has(alphaInvoiceLinkError.code)) {
        return res.status(503).json({
          error: 'Alpha historical invoice reconciliation storage is not installed',
          code: 'HISTORICAL_DD_ALPHA_INVOICE_LINK_MIGRATION_NOT_INSTALLED',
        });
      }
      console.error('[historical-dd] Alpha invoice link lookup failed:', alphaInvoiceLinkError);
      return res.status(500).json({ error: 'Failed to load historical Direct Debit invoices' });
    }
    const alphaLinksByHistoryId = new Map((alphaInvoiceLinks || [])
      .filter((link) => link.tenant_id === tenantId && link.member_id === requestedMemberId)
      .map((link) => [link.history_id, link]));

    const pilotPayments = (pilotData || []).map((row) => ({
      id: row.id,
      period: row.period,
      charge_date: row.charge_date,
      amount_minor: row.amount_minor,
      currency: row.currency,
      provider_payment_id: row.provider_payment_id,
      provider_status: row.provider_status,
      xero_invoice_id: canAccessInvoices ? row.xero_invoice_id : null,
      xero_invoice_number: canAccessInvoices ? row.xero_invoice_number : null,
      invoice_available: canAccessInvoices && !!row.xero_invoice_id,
      invoice_unavailable_reason: !canAccessInvoices
        ? 'permission_denied'
        : (row.xero_invoice_id ? null : 'not_linked'),
      historical_only: true,
      source: 'pilot_historical_ledger',
      provenance: 'provider_and_accounting_evidence',
      provider_only: false,
      accounting_reconciled: true,
    }));
    const betaPayments = (betaData || []).map((row) => {
      const link = betaLinksByHistoryId.get(row.id);
      const isReconciled = !!link;
      const hasInvoice = isReconciled && !!link.xero_invoice_id;
      return {
        id: row.id,
        period: null,
        charge_date: row.charge_date,
        amount_minor: row.amount_minor,
        currency: row.currency,
        provider_payment_id: row.provider_payment_id,
        provider_status: row.provider_status,
        xero_invoice_id: canAccessInvoices && hasInvoice ? link.xero_invoice_id : null,
        xero_invoice_number: canAccessInvoices && isReconciled ? link.xero_invoice_number : null,
        invoice_available: canAccessInvoices && hasInvoice,
        invoice_unavailable_reason: !canAccessInvoices
          ? 'permission_denied'
          : (hasInvoice ? null : (isReconciled ? 'not_linked' : 'accounting_unreconciled')),
        historical_only: true,
        source: 'beta_provider_history',
        provenance: isReconciled
          ? 'provider_and_accounting_evidence'
          : 'provider_evidence_only',
        provider_only: !isReconciled,
        accounting_reconciled: isReconciled,
      };
    });
    const alphaPayments = (alphaData || []).map((row) => {
      const candidate = alphaLinksByHistoryId.get(row.id);
      // A link must identify the same immutable provider payment as well as the
      // exact history row, tenant and member before it can expose accounting data.
      const link = candidate?.provider_payment_id === row.provider_payment_id ? candidate : null;
      const isReconciled = !!link;
      const hasInvoice = isReconciled && !!link.xero_invoice_id;
      return {
        id: row.id,
        period: null,
        charge_date: row.charge_date,
        amount_minor: row.amount_minor,
        currency: row.currency,
        provider_payment_id: row.provider_payment_id,
        provider_status: row.provider_status,
        xero_invoice_id: canAccessInvoices && hasInvoice ? link.xero_invoice_id : null,
        xero_invoice_number: canAccessInvoices && isReconciled ? link.xero_invoice_number : null,
        invoice_available: canAccessInvoices && hasInvoice,
        invoice_unavailable_reason: !canAccessInvoices
          ? 'permission_denied'
          : (hasInvoice ? null : (isReconciled ? 'not_linked' : 'accounting_unreconciled')),
        historical_only: true,
        source: 'alpha_provider_history',
        provenance: isReconciled
          ? 'provider_and_accounting_evidence'
          : 'provider_evidence_only',
        provider_only: !isReconciled,
        accounting_reconciled: isReconciled,
      };
    });

    return res.json({
      payments: [...pilotPayments, ...betaPayments, ...alphaPayments].sort((a, b) =>
        String(b.charge_date || b.period || '').localeCompare(String(a.charge_date || a.period || ''))),
    });
  };
}

export default createHistoricalDdHandler();