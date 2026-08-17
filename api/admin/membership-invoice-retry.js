// Task #1112 — Admin endpoint to retry accounting-invoice creation for a
// membership history row whose original invoice mint failed (and was
// flagged with `accounting_sync_status='failed'`). Requires tenant admin
// RBAC.
//
// On success: writes invoice id/number onto the row via
// buildInvoiceColumnUpdate, clears accounting_sync_status/error, and
// kicks reconcileMembershipInvoicePayment so payment_status flips to
// 'paid' immediately if the invoice was minted as paid.

import { getTenantContext, hasAdminAccess } from '../_lib/tenantContext.js';
import { supabase } from '../_lib/database.js';
import { getAccountingProvider, buildInvoiceColumnUpdate } from '../_lib/accountingProvider.js';
import { reconcileMembershipInvoicePayment } from '../_lib/membershipPaymentReconciliation.js';
import { resolveMembershipNominalCode } from '../_lib/membershipNominalCode.js';
import { simulateMembershipForOrg, simulateMembershipForMember } from '../_lib/membershipSimulation.js';
import { shouldSuppressAnnualInvoice } from '../_lib/membershipInstalmentInvoicing.js';

const ORG_TABLE = 'organisation_membership_history';
const MEMBER_TABLE = 'member_membership_history';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!supabase) return res.status(503).json({ error: 'Database not configured' });

  const tenantContext = await getTenantContext(req);
  if (!tenantContext?.isAuthenticated) return res.status(401).json({ error: 'Authentication required' });
  if (!(await hasAdminAccess(tenantContext))) return res.status(403).json({ error: 'Admin access required' });

  const { recordId, table } = req.body || {};
  if (!recordId) return res.status(400).json({ error: 'recordId is required' });
  if (table !== ORG_TABLE && table !== MEMBER_TABLE) {
    return res.status(400).json({ error: 'Invalid table' });
  }

  const appTenantId = tenantContext.tenantId;
  if (!appTenantId) return res.status(400).json({ error: 'Tenant context required' });

  const { data: row, error: rowErr } = await supabase
    .from(table)
    .select('*')
    .eq('id', recordId)
    .maybeSingle();

  if (rowErr) {
    console.error('[admin/membership-invoice-retry] lookup failed:', rowErr);
    return res.status(500).json({ error: 'Failed to load record' });
  }
  if (!row) return res.status(404).json({ error: 'Record not found' });
  if (row.tenant_id !== appTenantId) return res.status(403).json({ error: 'Cross-tenant access denied' });

  // If the row already has an invoice id, the retry is a no-op — direct
  // the caller to the regular "Check now" reconcile endpoint instead.
  if (row.accounting_invoice_id || row.xero_invoice_id) {
    return res.status(409).json({
      error: 'Record already has an accounting invoice; use the reconcile endpoint to refresh payment status.',
      invoiceId: row.accounting_invoice_id || row.xero_invoice_id,
    });
  }

  // Task #3633: rows on a per-instalment monthly plan are invoiced one small
  // invoice per collection — an annual invoice must never be raised for them.
  try {
    if (await shouldSuppressAnnualInvoice(row)) {
      return res.status(409).json({
        error: 'This membership is on a per-instalment monthly plan — each collection gets its own invoice, so no annual invoice should be created.',
      });
    }
  } catch (suppressErr) {
    // FAIL CLOSED: never raise an annual invoice when the mode is unknowable.
    console.error('[membership-invoice-retry] suppression check failed:', suppressErr.message);
    return res.status(503).json({
      error: `Could not verify this membership's invoicing mode — annual invoice not created. Please retry. (${suppressErr.message})`,
    });
  }

  const isOrg = table === ORG_TABLE;
  let contactName = 'Organisation';
  let invoicingAddress = null;
  let invoicingEmail = null;

  try {
    if (isOrg) {
      const { data: org } = await supabase
        .from('organization')
        .select('name, invoicing_address, invoicing_email')
        .eq('id', row.organization_id)
        .single();
      contactName = org?.name || 'Organisation';
      invoicingAddress = org?.invoicing_address || null;
      invoicingEmail = org?.invoicing_email || null;
    } else {
      const { data: m } = await supabase
        .from('member')
        .select('first_name, last_name, email')
        .eq('id', row.member_id)
        .single();
      contactName = [m?.first_name, m?.last_name].filter(Boolean).join(' ') || 'Member';
      invoicingEmail = m?.email || null;
    }
  } catch (e) {
    console.warn('[admin/membership-invoice-retry] could not load contact info:', e.message);
  }

  const reference = row.purchase_order_number
    ? `Membership ${row.membership_year} - PO: ${row.purchase_order_number}`
    : `Membership ${row.membership_year}`;

  // The history row doesn't store the matched tier's nominal code, so run a
  // best-effort simulation against the CURRENT config to recover a per-tier
  // override. If the sim fails (e.g. config changed since the row was made)
  // fall back to the global membership_nominal_ledger setting via the
  // resolver, which is the pre-override behaviour.
  let retryNominalCode = null;
  try {
    const simResult = isOrg
      ? await simulateMembershipForOrg(appTenantId, row.organization_id, { targetYear: row.membership_year })
      : await simulateMembershipForMember(appTenantId, row.member_id, { targetYear: row.membership_year });
    retryNominalCode = await resolveMembershipNominalCode(supabase, appTenantId, simResult?.success ? simResult : null);
  } catch (e) {
    console.warn('[admin/membership-invoice-retry] nominal code resolution failed (using provider default):', e.message);
  }

  try {
    const provider = await getAccountingProvider(appTenantId);
    const invoice = await provider.createMembershipInvoice({
      appTenantId,
      organizationName: contactName,
      invoicingEmail,
      invoicingAddress: invoicingAddress || undefined,
      membershipYear: row.membership_year,
      tierLabel: row.tier_label,
      finalCost: parseFloat(row.final_cost),
      currency: row.currency || 'GBP',
      reference,
      // The row doesn't store the band's VAT shape, so fall back to the
      // provider's per-Item default (resolveMembershipItemId →
      // SalesTaxCodeRef on Items / Xero default account code).
      vatRate: null,
      nominalCode: retryNominalCode,
      markAsPaid: !!row.stripe_payment_intent_id,
      stripePaymentIntentId: row.stripe_payment_intent_id || null,
      invoiceDescription: null,
    });

    if (!invoice) throw new Error('Provider returned no invoice payload');

    const update = {
      ...buildInvoiceColumnUpdate({
        invoice_id: invoice.invoice_id,
        invoice_number: invoice.invoice_number,
        provider: provider.name,
      }),
      accounting_sync_status: null,
      accounting_sync_error: null,
    };

    const { error: updErr } = await supabase
      .from(table)
      .update(update)
      .eq('id', recordId);

    if (updErr) {
      console.error('[admin/membership-invoice-retry] failed to persist invoice cols:', updErr);
      return res.status(500).json({
        ok: false,
        error: `Invoice ${invoice.invoice_number} was created at the accounting provider but the membership row could not be updated: ${updErr.message}. Manual reconciliation required.`,
        invoice_number: invoice.invoice_number,
        invoice_id: invoice.invoice_id,
      });
    }

    // Best-effort: if the invoice was marked-as-paid at the provider,
    // flip the row's payment_status immediately.
    try {
      // Task #3253 — pass the request-derived base URL so the
      // membership-paid workflow can mint {{set_password_url}} links.
      const reconcileBaseUrl = req.headers.host
        ? `${req.headers['x-forwarded-proto'] || 'https'}://${req.headers.host}`
        : '';
      await reconcileMembershipInvoicePayment({ table, recordId, baseUrl: reconcileBaseUrl });
    } catch (recErr) {
      console.warn('[admin/membership-invoice-retry] inline reconcile failed (non-fatal):', recErr.message);
    }

    return res.status(200).json({
      ok: true,
      invoice_number: invoice.invoice_number,
      invoice_id: invoice.invoice_id,
    });
  } catch (err) {
    console.error('[admin/membership-invoice-retry] provider createMembershipInvoice failed:', err);
    // Persist the latest error so the badge still reflects reality.
    try {
      await supabase
        .from(table)
        .update({
          accounting_sync_status: 'failed',
          accounting_sync_error: String(err.message || err).slice(0, 1000),
        })
        .eq('id', recordId);
    } catch {}
    return res.status(500).json({ ok: false, error: err.message || 'Invoice creation failed' });
  }
}
