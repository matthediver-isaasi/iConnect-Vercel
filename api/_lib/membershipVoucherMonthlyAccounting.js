import { invoiceReferenceFromRow } from './feeTokenInvoiceReference.js';
import { monthlyFundingSlice, fundedMonthlySnapshot, fundedInstalmentDate } from './membershipVoucherMonthly.js';
import { accountMembershipVoucherSettlement } from './membershipVoucherAccounting.js';
import { pinMembershipAccountingBinding } from './membershipVoucherAccountingBinding.js';

export async function postMembershipVoucherMonthlyPayment({
  db, agreement, settlement: suppliedSettlement = null, provider: paymentProvider,
  externalReference, cashMinor, currency, stripePaymentIntentId = null, collectionDate = null,
}, deps = {}) {
  const snapshot = agreement.metadata?.card || agreement.metadata?.dd;
  const funding = snapshot?.voucher_funding;
  if (!funding) throw new Error('Frozen monthly voucher funding is required');
  const { data: loaded, error: loadError } = suppliedSettlement ? { data: suppliedSettlement }
    : await db.from('membership_voucher_settlement').select('*')
      .eq('id', funding.settlement_id).eq('tenant_id', agreement.tenant_id).single();
  if (loadError || !loaded || !['plan_committed', 'committed'].includes(loaded.state)) throw new Error('Committed monthly funding unavailable');
  if (cashMinor !== funding.cash_per_instalment_minor || currency.toUpperCase() !== loaded.funding.currency
      || (paymentProvider === 'stripe' && !/^pi_[A-Za-z0-9]+$/.test(stripePaymentIntentId || ''))) {
    throw new Error('Cash evidence does not match the purchased monthly instalment');
  }
  const { data: token, error: tokenError } = await db.from('membership_fee_token').select('*')
    .eq('id', loaded.fee_token_id).eq('tenant_id', loaded.tenant_id).single();
  if (tokenError || !token) throw new Error('Monthly funding token is unavailable');
  const { data: receipt, error: claimError } = await db.rpc('membership_voucher_claim_collection', {
    p_tenant_id: loaded.tenant_id, p_settlement_id: loaded.id, p_provider: paymentProvider,
    p_reference: externalReference, p_cash_minor: cashMinor,
    p_collection_date: collectionDate,
  });
  if (claimError) throw new Error(claimError.message);
  if (receipt.accounting_status === 'complete') return { status: 'posted', receipt };
  if (paymentProvider === 'voucher' && receipt.collection_date > new Date().toISOString().slice(0, 10)) {
    return { status: 'scheduled', receipt };
  }
  const { data: history, error: historyError } = await db.from('member_membership_history').select('*')
    .eq('id', loaded.history_record_id).eq('tenant_id', loaded.tenant_id).single();
  if (historyError || !history) throw new Error('Monthly membership history is unavailable');
  const existingAnnual = invoiceReferenceFromRow(history) || invoiceReferenceFromRow(token);
  const perInstalment = snapshot.invoicing_mode === 'per_instalment' && !existingAnnual;
  const facade = deps.facade || await import('./accountingProvider.js');
  let reference = receipt.accounting_invoice_id ? {
    provider: receipt.accounting_provider, invoiceId: receipt.accounting_invoice_id,
    invoiceNumber: receipt.accounting_invoice_number,
  } : existingAnnual;
  let accountingProvider = reference ? facade.getAccountingProviderByName(reference.provider)
    : (receipt.accounting_provider || loaded.accounting_provider) ? facade.getAccountingProviderByName(receipt.accounting_provider || loaded.accounting_provider)
      : await facade.getAccountingProvider(loaded.tenant_id);
  const slice = monthlyFundingSlice(funding, receipt.ordinal);
  try {
    const expectedProviderContext = await pinMembershipAccountingBinding(db, loaded, reference?.provider || accountingProvider.name, deps);
    if (loaded.accounting_provider && reference?.provider && loaded.accounting_provider !== reference.provider) {
      throw new Error('Existing invoice provider conflicts with the frozen monthly purchase');
    }
    if (!loaded.accounting_provider) {
      if (!['xero', 'quickbooks'].includes(accountingProvider.name)) throw new Error('Accounting provider is not configured');
      const pinned = await db.from('membership_voucher_settlement').update({ accounting_provider: accountingProvider.name })
        .eq('id', loaded.id).eq('tenant_id', loaded.tenant_id).is('accounting_provider', null).select('*').maybeSingle();
      if (pinned.error) throw new Error('Could not freeze monthly accounting provider');
      if (!pinned.data) {
        const current = await db.from('membership_voucher_settlement').select('*').eq('id', loaded.id).eq('tenant_id', loaded.tenant_id).single();
        if (current.error || current.data?.accounting_provider !== accountingProvider.name) {
          throw new Error('Monthly accounting provider changed concurrently; retry against the saved provider');
        }
      }
      loaded.accounting_provider = accountingProvider.name;
    }
    if (!perInstalment) {
      await accountMembershipVoucherSettlement(db, token, loaded, null, { ...deps, onlyFunding: true });
      const reloaded = await db.from('member_membership_history').select('*')
        .eq('id', loaded.history_record_id).eq('tenant_id', loaded.tenant_id).single();
      reference = invoiceReferenceFromRow(reloaded.data) || existingAnnual;
      if (!reference) throw new Error('Gross annual invoice identity is missing');
      accountingProvider = facade.getAccountingProviderByName(reference.provider);
    } else if (!reference) {
      if (!['xero', 'quickbooks'].includes(accountingProvider.name)) throw new Error('Accounting provider is not configured');
      if (receipt.accounting_attempted_at && Date.now() - Date.parse(receipt.accounting_attempted_at) > 23 * 60 * 60 * 1000) {
        throw new Error('Previous instalment invoice outcome requires reconciliation; no duplicate created');
      }
      const attempt = await db.from('membership_voucher_collection').update({
        accounting_provider: accountingProvider.name, accounting_attempted_at: receipt.accounting_attempted_at || new Date().toISOString(),
      }).eq('id', receipt.id);
      if (attempt.error) throw new Error('Could not save instalment invoice attempt');
      const member = await db.from('member').select('first_name,last_name,email')
        .eq('id', token.member_id).eq('tenant_id', token.tenant_id).single();
      if (member.error || !member.data) throw new Error('Invoice contact unavailable');
      const gross = Number(history.total_with_vat ?? history.final_cost);
      const netRatio = gross > 0 ? Number(history.final_cost) / gross : 1;
      const result = await accountingProvider.createMembershipInvoice({
        appTenantId: token.tenant_id, expectedProviderContext, organizationName: `${member.data.first_name || ''} ${member.data.last_name || ''}`.trim() || member.data.email,
        invoicingEmail: member.data.email, membershipYear: token.membership_year,
        tierLabel: history.tier_label, currency: loaded.funding.currency,
        finalCost: Math.round(slice.grossMinor * netRatio) / 100,
        vatRate: loaded.history_snapshot?.__accounting?.vatRate || null,
        nominalCode: loaded.history_snapshot?.__accounting?.nominalCode || null,
        markAsPaid: false, reference: `Membership ${token.membership_year} instalment ${receipt.ordinal}/${funding.instalment_count}`,
        invoiceDescription: `Membership instalment ${receipt.ordinal}/${funding.instalment_count}. Funding (not a discount): ${
          slice.allocations.map(a => `${a.displayName} (${a.ownerType === 'member' ? 'Personal' : 'Organisation'}) ${loaded.funding.currency} ${(a.amountMinor / 100).toFixed(2)}`).join('; ')
        }. Cash ${loaded.funding.currency} ${(slice.cashMinor / 100).toFixed(2)}.`,
        idempotencyKey: `membership-credit-instalment:${receipt.id}`,
      });
      if (!result?.invoiceId) throw new Error('Instalment invoice was not confirmed');
      reference = { provider: result.provider, invoiceId: result.invoiceId, invoiceNumber: result.invoiceNumber };
      const saved = await db.from('membership_voucher_collection').update({
        accounting_provider: reference.provider, accounting_invoice_id: reference.invoiceId,
        accounting_invoice_number: reference.invoiceNumber,
      }).eq('id', receipt.id);
      if (saved.error) throw new Error('Instalment invoice created; its identity needs reconciliation');
      const status = await accountingProvider.fetchInvoiceStatus(reference.invoiceId, token.tenant_id);
      if (!status || status.voided || Math.round(Number(status.totalAmt) * 100) !== slice.grossMinor) {
        throw new Error('Gross instalment invoice tax/total differs from the frozen purchase');
      }
    }
    if (perInstalment) {
      const status = await accountingProvider.fetchInvoiceStatus(reference.invoiceId, loaded.tenant_id);
      if (!status || status.voided || Math.round(Number(status.totalAmt) * 100) !== slice.grossMinor) {
        throw new Error('Gross instalment invoice no longer matches the frozen purchase');
      }
      for (const allocation of slice.allocations) {
        const applied = await accountingProvider.applyStripePaymentToInvoice({
          appTenantId: loaded.tenant_id, expectedProviderContext, invoiceId: reference.invoiceId, amount: allocation.amountMinor / 100,
          paymentReference: `${allocation.displayName} (${allocation.ownerType === 'member' ? 'Personal' : 'Organisation'}) ${allocation.id}:${receipt.ordinal}`,
          bankAccountSettingKey: reference.provider === 'xero' ? 'xero_voucher_clearing_account_code' : 'quickbooks_voucher_clearing_account_id',
          strictBankAccount: true, idempotencyKey: `membership-credit-slice:${receipt.id}:${allocation.id}`,
        });
        if (!applied?.payment_recorded) throw new Error('Instalment voucher clearing payment was not confirmed');
      }
    }
    if (cashMinor > 0) {
      const gc = paymentProvider === 'gocardless';
      const applied = await accountingProvider.applyStripePaymentToInvoice({
        appTenantId: loaded.tenant_id, expectedProviderContext, invoiceId: reference.invoiceId, amount: cashMinor / 100,
        stripePaymentIntentId: gc ? null : stripePaymentIntentId,
        paymentReference: `${gc ? 'GoCardless' : 'Stripe'}: ${gc ? externalReference.split(':unit:')[0] : stripePaymentIntentId} [instalment ${receipt.ordinal}]`,
        ...(gc ? { bankAccountSettingKey: reference.provider === 'xero' ? 'xero_gocardless_bank_account_code' : 'quickbooks_gocardless_bank_account_id', strictBankAccount: true } : {}),
        idempotencyKey: `membership-credit-monthly-cash:${receipt.id}`,
      });
      if (!applied?.payment_recorded) throw new Error('Instalment cash payment was not confirmed');
    }
    const saved = await db.from('membership_voucher_collection').update({
      accounting_status: 'complete', accounting_error: null, accounting_provider: reference.provider,
      accounting_invoice_id: reference.invoiceId, accounting_invoice_number: reference.invoiceNumber,
    }).eq('id', receipt.id);
    if (saved.error) throw new Error('Could not persist completed instalment accounting');
    return { status: 'posted', receipt, reference };
  } catch (error) {
    await db.from('membership_voucher_collection').update({ accounting_status: 'failed', accounting_error: error.message }).eq('id', receipt.id);
    throw error;
  }
}

export async function accountFullyFundedMonthlyMembership(db, token, settlement, deps = {}) {
  const snapshot = fundedMonthlySnapshot(settlement.monthly_snapshot, settlement.funding, settlement.id);
  const agreement = { tenant_id: token.tenant_id, member_id: token.member_id, metadata: { card: snapshot } };
  // Freeze the entire zero-cash schedule before attempting the first external
  // invoice. A tax/account mapping failure must not lose future instalments.
  for (let ordinal = 1; ordinal <= snapshot.instalment_count; ordinal++) {
    const scheduled = await db.rpc('membership_voucher_claim_collection', {
      p_tenant_id: token.tenant_id, p_settlement_id: settlement.id, p_provider: 'voucher',
      p_reference: `voucher-only:${settlement.id}:${ordinal}`, p_cash_minor: 0,
      p_collection_date: fundedInstalmentDate(snapshot, ordinal),
    });
    if (scheduled.error) throw new Error(scheduled.error.message);
  }
  for (let ordinal = 1; ordinal <= snapshot.instalment_count; ordinal++) {
    await postMembershipVoucherMonthlyPayment({ db, agreement, settlement,
      provider: 'voucher', externalReference: `voucher-only:${settlement.id}:${ordinal}`,
      cashMinor: 0, currency: settlement.funding.currency, collectionDate: fundedInstalmentDate(snapshot, ordinal) }, deps);
  }
  const saved = await db.from('membership_voucher_settlement').update({ accounting_status: 'complete', accounting_error: null })
    .eq('id', settlement.id).eq('tenant_id', token.tenant_id);
  if (saved.error) throw new Error('Could not save fully funded monthly accounting completion');
  return { complete: true };
}

export async function reconcileFundedMembershipInstalments(db, deps = {}) {
  const pending = await db.from('membership_voucher_collection').select('*')
    .eq('provider', 'voucher').in('accounting_status', ['scheduled','pending','failed'])
    .lte('collection_date', new Date().toISOString().slice(0, 10)).order('collection_date').limit(25);
  if (pending.error && ['42P01','PGRST205'].includes(pending.error.code)) return { migrationPending: true, processed: 0, errors: 0 };
  if (pending.error) throw new Error('Could not load due voucher-funded membership instalments');
  const result = { processed: 0, errors: 0, details: [] };
  for (const receipt of pending.data || []) {
    try {
      const purchase = await db.from('membership_voucher_settlement').select('*')
        .eq('id', receipt.settlement_id).eq('tenant_id', receipt.tenant_id).single();
      if (purchase.error || !purchase.data) throw new Error('Scheduled membership purchase is unavailable');
      const snapshot = fundedMonthlySnapshot(purchase.data.monthly_snapshot, purchase.data.funding, purchase.data.id);
      await postMembershipVoucherMonthlyPayment({ db, settlement: purchase.data,
        agreement: { tenant_id: receipt.tenant_id, metadata: { card: snapshot } },
        provider: 'voucher', externalReference: receipt.external_reference, cashMinor: 0,
        currency: purchase.data.funding.currency, collectionDate: receipt.collection_date }, deps);
      const schedule = await db.from('membership_voucher_collection').select('accounting_status')
        .eq('settlement_id', receipt.settlement_id).eq('tenant_id', receipt.tenant_id);
      if (!schedule.error && schedule.data?.length === snapshot.instalment_count
          && schedule.data.every(row => ['complete','scheduled'].includes(row.accounting_status))) {
        const saved = await db.from('membership_voucher_settlement').update({ accounting_status: 'complete', accounting_error: null })
          .eq('id', receipt.settlement_id).eq('tenant_id', receipt.tenant_id);
        if (saved.error) throw new Error('Could not confirm funded membership accounting schedule');
      }
      result.processed++;
    } catch (error) {
      result.errors++;
      result.details.push({ receiptId: receipt.id, error: error.message });
    }
  }
  return result;
}

/** A verified catch-up collection can settle several purchased instalments.
 * Canonical provider reference + unit index makes callback/arrears retries
 * share exactly the same credit slices and cash accounting, never two ledgers.
 */
export async function postMembershipVoucherMonthlyCashBatch(input, deps = {}) {
  const snapshot = input.agreement.metadata?.card || input.agreement.metadata?.dd;
  const funding = snapshot?.voucher_funding;
  const each = funding?.cash_per_instalment_minor;
  if (!Number.isSafeInteger(each) || each <= 0 || !Number.isSafeInteger(input.cashMinor)
      || input.cashMinor <= 0 || input.cashMinor % each !== 0
      || input.cashMinor / each > funding.instalment_count) {
    throw new Error('Confirmed cash does not reconcile to the fixed funded instalments');
  }
  const receipts = [];
  for (let unit = 1; unit <= input.cashMinor / each; unit++) {
    receipts.push(await postMembershipVoucherMonthlyPayment({
      ...input, cashMinor: each, externalReference: `${input.externalReference}:unit:${unit}`,
    }, deps));
  }
  return { status: 'posted', receipts };
}
