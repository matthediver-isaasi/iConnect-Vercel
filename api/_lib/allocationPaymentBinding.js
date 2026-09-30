export function paymentIntentMatchesAllocation(paymentIntent, context) {
  if (!paymentIntent || !context) return false;
  const metadata = paymentIntent.metadata || {};
  return metadata.type === 'complex_event_booking'
    && metadata.allocation_invitation_id === context.invitationId
    && String(metadata.tenant_id) === String(context.tenantId)
    && String(metadata.allocation_event_id) === String(context.eventId)
    && String(metadata.allocation_ticket_type_id) === String(context.ticketTypeId)
    && String(metadata.allocation_delegate_email || '').trim().toLowerCase()
      === String(context.delegateEmail || '').trim().toLowerCase();
}

// The caller supplies the actual refund operation. Keeping the binding gate
// here makes it impossible for generic/mismatched intents to reach it.
export async function refundBoundAllocationPayment(paymentIntent, context, refund) {
  if (paymentIntent?.status !== 'succeeded'
    || !paymentIntentMatchesAllocation(paymentIntent, context)) return false;
  await refund();
  return true;
}

export async function runAuthorizedCardCompensation(authorized, refund) {
  if (authorized !== true) return false;
  return refund();
}