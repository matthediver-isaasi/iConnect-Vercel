import { classifyAnnualRenewal, deriveAnnualTerm, hasActiveMonthlyBillingAgreement, isAnnualNonRecurring } from './annualRenewalPolicy.js';
import { calculateMembershipYearWindow } from './membershipYear.js';
import { upfrontRollingCommitment } from './upfrontRollingRenewal.js';
import { commitmentFromQuote } from './rollingMembershipCommitment.js';
import { invoiceReferenceFromRow } from './feeTokenInvoiceReference.js';

export const requestsReminderPaymentLink = template => /\{\{\s*payment_link\s*\}\}/.test(`${template?.subject || ''} ${template?.body || ''}`);

const pick = (object, keys) => Object.fromEntries(keys.filter(key => object?.[key] !== undefined).map(key => [key, object[key]]));
const CONFIG_FIELDS = [
  'id', 'start_mode', 'billing_period', 'currency', 'membership_start_month', 'membership_start_day',
  'renewal_open_days', 'renewal_grace_days', 'online_card_payment', 'invoice_description', 'nominal_code',
];
export function reminderRenewalSnapshot(quote, history) {
  const previousTerm = pick(history, [
    'id', 'membership_year', 'billing_period', 'term_key', 'term_start_date', 'term_end_date',
    'membership_renewal_date', 'term_duration_months', 'term_anchor_date',
  ]);
  if (history.commitment_snapshot) {
    previousTerm.commitment_snapshot = {
      ...pick(history.commitment_snapshot, ['start_mode', 'payment_frequency']),
      config: pick(history.commitment_snapshot.config, CONFIG_FIELDS),
    };
  }
  return {
    config: pick(quote.config, CONFIG_FIELDS),
    incentiveConfig: pick(quote.incentiveConfig || quote.config, [
      ...CONFIG_FIELDS, 'free_period_amount', 'free_period_unit', 'rollover_enabled',
    ]),
    membershipYear: { label: quote.membershipYear.label,
      start: new Date(quote.membershipYear.start).toISOString().slice(0, 10),
      end: new Date(quote.membershipYear.end).toISOString().slice(0, 10) },
    previousTerm,
  };
}

// No delivery or provider effects: the caller supplies simulation and token preparation.
export async function resolveReminderPaymentQuote({ client, tenantId, history, histories, now = new Date(), simulate, prepare, recipients, loadAddonQuote, resolveStripeCredentials }) {
  const memberId = history.member_id || null;
  const organizationId = memberId ? null : history.organization_id;
  const owner = { tenantId, memberId, organizationId };
  const blocked = (code, message) => ({ success: false, code, message });
  if (!isAnnualNonRecurring(history) || await hasActiveMonthlyBillingAgreement(client, owner)) {
    return blocked('recurring', 'Renewal payment link suppressed: membership is managed by a recurring plan.');
  }
  let config = history.commitment_snapshot?.config;
  if (!config) {
    const loaded = await client.from('membership_tier_config').select('*').eq('tenant_id', tenantId).eq('id', history.config_id).maybeSingle();
    if (loaded.error || !loaded.data) throw new Error('Could not load renewal reminder configuration');
    config = loaded.data;
  }
  const term = deriveAnnualTerm(history, config, now);
  const start = term.nextStart.toISOString().slice(0, 10);
  const window = history.term_key
    ? { label: `rolling:${start}`, start: term.nextStart }
    : calculateMembershipYearWindow(config, term.nextStart);
  const successor = histories.find(row => row.id !== history.id && !['cancelled', 'void', 'expired_checkout'].includes(row.status)
    && (row.term_start_date === start || row.membership_year === window.label));
  if (successor && (successor.payment_status === 'paid' || successor.paid_at || Number(successor.total_with_vat ?? successor.final_cost) === 0)) {
    return blocked('paid', 'Renewal payment link suppressed: successor term is already paid.');
  }
  const eligibility = classifyAnnualRenewal({ previousRecord: history, targetMembershipYear: window, config, now });
  if (!eligibility.eligible) return blocked(eligibility.code, eligibility.message);
  const quote = await simulate(tenantId, memberId || organizationId, {
    source: 'renewal', mode: 'automatic', targetYear: window.label,
    ...(history.term_key ? { previousTerm: history } : { asOfDate: start }),
  });
  if (!quote.success) throw new Error(quote.error || 'Could not quote successor membership');
  if (new Date(quote.membershipYear.start).toISOString().slice(0, 10) !== start) throw new Error('Renewal quote does not match the saved successor boundary');
  // Monthly/DD setup is deliberately unavailable on reminder checkout. A new
  // successor therefore needs usable upfront card settings; only an already
  // linked Xero invoice can use the existing PO submission path.
  const invoiceReference = invoiceReferenceFromRow(successor);
  const invoicePoAvailable = !!(successor?.id && invoiceReference);
  let cardAvailable = false;
  if (quote.config?.online_card_payment && resolveStripeCredentials) {
    try {
      const credentials = await resolveStripeCredentials(tenantId, 'membership');
      cardAvailable = credentials?.is_enabled === true && !!credentials.secret_key && !!credentials.publishable_key
        && !credentials.configuration_error;
    } catch (error) {
      if (error.code === 'RENEWAL_BUDGET_EXHAUSTED') throw error;
      if (!invoicePoAvailable) return blocked('payment_method_unavailable', 'Renewal payment link withheld: could not verify upfront card availability.');
    }
  }
  if (!cardAvailable && !invoicePoAvailable) {
    return blocked('payment_method_unavailable', 'Renewal payment link withheld: no enabled upfront card payment or existing invoice purchase-order path is available.');
  }
  let addonLines = [];
  if (!successor && organizationId && loadAddonQuote) {
    const addons = await loadAddonQuote(tenantId, organizationId, quote.membershipYear.label);
    addonLines = addons.lines;
    quote.finalCost = Math.round((quote.finalCost + addons.subtotal) * 100) / 100;
    quote.vatAmount = Math.round(((quote.vatAmount || 0) + addons.vat) * 100) / 100;
    quote.totalWithVat = Math.round((quote.finalCost + quote.vatAmount) * 100) / 100;
  }
  if (successor) {
    // Existing invoice/history is authoritative, never reprice it from current config.
    Object.assign(quote, { finalCost: Number(successor.final_cost), annualCost: Number(successor.annual_cost),
      currency: successor.currency, tierLabel: successor.tier_label,
      vatAmount: Number(successor.vat_amount || 0), totalWithVat: Number(successor.total_with_vat ?? successor.final_cost) });
  }
  const costBreakdown = {
    ...Object.fromEntries([
      'annualCostBeforeDiscounts', 'customDiscountTotal', 'customDiscountDetails',
      'prorataCost', 'prorataDays', 'proRataEnabled', 'freeDiscount', 'rolloverDiscount',
      'freePeriodUnit', 'freePeriodAmount', 'freePeriodDaysApplied', 'yearNumber',
      'matchedBand', 'fieldValue', 'taxType', 'nominalCode', 'overrideApplied', 'overrideType',
    ].map(key => [key, quote[key]])),
    annualCost: quote.annualCost, finalCost: quote.finalCost, vatAmount: quote.vatAmount,
    vatRatePercent: quote.vatRatePercent, totalWithVat: quote.totalWithVat,
    ...(addonLines.length ? { addonLines } : {}),
    renewalQuote: reminderRenewalSnapshot(quote, history),
    ...(history.term_key ? { commitment: successor?.commitment_snapshot ? commitmentFromQuote(successor) : upfrontRollingCommitment(quote),
      previousTerm: reminderRenewalSnapshot(quote, history).previousTerm } : {}),
  };
  const prepared = await prepare({
    ...owner, client, membershipYear: quote.membershipYear.label,
    finalCost: quote.finalCost, currency: quote.currency, tierLabel: quote.tierLabel,
    tierConfig: quote.config, costBreakdown, recipientEmails: recipients.map(row => row.email),
    invoiceReference,
    historyRecordId: successor?.id || null, xeroInvoiceId: successor?.xero_invoice_id || null,
    xeroInvoiceNumber: successor?.xero_invoice_number || null,
    xeroOnlineInvoiceUrl: successor?.xero_online_invoice_url || null, reminderQuote: true,
  });
  if (!prepared.success) return blocked('token_unavailable', prepared.error);
  const saved = prepared.costBreakdown?.renewalQuote;
  const savedInvoicePoAvailable = !!(prepared.historyRecordId && (prepared.invoiceReference || prepared.xeroInvoiceId));
  if (!savedInvoicePoAvailable && (!cardAvailable || !saved?.config?.online_card_payment)) {
    return blocked('payment_method_unavailable', 'Renewal payment link withheld: the saved quote does not offer an available upfront payment method.');
  }
  return { success: true, ...prepared, quote: saved || quote, renewalDate: term.nextStart };
}