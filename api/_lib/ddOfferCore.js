import { monthlyCommitmentFields, monthlyInstalmentCount } from './rollingMonthlyRenewal.js';
import { resolveStructureCollectionPolicy } from '../../shared/gocardlessCollectionPolicy.js';

export const FIRST_COLLECTION_RULES = ['earliest', 'nominated_day', 'anniversary'];
export const ACTIVATION_RULES = ['mandate', 'first_payment', 'manual'];
export const MONTHLY_POST_GRACE_COLLECTION_POLICIES = ['stop_collecting', 'continue_catch_up'];
export function toMinorUnits(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 100);
}
export function resolveDdOffer(simResult) {
  if (!simResult?.success) return null;
  const config = simResult.config;
  if (!config?.dd_enabled) return null;
  let monthlyAmount = null;
  if ((config.pricing_model || 'tiered') === 'flat') {
    monthlyAmount = config.dd_monthly_amount != null ? Number(config.dd_monthly_amount) : null;
  } else {
    const band = simResult.matchedBand;
    monthlyAmount = band?.dd_monthly_amount != null ? Number(band.dd_monthly_amount) : null;
  }
  if (!Number.isFinite(monthlyAmount) || monthlyAmount <= 0) return null;
  const instalmentCount = monthlyInstalmentCount(config);
  const monthlyAmountMinor = toMinorUnits(monthlyAmount);
  if (!monthlyAmountMinor) return null;
  const collectionPolicy = resolveStructureCollectionPolicy(config);
  return {
    collectionPolicy,
    monthlyAmount: parseFloat(monthlyAmount.toFixed(2)), monthlyAmountMinor, instalmentCount,
    planTotal: collectionPolicy.pricing_policy === 'dynamic'
      ? null : parseFloat(((monthlyAmountMinor * instalmentCount) / 100).toFixed(2)),
    currency: simResult.currency || config.currency || 'GBP',
    firstCollectionRule: FIRST_COLLECTION_RULES.includes(config.dd_first_collection_rule) ? config.dd_first_collection_rule : 'earliest',
    collectionDay: config.dd_collection_day || null,
    activationRule: ACTIVATION_RULES.includes(config.dd_activation_rule) ? config.dd_activation_rule : 'first_payment',
    autoRenew: collectionPolicy.end_policy === 'continue',
    graceDays: Number.isInteger(config.dd_grace_days) ? config.dd_grace_days : 7,
    termsVersion: config.dd_terms_version || 'v1',
    invoicingMode: config.dd_invoicing_mode === 'per_instalment' ? 'per_instalment' : 'annual',
    monthlyPostGraceCollectionPolicy: MONTHLY_POST_GRACE_COLLECTION_POLICIES.includes(config.monthly_post_grace_collection_policy)
      ? config.monthly_post_grace_collection_policy : 'stop_collecting',
  };
}
function toDateOnly(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}
const fmt = d => d.toISOString().slice(0, 10);
function monthlyPaymentDescription({ membershipYear, instalmentCount, monthlyAmount, currency }) {
  const remaining = Math.max(0, instalmentCount - 1);
  const amount = `${currency} ${Number(monthlyAmount).toFixed(2)}`;
  const schedule = remaining === 0 ? 'No further collections.'
    : `${remaining} further monthly Direct Debit ${remaining === 1 ? 'collection' : 'collections'} of ${amount}.`;
  return `Membership ${membershipYear || ''}: first instalment of ${amount} paid now. ${schedule}`.replace(/\s+/g, ' ').trim().slice(0, 255);
}
export function buildAgreementSnapshot({
  offer, simResult, acceptedAt = new Date().toISOString(),
  includeBillingRequestPayment = false, billingRequestMode = null,
}) {
  if (!offer) throw new Error('offer is required');
  const policy = { ...(offer.collectionPolicy || resolveStructureCollectionPolicy(simResult?.config)) };
  const yearEnd = toDateOnly(simResult?.membershipYear?.end);
  const renewalDate = yearEnd ? new Date(yearEnd.getTime() + 86_400_000) : null;
  const snapshot = {
    kind: 'monthly_direct_debit', start_mode: simResult?.config?.start_mode || 'fixed_date',
    commitment: monthlyCommitmentFields({ offer, simResult, paymentMethod: 'direct_debit' }),
    collection_policy: policy, monthly_amount: offer.monthlyAmount,
    monthly_amount_minor: offer.monthlyAmountMinor, instalment_count: offer.instalmentCount,
    plan_total: offer.planTotal, currency: offer.currency, first_collection_rule: offer.firstCollectionRule,
    collection_day: offer.collectionDay, activation_rule: offer.activationRule, auto_renew: policy.end_policy === 'continue',
    grace_days: offer.graceDays, terms_version: offer.termsVersion,
    invoicing_mode: offer.invoicingMode === 'per_instalment' ? 'per_instalment' : 'annual',
    monthly_post_grace_collection_policy: offer.monthlyPostGraceCollectionPolicy,
    accepted_at: acceptedAt, membership_year: simResult?.membershipYear?.label || null,
    membership_year_start: simResult?.membershipYear?.start ? fmt(toDateOnly(simResult.membershipYear.start)) : null,
    membership_year_end: yearEnd ? fmt(yearEnd) : null, membership_renewal_date: renewalDate ? fmt(renewalDate) : null,
    billing_period: simResult?.config?.billing_period || null,
    structure_scope: {
      structure_scope_type: simResult?.config?.structure_scope_type || null,
      structure_field_id: simResult?.config?.structure_field_id || null,
      structure_match_value: simResult?.config?.structure_match_value || null,
    },
    config_id: simResult?.config?.id || null, band_id: simResult?.matchedBand?.id || null,
    tier_label: simResult?.tierLabel || null, annual_cost: simResult?.annualCost ?? null, final_cost: simResult?.finalCost ?? null,
  };
  snapshot.final_cost = policy.pricing_policy === 'dynamic' ? null : snapshot.commitment?.commitment_snapshot?.amounts?.final_cost ?? offer.planTotal;
  snapshot.vat_amount = policy.pricing_policy === 'dynamic' ? null : snapshot.commitment?.commitment_snapshot?.amounts?.vat_amount ?? (simResult?.vatAmount || 0);
  snapshot.total_with_vat = policy.pricing_policy === 'dynamic' ? null : offer.planTotal;
  if (billingRequestMode) snapshot.billing_request_mode = billingRequestMode;
  if (includeBillingRequestPayment) {
    if (policy.pricing_policy === 'dynamic') throw new Error('Dynamic Direct Debit consent must be mandate-only.');
    snapshot.billing_request_payment = {
      included: true, instalment_number: 1, amount_minor: offer.monthlyAmountMinor,
      remaining_instalments: Math.max(0, offer.instalmentCount - 1),
      description: monthlyPaymentDescription({
        membershipYear: simResult?.membershipYear?.label || null, instalmentCount: offer.instalmentCount,
        monthlyAmount: offer.monthlyAmount, currency: offer.currency,
      }),
    };
  }
  return snapshot;
}