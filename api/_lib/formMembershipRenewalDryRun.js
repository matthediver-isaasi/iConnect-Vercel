import { assessFormMembershipRenewalEvidence } from './formMembershipRenewalEvidence.js';
import { snapshotFormMembershipPayment } from './formMembershipPaymentQuote.js';
import { resolveDdOffer, buildAgreementSnapshot, buildMonthlyBillingRequest,
  computeSubscriptionCollectionDate } from './gocardlessDirectDebit.js';

/**
 * Pure fixture/evidence preview. Receives no DB, provider client or effect
 * callback. It cannot authorize a purchase or bypass the live reservation gate.
 * Simulation must already be resolved by the authoritative successor loader.
 */
export function previewFormMembershipRenewal({
  evidence, simulation, method, now, providerEarliestChargeDate = null,
}) {
  const assessment = assessFormMembershipRenewalEvidence({ ...evidence, now });
  const result = {
    mode: 'read_only_preview', executedEffects: [],
    evidenceKind: 'supplied_snapshot_not_live_provider_confirmation',
    assessment, proposedEffects: [],
    limitations: [
      'This preview does not reserve a term, authorize a mandate, collect money or send email.',
      'Provider acceptance, banking-day adjustments and actual collection dates are not confirmed.',
      'Live checkout must recheck owner authority, provider availability and atomic successor ownership.',
    ],
  };
  if (!assessment.eligible) return result;
  if (!simulation?.success
      || String(simulation.membershipYear?.start?.toISOString?.() || simulation.membershipYear?.start).slice(0, 10) !== assessment.successorStart
      || String(simulation.membershipYear?.end?.toISOString?.() || simulation.membershipYear?.end).slice(0, 10) !== assessment.successorEnd) {
    throw new Error('Preview requires the authoritative successor simulation with matching dates');
  }
  result.currentTerm = {
    start: assessment.currentStart, end: assessment.currentEnd,
    paymentStatus: assessment.currentPaymentStatus,
    existingAgreementPreserved: !!assessment.currentAgreementId,
    alterInstalments: false, cancelMandate: false, forgiveArrears: false,
  };
  result.successor = { start: assessment.successorStart, end: assessment.successorEnd,
    activation: assessment.successorStart > String(now).slice(0, 10) ? 'scheduled' : 'subject_to_saved_activation_policy' };
  if (method === 'upfront') {
    const frozen = snapshotFormMembershipPayment(simulation, []);
    const amount = frozen.simResult.totalWithVat ?? frozen.simResult.finalCost;
    if (!Number.isFinite(amount) || amount < 0) throw new Error('A valid successor price is required');
    if (amount > 0 && !simulation.config.online_card_payment) throw new Error('Upfront payment is not enabled');
    result.proposedEffects.push({ type: 'reserve_successor', method },
      { type: amount === 0 ? 'record_zero_due' : 'create_payment_intent',
        amountMinor: Math.round(amount * 100), currency: simulation.currency,
        paymentTiming: 'immediate', membershipStart: assessment.successorStart });
  } else if (method === 'direct_debit') {
    const offer = resolveDdOffer(simulation);
    if (!offer) throw new Error('Direct Debit is not enabled for the successor');
    const snapshot = buildAgreementSnapshot({ offer, simResult: simulation, acceptedAt: new Date(now).toISOString() });
    const request = buildMonthlyBillingRequest({ snapshot });
    if (request.paymentAmountMinor != null) throw new Error('Early renewal must not request an initial payment');
    const schedule = computeSubscriptionCollectionDate(snapshot, providerEarliestChargeDate, null, now);
    result.successor.activationRule = snapshot.activation_rule;
    result.proposedEffects.push({ type: 'reserve_successor', method },
      { type: 'authorize_mandate', initialCollectionMinor: 0, settledPayment: false },
      { type: 'schedule_collections_after_authorization',
        requestedFirstDate: schedule.startDate,
        actualExpectedCollectionDate: null,
        amountMinor: snapshot.monthly_amount_minor,
        instalments: snapshot.instalment_count, currency: snapshot.currency,
        rule: snapshot.first_collection_rule,
        collectionBeforeMembershipStart: false });
  } else throw new Error('Preview method must be upfront or direct_debit');
  return result;
}