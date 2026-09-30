import { orderVoucherIdsForRedemption } from './voucherOrdering.js';
import { createHash } from 'node:crypto';

export class ComplexEventCreditQuoteError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = 'ComplexEventCreditQuoteError';
    this.statusCode = statusCode;
  }
}

function poundsToMinor(value) {
  return Math.round(Number(value) * 100);
}

export function normalizeRequestedVoucherIds(value) {
  if (value == null) return [];
  if (!Array.isArray(value)) {
    throw new ComplexEventCreditQuoteError('selected_voucher_ids must be an array');
  }
  const ids = value.map((id) => String(id || '').trim());
  if (ids.some((id) => !id)) {
    throw new ComplexEventCreditQuoteError('Selected voucher IDs must not be empty');
  }
  if (new Set(ids).size !== ids.length) {
    throw new ComplexEventCreditQuoteError('A voucher cannot be applied more than once');
  }
  return ids;
}

export function assertCreditRoleAllowed(allowedRoleIds, memberRoleId, label) {
  const roles = Array.isArray(allowedRoleIds) ? allowedRoleIds : [];
  if (roles.length > 0 && (!memberRoleId || !roles.includes(memberRoleId))) {
    throw new ComplexEventCreditQuoteError(
      `Your role does not have permission to use ${label}`,
      403,
    );
  }
}

/**
 * Produces the exact authoritative credit quote used to determine the Stripe
 * amount. Inputs must already be tenant/org/status/expiry validated.
 */
export function calculateComplexEventCreditQuote({
  totalMinor,
  requestedTrainingFundAmount = 0,
  trainingFundBalance = 0,
  requestedVoucherIds = [],
  vouchers = [],
  voucherOrderManual = false,
}) {
  if (!Number.isInteger(totalMinor) || totalMinor <= 0) {
    throw new ComplexEventCreditQuoteError('Event total must be a positive amount');
  }

  const requestedTrainingMinor = poundsToMinor(requestedTrainingFundAmount);
  if (!Number.isFinite(requestedTrainingMinor) || requestedTrainingMinor < 0) {
    throw new ComplexEventCreditQuoteError('Training fund amount must be a valid positive amount');
  }
  const availableTrainingMinor = Math.max(0, poundsToMinor(trainingFundBalance));
  if (requestedTrainingMinor > availableTrainingMinor) {
    throw new ComplexEventCreditQuoteError('Insufficient training fund balance');
  }

  const byId = Object.fromEntries(vouchers.map((voucher) => [String(voucher.id), voucher]));
  for (const id of requestedVoucherIds) {
    if (!byId[id]) {
      throw new ComplexEventCreditQuoteError('One or more selected vouchers are invalid or unavailable');
    }
  }
  const { orderedIds } = orderVoucherIdsForRedemption(
    requestedVoucherIds,
    byId,
    voucherOrderManual === true,
  );

  const trainingFundMinor = Math.min(requestedTrainingMinor, totalMinor);
  let remainingMinor = totalMinor - trainingFundMinor;
  const voucherDeductions = [];
  for (const voucherId of orderedIds) {
    const voucherMinor = Math.max(0, poundsToMinor(byId[voucherId].value));
    const amountMinor = Math.min(voucherMinor, remainingMinor);
    if (amountMinor > 0) {
      voucherDeductions.push({ voucherId, amountMinor });
      remainingMinor -= amountMinor;
    }
  }

  return {
    totalMinor,
    trainingFundMinor,
    voucherMinor: voucherDeductions.reduce((sum, item) => sum + item.amountMinor, 0),
    voucherDeductions,
    remainingMinor,
  };
}

/**
 * Stable server-authored binding used to prove that a paid intent belongs to
 * the same event/member/organization and original credit request later
 * submitted by the client after Stripe authentication.
 */
export function buildComplexEventCreditBinding({
  eventId,
  memberId,
  organizationId,
  requestedTrainingFundAmount = 0,
  requestedVoucherIds = [],
  voucherOrderManual = false,
}) {
  const trainingFundMinor = poundsToMinor(requestedTrainingFundAmount);
  const voucherIds = voucherOrderManual === true
    ? [...requestedVoucherIds]
    : [...requestedVoucherIds].sort();
  const canonical = JSON.stringify({
    eventId: String(eventId || ''),
    memberId: String(memberId || ''),
    organizationId: String(organizationId || ''),
    trainingFundMinor,
    voucherIds,
    voucherOrderManual: voucherOrderManual === true,
  });
  return createHash('sha256').update(canonical).digest('hex');
}