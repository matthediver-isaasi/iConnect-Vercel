import { AmendmentCalculationError, amendmentMoneyParts } from './memberAmendmentMoney.js';

const fail = message => { throw new AmendmentCalculationError(message); };
// Join independently verified cash receipts to independently verified invoice
// prices. An AUTHORISED invoice proves a price, never a payment.
export function buildMemberMonthlyFundingEvidence({ input, funding, service }) {
  const { purchase, agreement, plan, authority, memberId } = input;
  const prices = service?.evidence;
  if (!funding || funding.sourceRecordId !== purchase.id
    || funding.agreementId !== agreement.id || funding.planId !== plan.id
    || funding.currency !== authority.currency || funding.provider !== authority.provider
    || !Array.isArray(funding.payments) || prices?.sourceRecordId !== purchase.id
    || prices.currency !== authority.currency || prices.complete !== true
    || prices.throughExclusiveDate !== input.effectiveDate || !Array.isArray(prices.periods)) {
    fail('Matching verified monthly service and provider payment evidence is required.');
  }
  const payments = new Map();
  for (const payment of funding.payments) {
    if (!payment.id || payments.has(payment.id) || payment.settled !== true) {
      fail('Duplicate or unsettled provider payments require reconciliation.');
    }
    payments.set(payment.id, payment);
  }
  const settledFunding = [], used = new Set();
  for (const period of prices.periods) {
    const payment = payments.get(period.providerPaymentId);
    const amount = amendmentMoneyParts(period);
    if (!payment || used.has(payment.id) || period.verified !== true
      || !/^\d{4}-\d{2}-\d{2}$/.test(period.collectionDate || '')
      || period.sourceRecordId !== purchase.id || period.currency !== authority.currency
      || payment.amountMinor !== amount.grossMinor || payment.date !== period.collectionDate) {
      fail('Historical invoice price does not match a unique settled provider payment.');
    }
    used.add(payment.id);
    settledFunding.push({
      id: `${authority.provider}:${payment.id}`, sourceRecordId: purchase.id,
      currency: authority.currency, state: 'settled', ownerType: 'member', ownerId: memberId,
      kind: 'cash', ...amount, invoiceEvidenceId: period.evidenceId,
    });
  }
  if (used.size !== payments.size) fail('Additional paid collections need their own service-price evidence.');
  const settledGrossMinor = settledFunding.reduce((sum, row) => sum + row.grossMinor, 0);
  if (!Number.isSafeInteger(settledGrossMinor) || settledGrossMinor !== funding.settledGrossMinor
    || funding.pendingGrossMinor !== 0) fail('Provider funding totals are incomplete.');
  return {
    sourceRecordId: purchase.id, currency: authority.currency, asOfDate: input.effectiveDate,
    complete: true, settledFunding, pendingCollections: [], failedCollections: [],
    outstandingDue: { netMinor: 0, vatMinor: 0, grossMinor: 0 },
    variableMonthlyService: prices,
  };
}
