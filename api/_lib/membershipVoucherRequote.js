import { randomBytes } from 'node:crypto';
import { membershipAmountMinor } from './membershipVoucherQuote.js';
import { invoiceReferenceFromRow } from './feeTokenInvoiceReference.js';

export async function regenerateMembershipVoucherQuote(db, token, paymentMode, deps = {}) {
  if (!['stripe_upfront','stripe_monthly','direct_debit'].includes(paymentMode)) throw new Error('Select a supported membership payment method');
  if (token.cost_breakdown?.memberStart || token.cost_breakdown?.commitment) {
    throw new Error('This registration already has immutable accepted terms. Use its saved payment method rather than replacing it.');
  }
  const simulations = deps.simulations || await import('./membershipSimulation.js');
  const simulation = token.member_id
    ? await simulations.simulateMembershipForMember(token.tenant_id, token.member_id, { source: 'fee-requote', mode: 'manual', targetYear: token.membership_year })
    : await simulations.simulateMembershipForOrg(token.tenant_id, token.organization_id, { source: 'fee-requote', mode: 'manual', targetYear: token.membership_year });
  if (!simulation?.success || simulation.membershipYear?.label !== token.membership_year) throw new Error('Could not create matching saved membership terms');
  let history = null;
  if (token.history_record_id) {
    const loaded = await db.from(token.member_id ? 'member_membership_history' : 'organisation_membership_history').select('*')
      .eq('id', token.history_record_id).eq('tenant_id', token.tenant_id).single();
    if (loaded.error || !loaded.data) throw new Error('Original membership history could not be verified');
    history = loaded.data;
  }
  const invoiced = invoiceReferenceFromRow(history) || invoiceReferenceFromRow(token);
  if (simulation.currency?.toUpperCase() !== (token.currency || 'GBP').toUpperCase()) {
    throw new Error('Membership currency changed. An administrator must issue a new currency-specific fee quote; this link will not convert the original purchase.');
  }
  let monthlySnapshot = null;
  if (paymentMode !== 'stripe_upfront') {
    if (!token.member_id) throw new Error('This organisation membership uses its existing upfront payment methods');
    const helpers = paymentMode === 'stripe_monthly'
      ? deps.card || await import('./stripeMonthlyCard.js')
      : deps.dd || await import('./gocardlessDirectDebit.js');
    const offer = paymentMode === 'stripe_monthly' ? helpers.resolveCardMonthlyOffer(simulation) : helpers.resolveDdOffer(simulation);
    if (!offer) throw new Error('The selected monthly payment method is not currently offered');
    monthlySnapshot = paymentMode === 'stripe_monthly'
      ? helpers.buildCardAgreementSnapshot({ offer, simResult: simulation })
      : helpers.buildAgreementSnapshot({ offer, simResult: simulation, includeBillingRequestPayment: false, billingRequestMode: 'mandate_only' });
    monthlySnapshot.payment_mode = paymentMode;
    if (monthlySnapshot.collection_policy?.pricing_policy === 'dynamic') throw new Error('Choose upfront payment for an ongoing variable-price membership');
    // Existing issued liability is never repriced. Its original gross can be
    // financed over the offered finite count when exact minor units permit it.
    if (invoiced) {
      // The liability has already been invoiced in full. Financing it must
      // not also issue N new per-instalment gross invoices.
      monthlySnapshot.invoicing_mode = 'annual';
      const gross = membershipAmountMinor(history?.total_with_vat ?? token.cost_breakdown?.totalWithVat ?? token.final_cost);
      monthlySnapshot.credit_required_for_rounding = gross % monthlySnapshot.instalment_count !== 0;
      monthlySnapshot.plan_total = gross / 100;
      monthlySnapshot.monthly_amount_minor = gross / monthlySnapshot.instalment_count;
      monthlySnapshot.monthly_amount = monthlySnapshot.monthly_amount_minor / 100;
    }
  }
  const grossMinor = invoiced ? membershipAmountMinor(history?.total_with_vat ?? token.cost_breakdown?.totalWithVat ?? token.final_cost)
    : membershipAmountMinor(monthlySnapshot?.plan_total ?? simulation.totalWithVat ?? simulation.finalCost);
  const rate = Number(simulation.vatRatePercent) || 0;
  const netMinor = invoiced ? membershipAmountMinor(history?.final_cost ?? token.final_cost)
    : Math.round(grossMinor / (1 + rate / 100));
  const saved = { ...simulation, finalCost: netMinor / 100, totalWithVat: grossMinor / 100,
    vatAmount: (grossMinor - netMinor) / 100 };
  if (monthlySnapshot) {
    monthlySnapshot.final_cost = saved.finalCost;
    monthlySnapshot.vat_amount = saved.vatAmount;
    monthlySnapshot.total_with_vat = saved.totalWithVat;
    const amounts = monthlySnapshot.commitment?.commitment_snapshot?.amounts;
    if (amounts) Object.assign(amounts, {
      final_cost:saved.finalCost,total_with_vat:saved.totalWithVat,vat_amount:saved.vatAmount,
      monthly_amount:monthlySnapshot.monthly_amount,instalment_count:monthlySnapshot.instalment_count,
    });
  }
  const breakdown = { ...token.cost_breakdown, totalWithVat: saved.totalWithVat,
    vatAmount: saved.vatAmount, vatRatePercent: rate,
    membershipVoucherRequote: { predecessorTokenId: token.id, paymentMode,
      creditRequired: !!monthlySnapshot?.credit_required_for_rounding,
      regeneratedAt: new Date().toISOString(), simulation: saved, monthlySnapshot } };
  const result = await db.rpc('membership_fee_regenerate_quote', {
    p_tenant_id: token.tenant_id, p_token_id: token.id, p_expected_updated_at: token.updated_at || null,
    p_new_token: randomBytes(32).toString('hex'), p_final_cost: saved.finalCost, p_breakdown: breakdown,
  });
  if (result.error) throw new Error(result.error.message);
  if (!result.data?.token) throw new Error('Replacement membership quote was not confirmed');
  return { replacementUrl: `/membership-fees/${encodeURIComponent(result.data.token)}`,
    grossMinor, currency: token.currency || 'GBP', paymentMode };
}
