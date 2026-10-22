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
import { assertBnmsAccountingContext } from './xero.js';
import { resolveBetaAccountingContext, BNMS_BETA_TENANT, BNMS_BETA_REVENUE } from './bnmsBetaAccounting.js';
import { resolveAlphaAccountingContext, findAlphaAdoption } from './bnmsAlphaAccounting.js';
import { resolveManualAccountingContext } from './bnmsManualCohort.js';
import {
  getAccountingProvider,
  PROVIDER_NONE,
  PROVIDER_XERO,
} from './accountingProvider.js';
import { membershipHistoryTableForAgreement } from './gocardlessDirectDebit.js';
import {
  assertDdInstalmentPaymentEvidence, assertInstalmentProviderMode, resolveInstalmentCustomerIdentity,
} from './instalmentAccountingSafety.js';
import {
  findGoCardlessAccountingRequest, goCardlessAccountingQueueEnabled,
  queueGoCardlessAccountingPayment, resumeGoCardlessAccountingRequest,
} from './accountingQueueGoCardless.js';
import {
  isPerInstalmentAgreement,
  mintOrPayInstalmentInvoice,
  buildInstalmentOutcomePatch,
  claimableStatuses,
} from './membershipInstalmentInvoicing.js';

const BANK_SETTING_KEYS = {
  xero: 'xero_gocardless_bank_account_code',
  quickbooks: 'quickbooks_gocardless_bank_account_id',
};

// Catch-up payments are split into exact arrears periods by the shared
// accounting ledger, so this helper intentionally has no aggregate payment-row
// claim. The caller owns the per-period CAS and supplies a deterministic key.
export async function postDdArrearsPeriodToAccounting({
  agreement, amountMinor, externalReference,
}, deps = {}) {
  if (agreement?.metadata?.dd?.voucher_funding) {
    const db = deps.db || supabase;
    const match = /^(PM[A-Za-z0-9]+):arrears:([^:]+)$/.exec(String(externalReference || ''));
    if (!match) throw new Error('Funded arrears requires an original payment and period identity');
    const payment = await db.from('gocardless_payments').select('*')
      .eq('tenant_id', agreement.tenant_id).eq('gocardless_payment_id', match[1]).single();
    if (payment.error || !payment.data) throw new Error('Funded arrears cash evidence is unavailable');
    await postDdInstalmentToAccounting({ agreement, paymentRow: payment.data }, deps);
    const intent = await db.from('membership_monthly_collection_intent').select('period_ids')
      .eq('tenant_id', agreement.tenant_id).eq('provider_reference', match[1]).maybeSingle();
    const index = intent.data?.period_ids?.indexOf(match[2]);
    if (intent.error || index == null || index < 0) throw new Error('Funded arrears period does not match the immutable cash intent');
    const receipt = await db.from('membership_voucher_collection').select('*')
      .eq('tenant_id', agreement.tenant_id).eq('provider', 'gocardless')
      .eq('external_reference', `${match[1]}:unit:${index + 1}`).single();
    if (receipt.error || receipt.data?.accounting_status !== 'complete') throw new Error('Funded arrears accounting is not complete');
    return { status: 'posted', invoiceId: receipt.data.accounting_invoice_id,
      invoiceNumber: receipt.data.accounting_invoice_number, paymentRecorded: true };
  }
  if (!isPerInstalmentAgreement(agreement)) return { status: 'skipped', reason: 'agreement is not per-instalment' };
  const db = deps.db || supabase;
  const provider = await (deps.getProvider || getAccountingProvider)(agreement.tenant_id);
  if (!provider || provider.name === PROVIDER_NONE) return { status: 'skipped', reason: 'no accounting provider connected' };
  await assertInstalmentProviderMode(agreement, provider);
  const sourcePaymentId = /^(PM[A-Za-z0-9]+):arrears:[^:]+$/.exec(String(externalReference || ''))?.[1];
  if (!sourcePaymentId) throw new Error('DD arrears requires an original GoCardless payment reference');
  const { data: payment, error: paymentError } = await db.from('gocardless_payments').select('*')
    .eq('tenant_id', agreement.tenant_id).eq('gocardless_payment_id', sourcePaymentId).maybeSingle();
  if (paymentError) throw new Error(`DD arrears payment evidence lookup failed: ${paymentError.message}`);
  if (payment?.accounting_sync_status === 'skipped') {
    throw new Error('DD arrears accounting source is explicitly skipped');
  }
  assertDdInstalmentPaymentEvidence({ agreement, payment });
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0 || amountMinor > payment.amount_minor) {
    throw new Error('DD arrears allocation exceeds confirmed payment evidence');
  }
  const snapshot = agreement.metadata?.dd;
  if (snapshot?.accounting_migration || (agreement.tenant_id === BNMS_BETA_TENANT && Object.hasOwn(BNMS_BETA_REVENUE, agreement.member_id))
    || await findAlphaAdoption(agreement, db)) {
    throw new Error('BNMS pilot accounting requires a confirmed canonical dynamic payment, not arrears/history');
  }
  const outcome = await mintOrPayInstalmentInvoice({
    provider, agreement, snapshot, amountMinor,
    reference: `Membership ${snapshot?.membership_year || ''} - DD arrears ${externalReference}`.trim(),
    paymentReference: `GoCardless DD arrears: ${externalReference}`,
    idempotencyKey: `mii-gc-arrears-${externalReference}`,
    bankAccountSettingKey: BANK_SETTING_KEYS[provider.name] || null,
    strictBankAccount: true, db,
  });
  if (!outcome.paymentRecorded) throw new Error('arrears invoice created but payment not recorded');
  return { status: 'posted', invoiceId: outcome.invoiceId || null };
}

async function setSyncStatus(db, paymentRowId, patch, { preservePosted = false } = {}) {
  let query = db
    .from('gocardless_payments')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', paymentRowId);
  if (preservePosted) query = query.or('accounting_sync_status.is.null,accounting_sync_status.neq.posted');
  const { error } = await query;
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
  if (paymentRow.accounting_sync_status === 'skipped') {
    return { status: 'skipped', reason: 'accounting posting is explicitly skipped' };
  }
  if (agreement.metadata?.dd?.voucher_funding) {
    if (paymentRow.tenant_id !== agreement.tenant_id || !['confirmed','paid_out'].includes(paymentRow.status)
        || !/^PM[A-Za-z0-9]+$/.test(paymentRow.gocardless_payment_id || '')) {
      throw new Error('Confirmed tenant-bound Direct Debit cash evidence is required');
    }
    const plan = await db.from('membership_payment_plans').select('billing_agreement_id')
      .eq('id', paymentRow.plan_id).eq('tenant_id', agreement.tenant_id).single();
    if (plan.error || plan.data?.billing_agreement_id !== agreement.id) throw new Error('Direct Debit cash belongs to another membership agreement');
    const marked = await db.from('gocardless_payments').update({
      metadata: { ...(paymentRow.metadata || {}), membership_voucher_settlement_id: agreement.metadata.dd.voucher_funding.settlement_id },
    }).eq('id', paymentRow.id).eq('tenant_id', agreement.tenant_id);
    if (marked.error) throw new Error('Could not preserve original voucher funding on the collection');
    await (await import('./membershipVoucherMonthly.js')).commitMembershipVoucherMonthly(db, agreement);
    const result = await (await import('./membershipVoucherMonthlyAccounting.js')).postMembershipVoucherMonthlyCashBatch({
      db, agreement, provider: 'gocardless', externalReference: paymentRow.gocardless_payment_id,
      cashMinor: Number(paymentRow.amount_minor), currency: paymentRow.currency || agreement.metadata.dd.currency,
    }, deps.voucherAccounting);
    const saved = await db.from('gocardless_payments').update({ accounting_sync_status: 'posted', accounting_sync_error: null })
      .eq('id', paymentRow.id).eq('tenant_id', agreement.tenant_id);
    if (saved.error) throw new Error('Could not save funded Direct Debit accounting completion');
    return result;
  }

  try {
    // Accepted queue ownership survives flag/provider changes and is checked
    // before reconstructing any current accounting preparation.
    const owned = await (deps.findQueuedRequest || findGoCardlessAccountingRequest)({
      db, tenantId: agreement.tenant_id, paymentId: paymentRow.id,
      allowMissingQueue: !goCardlessAccountingQueueEnabled(),
    });
    if (owned) return resumeGoCardlessAccountingRequest({ db, row: owned, adapters: deps.adapters });
    const migration = agreement.metadata?.dd?.accounting_migration;
    const betaContext = await resolveBetaAccountingContext(agreement, db);
    const isPilot = agreement.tenant_id === BNMS_BETA_TENANT
      && agreement.member_id === '33e5d54d-162e-436d-9bff-ec6676d198f9';
    const alphaContext = betaContext || isPilot ? null : await resolveAlphaAccountingContext(agreement, db);
    const manualContext = betaContext || isPilot || alphaContext ? null : await resolveManualAccountingContext(agreement, db);
    const ddAccountingMigration = betaContext || alphaContext || manualContext || (migration ? {
      snapshot: migration, memberId: agreement.member_id,
      environment: agreement.environment, provider: agreement.provider,
    } : null);
    if (ddAccountingMigration) {
      assertBnmsAccountingContext(agreement.tenant_id, ddAccountingMigration);
      if (!isPerInstalmentAgreement(agreement)
        || agreement.metadata.dd.collection_policy?.version !== 1
        || agreement.metadata.dd.collection_policy.pricing_policy !== 'dynamic') {
        throw new Error('BNMS pilot accounting requires dynamic per-instalment collections');
      }
      // Re-read canonical evidence; caller metadata and historical imports
      // cannot authorize new invoices. Only explicitly scoped pilot/beta releases.
      const { data: canonical, error } = await db.from('gocardless_payments').select('*')
        .eq('id', paymentRow.id).eq('tenant_id', agreement.tenant_id).maybeSingle();
      if (error || !canonical || !['confirmed', 'paid_out'].includes(canonical.status)
        || canonical.environment !== 'live' || canonical.currency !== 'GBP'
        || (alphaContext && canonical.plan_id !== alphaContext.planId)
        || (manualContext && canonical.plan_id !== manualContext.planId)
        || !canonical.charge_date || canonical.charge_date < '2026-10-01'
        || canonical.gocardless_mandate_id !== agreement.gocardless_mandate_id
        || canonical.gocardless_payment_id !== paymentRow.gocardless_payment_id
        || canonical.amount_minor !== paymentRow.amount_minor) {
        throw new Error('BNMS pilot accounting requires a future confirmed canonical payment');
      }
      paymentRow = canonical;
      if (paymentRow.accounting_sync_status === 'posted') return { status: 'skipped', reason: 'already posted' };
    }
    const provider = await getProvider(agreement.tenant_id);
    if (ddAccountingMigration && provider?.name !== 'xero') {
      throw new Error('BNMS pilot accounting provider must be Xero');
    }
    if (!provider || provider.name === PROVIDER_NONE) {
      await setSyncStatus(db, paymentRow.id, { accounting_sync_status: 'skipped', accounting_sync_error: 'no accounting provider connected' });
      return { status: 'skipped', reason: 'no accounting provider connected' };
    }
    const { data: canonical, error: evidenceError } = await db.from('gocardless_payments').select('*')
      .eq('id', paymentRow.id).eq('tenant_id', agreement.tenant_id).maybeSingle();
    if (evidenceError) throw new Error(`DD instalment payment evidence lookup failed: ${evidenceError.message}`);
    if (['posted', 'skipped'].includes(canonical?.accounting_sync_status)) {
      return { status: 'skipped', reason: `accounting posting is already ${canonical.accounting_sync_status}` };
    }
    assertDdInstalmentPaymentEvidence({ agreement, payment: canonical, expectedPayment: paymentRow });
    paymentRow = canonical;
    const expectedProviderContext = await assertInstalmentProviderMode(agreement, provider);
    await resolveInstalmentCustomerIdentity({ agreement, db });

    const instAmountMinor = paymentRow.amount_minor;
    const queued = await (deps.queueAccounting || queueGoCardlessAccountingPayment)({
      db, agreement, paymentRow, provider, ddAccountingMigration,
    }, deps.queueDependencies || {});
    if (queued !== undefined) {
      // Only the verified queue source linker can mark this payment posted.
      // Failed remains eligible for the accounting-only reconciliation sweep.
      if (queued.status !== 'posted') await setSyncStatus(db, paymentRow.id, {
        accounting_sync_status: 'failed',
        accounting_sync_error: queued.reason || 'Accounting request pending central reconciliation',
      }, { preservePosted: true });
      return queued;
    }

    // Task #3633: per-instalment invoicing mode — this instalment gets its
    // OWN small paid invoice instead of being applied to an annual invoice.
    if (isPerInstalmentAgreement(agreement)) {
      if (!Number.isInteger(instAmountMinor) || instAmountMinor <= 0) {
        await setSyncStatus(db, paymentRow.id, { accounting_sync_status: 'failed', accounting_sync_error: 'payment row has no positive amount_minor' });
        return { status: 'failed', reason: 'missing amount' };
      }

      // Atomic claim: CAS the payment row's sync status to 'posting'. Only
      // one concurrent webhook/reconcile caller wins; a crashed 'posting'
      // claim is only reclaimable via the reconcile cron (reclaimStale).
      const { data: claimed, error: claimErr } = await db
        .from('gocardless_payments')
        .update({ accounting_sync_status: 'posting', updated_at: new Date().toISOString() })
        .eq('id', paymentRow.id)
        .eq('tenant_id', agreement.tenant_id)
        .or(`accounting_sync_status.is.null,accounting_sync_status.in.(${claimableStatuses({ reclaimStale: deps.reclaimStale === true }).join(',')})`)
        .select('id, accounting_invoice_id, accounting_invoice_number');
      if (claimErr) throw new Error(`claim payment row failed: ${claimErr.message}`);
      const claimedRow = claimed?.[0];
      if (!claimedRow) return { status: 'skipped', reason: 'already posted or another worker is posting' };

      try {
        let snapshot = agreement.metadata?.dd || agreement.metadata?.card || null;
        if (snapshot?.collection_policy?.version === 1 && snapshot.collection_policy.pricing_policy === 'dynamic') {
          const { data: reservation, error } = await db.from('gocardless_collection_reservations').select('*')
            .eq('tenant_id', agreement.tenant_id).eq('billing_agreement_id', agreement.id)
            .eq('gocardless_payment_id', paymentRow.gocardless_payment_id).maybeSingle();
          if (error || !reservation || reservation.amount_minor !== instAmountMinor
            || reservation.currency !== paymentRow.currency) {
            throw new Error('Dynamic instalment has no matching immutable collection/tax evidence');
          }
          const pilotTerm = agreement.metadata?.dd?.commitment;
          if (ddAccountingMigration && (reservation.plan_id !== paymentRow.plan_id
            || !reservation.due_date || reservation.due_date < '2026-10-01'
            || reservation.currency !== 'GBP'
            || !pilotTerm?.term_key || reservation.term_key !== pilotTerm.term_key
            || !pilotTerm.term_start_date || !pilotTerm.term_end_date
            || reservation.due_date < pilotTerm.term_start_date || reservation.due_date > pilotTerm.term_end_date
            || paymentRow.charge_date < reservation.due_date || paymentRow.charge_date > pilotTerm.term_end_date
            || reservation.requested_charge_date !== paymentRow.charge_date)) {
            throw new Error('BNMS pilot payment has no matching future managed reservation');
          }
          snapshot = { ...snapshot, ...reservation.price_snapshot, collection_price_snapshot: reservation.price_snapshot };
        }
        const outcome = await mintOrPayInstalmentInvoice({
          provider,
          agreement,
          snapshot,
          amountMinor: instAmountMinor,
          reference: `Membership ${snapshot?.membership_year || ''} - DD instalment ${paymentRow.gocardless_payment_id}`.trim(),
          paymentReference: `GoCardless DD: ${paymentRow.gocardless_payment_id}`,
          existingInvoiceId: claimedRow.accounting_invoice_id || paymentRow.accounting_invoice_id || null,
          existingInvoiceNumber: claimedRow.accounting_invoice_number || paymentRow.accounting_invoice_number || null,
          idempotencyKey: `mii-gc-${paymentRow.gocardless_payment_id || paymentRow.id}`,
          bankAccountSettingKey: BANK_SETTING_KEYS[provider.name] || null,
          // The GC rail must use ITS OWN bank account — never fall back to
          // the Stripe one; a missing setting surfaces as invoice_unpaid.
          strictBankAccount: true,
          ddAccountingMigration,
          db,
        });
        await setSyncStatus(db, paymentRow.id, buildInstalmentOutcomePatch({ providerName: provider.name, ...outcome }));
        return outcome.paymentRecorded
          ? { status: 'posted', invoiceId: outcome.invoiceId, invoiceNumber: outcome.invoiceNumber }
          : {
            status: 'invoice_unpaid',
            invoiceId: outcome.invoiceId,
            invoiceNumber: outcome.invoiceNumber,
            reason: 'invoice created but payment not recorded',
          };
      } catch (instErr) {
        console.error('[gocardlessAccounting] per-instalment posting failed:', instErr.message);
        await setSyncStatus(db, paymentRow.id, {
          accounting_sync_status: 'failed',
          accounting_sync_error: String(instErr.message || instErr).slice(0, 500),
        });
        return { status: 'failed', reason: instErr.message };
      }
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
      await setSyncStatus(db, paymentRow.id, { accounting_sync_status: 'failed', accounting_sync_error: 'waiting for invoice linked on membership history row' });
      return { status: 'pending', reason: 'waiting for linked invoice' };
    }

    const amountMinor = paymentRow.amount_minor;
    if (!Number.isInteger(amountMinor) || amountMinor <= 0) {
      await setSyncStatus(db, paymentRow.id, { accounting_sync_status: 'failed', accounting_sync_error: 'payment row has no positive amount_minor' });
      return { status: 'failed', reason: 'missing amount' };
    }

    const reference = `GoCardless DD: ${paymentRow.gocardless_payment_id}`;
    const result = await provider.applyStripePaymentToInvoice({
      expectedProviderContext,
      appTenantId: agreement.tenant_id,
      invoiceId,
      xeroInvoiceId: invoiceId,
      amount: amountMinor / 100,
      reference,
      bankAccountSettingKey: BANK_SETTING_KEYS[provider.name] || null,
      paidAt: paymentRow.confirmed_at || new Date().toISOString(),
    });
    if (result?.payment_recorded !== true && result?.raw?.payment_recorded !== true) {
      await setSyncStatus(db, paymentRow.id, { accounting_sync_status: 'invoice_unpaid',
        accounting_sync_error: 'provider did not verify payment recording' });
      return { status: 'invoice_unpaid', reason: 'payment not recorded' };
    }

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
    return { status: err.code === 'GC_QUEUE_WAITING_FOR_INVOICE' ? 'pending' : 'failed', reason: err.message };
  }
}
