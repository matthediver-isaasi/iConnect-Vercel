function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function allocationMatches(metadata, allocationContext) {
  if (!allocationContext) return true;
  return metadata.allocation_invitation_id === allocationContext.invitationId
    && metadata.allocation_event_id === allocationContext.eventId
    && String(metadata.allocation_ticket_type_id) === String(allocationContext.ticketTypeId)
    && normalizeEmail(metadata.allocation_delegate_email) === normalizeEmail(allocationContext.delegateEmail);
}

export function buildEventCreditSnapshotMetadata({
  voucherIds = [],
  voucherOrderManual = false,
  trainingFundAmount = 0,
} = {}) {
  const normalizedVoucherIds = [...new Set(
    (Array.isArray(voucherIds) ? voucherIds : [])
      .map((id) => String(id || '').trim())
      .filter(Boolean),
  )].sort();
  return {
    event_credit_voucher_ids: normalizedVoucherIds.join(','),
    event_credit_voucher_order_manual: voucherOrderManual === true ? 'true' : 'false',
    event_credit_training_fund_minor: String(Math.max(0, Math.round((Number(trainingFundAmount) || 0) * 100))),
  };
}

function creditSnapshotMatches(metadata, expectedCreditSnapshot) {
  if (!expectedCreditSnapshot) return true;
  const expected = buildEventCreditSnapshotMetadata(expectedCreditSnapshot);
  return metadata.event_credit_voucher_ids === expected.event_credit_voucher_ids
    && metadata.event_credit_voucher_order_manual === expected.event_credit_voucher_order_manual
    && metadata.event_credit_training_fund_minor === expected.event_credit_training_fund_minor;
}

/**
 * Compensate a card payment after event-credit policy changed between payment
 * initiation and booking. Nothing is refunded unless the intent is strongly
 * bound to this tenant, event, purchaser and (when applicable) allocation.
 */
export async function compensateRejectedEventCreditPayment({
  paymentIntent,
  expectedIntentId,
  tenantId,
  eventId,
  purchaserEmail,
  allocationContext = null,
  expectedCreditSnapshot = null,
  refundSucceeded,
  cancelAuthorization,
}) {
  const metadata = paymentIntent?.metadata || {};
  const expectedEmail = normalizeEmail(purchaserEmail);
  const intentEmail = normalizeEmail(metadata.member_email || paymentIntent?.receipt_email);
  const bound = !!paymentIntent
    && paymentIntent.id === expectedIntentId
    && metadata.tenant_id === tenantId
    && metadata.event_id === eventId
    && !!expectedEmail
    && intentEmail === expectedEmail
    && allocationMatches(metadata, allocationContext)
    && creditSnapshotMatches(metadata, expectedCreditSnapshot);

  if (!bound) {
    return { ok: false, compensated: false, reason: 'unverified_binding' };
  }

  try {
    if (paymentIntent.status === 'succeeded') {
      if (typeof refundSucceeded !== 'function') throw new Error('Refund service unavailable');
      await refundSucceeded();
      return { ok: true, compensated: true, action: 'refunded' };
    }
    if (paymentIntent.status === 'requires_capture') {
      if (typeof cancelAuthorization !== 'function') throw new Error('Cancellation service unavailable');
      await cancelAuthorization();
      return { ok: true, compensated: true, action: 'cancelled' };
    }
    return { ok: true, compensated: false, action: 'not_charged' };
  } catch (error) {
    return {
      ok: false,
      compensated: false,
      reason: 'provider_failure',
      error: error?.message || 'Payment compensation failed',
    };
  }
}