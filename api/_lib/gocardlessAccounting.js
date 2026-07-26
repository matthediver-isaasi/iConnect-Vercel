// GoCardless Phase 4 — accounting posting for confirmed DD instalments.
//
// Posts each confirmed instalment as a payment against the membership
// invoice already linked on the membership history row, through the
// provider-agnostic accountingProvider facade (dual Xero/QBO columns —
// see replit.md "Accounting provider dual invoice columns").
//
// Rules:
//   - Best-effort but NEVER silent: failures set
//     gocardless_payments.accounting_sync_status='failed' + the error text
//     (mirrors the membership invoice accounting_sync_status pattern).
//   - No accounting provider connected, or no invoice on the history row
//     → status 'skipped' with a reason (not an error).
//   - Idempotent: a payment row already 'posted' is never re-posted.
//   - Dedicated GoCardless bank-account settings
//     (xero_gocardless_bank_account_code / quickbooks_gocardless_bank_account_id)
//     fall back to the Stripe ones when unset.
//
// Dependencies injectable for tests: { db, getProvider }.

import { supabase } from './database.js';
import {
  getAccountingProvider,
  PROVIDER_NONE,
  PROVIDER_XERO,
} from './accountingProvider.js';
import { membershipHistoryTableForAgreement } from './gocardlessDirectDebit.js';

const BANK_SETTING_KEYS = {
  xero: 'xero_gocardless_bank_account_code',
  quickbooks: 'quickbooks_gocardless_bank_account_id',
};

async function setSyncStatus(db, paymentRowId, patch) {
  const { error } = await db
    .from('gocardless_payments')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', paymentRowId);
  if (error) console.error('[gocardlessAccounting] update sync status failed:', error.message);
}

/**
 * Post a confirmed DD instalment to the tenant's accounting provider.
 *
 * @param {Object} args
 * @param {Object} args.agreement   membership_billing_agreements row
 * @param {Object} args.paymentRow  gocardless_payments row (id, amount_minor, gocardless_payment_id, accounting_sync_status)
 * @param {Object} [deps]           { db, getProvider } test injection
 * @returns {Promise<{status: 'posted'|'skipped'|'failed', reason?: string}>}
 */
export async function postDdInstalmentToAccounting({ agreement, paymentRow }, deps = {}) {
  const db = deps.db || supabase;
  const getProvider = deps.getProvider || getAccountingProvider;

  if (!agreement || !paymentRow?.id) {
    return { status: 'skipped', reason: 'missing agreement or payment row' };
  }
  if (paymentRow.accounting_sync_status === 'posted') {
    return { status: 'skipped', reason: 'already posted' };
  }

  try {
    const provider = await getProvider(agreement.tenant_id);
    if (!provider || provider.name === PROVIDER_NONE) {
      await setSyncStatus(db, paymentRow.id, { accounting_sync_status: 'skipped', accounting_sync_error: 'no accounting provider connected' });
      return { status: 'skipped', reason: 'no accounting provider connected' };
    }

    // Find the membership invoice linked on the history row (dual columns:
    // accounting_invoice_id is generic; xero_invoice_id is legacy Xero-only).
    const historyTable = membershipHistoryTableForAgreement(agreement);
    if (!historyTable) {
      await setSyncStatus(db, paymentRow.id, { accounting_sync_status: 'skipped', accounting_sync_error: 'no membership history table for agreement' });
      return { status: 'skipped', reason: 'no membership history table' };
    }
    const { data: historyRow, error: histErr } = await db
      .from(historyTable)
      .select('id, accounting_provider, accounting_invoice_id, accounting_invoice_number, xero_invoice_id, xero_invoice_number')
      .eq('billing_agreement_id', agreement.id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (histErr) throw new Error(`load membership history failed: ${histErr.message}`);

    const invoiceId = historyRow?.accounting_invoice_id || historyRow?.xero_invoice_id || null;
    const invoiceNumber = historyRow?.accounting_invoice_number || historyRow?.xero_invoice_number || null;
    if (!invoiceId) {
      await setSyncStatus(db, paymentRow.id, { accounting_sync_status: 'skipped', accounting_sync_error: 'no invoice linked on membership history row' });
      return { status: 'skipped', reason: 'no linked invoice' };
    }

    const amountMinor = paymentRow.amount_minor;
    if (!Number.isInteger(amountMinor) || amountMinor <= 0) {
      await setSyncStatus(db, paymentRow.id, { accounting_sync_status: 'failed', accounting_sync_error: 'payment row has no positive amount_minor' });
      return { status: 'failed', reason: 'missing amount' };
    }

    const reference = `GoCardless DD: ${paymentRow.gocardless_payment_id}`;
    const result = await provider.applyStripePaymentToInvoice({
      appTenantId: agreement.tenant_id,
      invoiceId,
      xeroInvoiceId: invoiceId,
      amount: amountMinor / 100,
      reference,
      bankAccountSettingKey: BANK_SETTING_KEYS[provider.name] || null,
      paidAt: paymentRow.confirmed_at || new Date().toISOString(),
    });

    const patch = {
      accounting_sync_status: 'posted',
      accounting_synced_at: new Date().toISOString(),
      accounting_sync_error: null,
      accounting_provider: provider.name,
      accounting_invoice_id: invoiceId,
      accounting_invoice_number: result?.invoiceNumber || invoiceNumber,
    };
    if (provider.name === PROVIDER_XERO) {
      patch.xero_invoice_id = invoiceId;
      patch.xero_invoice_number = result?.invoiceNumber || invoiceNumber;
    }
    await setSyncStatus(db, paymentRow.id, patch);
    return { status: 'posted' };
  } catch (err) {
    // Loud, retryable failure — never swallowed.
    console.error('[gocardlessAccounting] posting failed:', err.message);
    await setSyncStatus(db, paymentRow.id, {
      accounting_sync_status: 'failed',
      accounting_sync_error: String(err.message || err).slice(0, 500),
    });
    return { status: 'failed', reason: err.message };
  }
}
