import { invoiceReferenceFromRow, invoiceReferenceColumns } from './feeTokenInvoiceReference.js';
import { pinMembershipAccountingBinding } from './membershipVoucherAccountingBinding.js';
import {verifyMemberCreditRedemption} from './memberCreditRedemption.js';

/** Explicit funding against a gross invoice. Never a fee discount, never a
 * synthetic Stripe payment. Existing invoice identity always wins.
 */
export async function accountMembershipVoucherSettlement(db, token, settlement, pi, deps = {}) {
  if (!['committed', 'plan_committed'].includes(settlement.state)) throw new Error('Membership funding is not committed');
  if (settlement.accounting_status === 'complete') return { complete: true };
  const table = token.member_id ? 'member_membership_history' : 'organisation_membership_history';
  const ownerColumn = token.member_id ? 'member_id' : 'organization_id';
  const { data: history, error } = await db.from(table).select('*')
    .eq('id', settlement.history_record_id).eq('tenant_id', token.tenant_id)
    .eq(ownerColumn, token.member_id || token.organization_id).single();
  if (error || !history) throw new Error('Funded membership history is unavailable');
  const facade = deps.facade || await import('./accountingProvider.js');
  let reference = invoiceReferenceFromRow(history) || invoiceReferenceFromRow(token);
  if (!reference && settlement.monthly_snapshot?.invoicing_mode === 'per_instalment'
      && settlement.funding.remainingMinor === 0 && !deps.onlyFunding) {
    return (await import('./membershipVoucherMonthlyAccounting.js')).accountFullyFundedMonthlyMembership(db, token, settlement, deps);
  }
  const provider = reference || settlement.accounting_provider
    ? facade.getAccountingProviderByName(reference?.provider || settlement.accounting_provider)
    : await facade.getAccountingProvider(token.tenant_id);
  const funding = settlement.funding;
  await (deps.verifyMemberCreditRedemption||verifyMemberCreditRedemption)(db,token.tenant_id,funding.allocations,provider);
  const description = funding.allocations.map(a =>
    `${a.displayName} (${a.ownerType === 'member' ? 'Personal' : 'Organisation'}): ${funding.currency} ${(a.amountMinor / 100).toFixed(2)}`).join('; ');
  const expectedProviderContext = await pinMembershipAccountingBinding(db, settlement, reference?.provider || provider.name, deps);
  if (!reference) {
    if (!['xero', 'quickbooks'].includes(provider.name)) throw new Error('Membership accounting provider is not configured');
    if (settlement.accounting_attempted_at && Date.now() - Date.parse(settlement.accounting_attempted_at) > 23 * 60 * 60 * 1000) {
      throw new Error('Previous invoice creation has an uncertain outcome. Reconcile its existing invoice before retrying; no duplicate invoice created.');
    }
    const { error: attemptError } = await db.from('membership_voucher_settlement').update({
      accounting_provider: provider.name,
      accounting_attempted_at: settlement.accounting_attempted_at || new Date().toISOString(),
    }).eq('id', settlement.id);
    if (attemptError) throw new Error('Could not save invoice creation attempt');
    const { data: member, error: memberError } = await db.from(token.member_id ? 'member' : 'organization')
      .select(token.member_id ? 'first_name,last_name,email' : 'name,invoicing_email')
      .eq('id', token.member_id || token.organization_id).eq('tenant_id', token.tenant_id).single();
    if (memberError || !member) throw new Error('Membership invoice contact unavailable');
    const created = await provider.createMembershipInvoice({
      appTenantId: token.tenant_id, expectedProviderContext, organizationName: member.name || `${member.first_name || ''} ${member.last_name || ''}`.trim() || member.email,
      invoicingEmail: member.email || member.invoicing_email, membershipYear: token.membership_year, tierLabel: token.tier_label,
      finalCost: Number(history.final_cost), currency: funding.currency,
      vatRate: settlement.history_snapshot?.__accounting?.vatRate || null,
      nominalCode: settlement.history_snapshot?.__accounting?.nominalCode || null,
      markAsPaid: false, reference: `Membership ${token.membership_year}`,
      invoiceDescription: `Membership ${token.membership_year}. Funding (not a discount): ${description}. Cash: ${funding.currency} ${(funding.remainingMinor / 100).toFixed(2)}.`,
      idempotencyKey: `membership-credit-invoice:${settlement.id}`,
    });
    if (!created?.invoiceId) throw new Error('Accounting provider did not confirm a gross membership invoice');
    reference = { provider: created.provider, invoiceId: created.invoiceId,
      invoiceNumber: created.invoiceNumber, onlineInvoiceUrl: created.onlineInvoiceUrl };
    const { error: saveError } = await db.from(table)
      .update(invoiceReferenceColumns(reference)).eq('id', history.id).eq('tenant_id', token.tenant_id);
    if (saveError) throw new Error('Invoice created; invoice identity needs reconciliation before retry');
  }
  const invoiceStatus = await provider.fetchInvoiceStatus(reference.invoiceId, token.tenant_id);
  if (!invoiceStatus || invoiceStatus.voided || Math.round(Number(invoiceStatus.totalAmt) * 100) !== funding.payableMinor) {
    throw new Error('Gross invoice total does not match the saved membership purchase; review the frozen tax mapping before settling funding');
  }
  // Reuse the provider's explicit-amount payment primitive with a dedicated
  // clearing account and no Stripe identifier. No fallback to a cash account.
  for (const allocation of funding.allocations) {
    const result = await provider.applyStripePaymentToInvoice({
      appTenantId: token.tenant_id, expectedProviderContext, invoiceId: reference.invoiceId,
      amount: allocation.amountMinor / 100,
      paymentReference: `${allocation.displayName} (${allocation.ownerType === 'member' ? 'Personal' : 'Organisation'}) ${allocation.id}`,
      bankAccountSettingKey: reference.provider === 'xero'
        ? 'xero_voucher_clearing_account_code' : 'quickbooks_voucher_clearing_account_id',
      strictBankAccount: true,
      idempotencyKey: `membership-credit-funding:${allocation.id}`,
    });
    if (!result?.payment_recorded) throw new Error('Voucher clearing account payment not confirmed; configure the dedicated voucher clearing account and retry accounting');
  }
  if (funding.remainingMinor > 0 && !deps.onlyFunding) {
    if (!pi?.id || pi.amount !== funding.remainingMinor || pi.status !== 'succeeded') throw new Error('Verified cash evidence required for accounting');
    const result = await provider.applyStripePaymentToInvoice({
      appTenantId: token.tenant_id, expectedProviderContext, invoiceId: reference.invoiceId,
      stripePaymentIntentId: pi.id, amount: funding.remainingMinor / 100,
      paymentReference: `Stripe: ${pi.id}`, idempotencyKey: `membership-credit-cash:${settlement.id}`,
    });
    if (!result?.payment_recorded) throw new Error('Cash payment not confirmed by accounting provider');
  }
  const { error: historyError } = await db.from(table).update({
    accounting_sync_status: null, accounting_sync_error: null,
  }).eq('id', history.id).eq('tenant_id', token.tenant_id);
  if (historyError) throw new Error('Could not save completed invoice accounting');
  const { error: settlementError } = await db.from('membership_voucher_settlement').update({
    accounting_status: 'complete', accounting_error: null,
  }).eq('id', settlement.id).eq('tenant_id', token.tenant_id);
  if (settlementError) throw new Error('Could not save funding accounting completion');
  return { complete: true, reference };
}
