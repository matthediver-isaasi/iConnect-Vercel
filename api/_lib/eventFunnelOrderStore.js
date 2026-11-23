import { FunnelJourneyError } from '../../shared/eventFunnelJourney.mjs';

export function createFunnelOrderStore({ db, tenantId, finalize }) {
  if (!db || !tenantId || typeof finalize !== 'function') {
    throw new Error('An aggregate registration finalizer is required before enabling payment');
  }
  async function rpc(name, arguments_) {
    const result = await db.rpc(`event_funnel_${name}`, { p_tenant: tenantId, ...arguments_ });
    if (result.error || result.data == null) {
      const missing = result.error?.code === 'PT404';
      const conflict = result.error?.code === 'PT409';
      throw new FunnelJourneyError(missing ? 'This order is not available.'
        : conflict ? 'Checkout changed. Resume the original order without paying again.'
          : 'The original checkout is being retained. Do not pay again.',
      missing ? 'ORDER_NOT_FOUND' : conflict ? 'ORDER_CONFLICT' : 'ORDER_UNAVAILABLE', missing ? 404 : conflict ? 409 : 503);
    }
    return result.data;
  }
  return {
    read: id => rpc('order_read', { p_order: id }),
    readOwned: (owner, id) => {
      if (owner.tenantId !== tenantId) throw new FunnelJourneyError('Order not available.', 'ORDER_NOT_FOUND', 404);
      return rpc('owned_order', { p_id: owner.sessionId, p_member: owner.memberId || null,
        p_capability_hash: owner.capabilityHash || null, p_order: id });
    },
    preparePayment: (id, request) => rpc('payment_request', { p_order: id, p_request: request }),
    bindPayment: (id, paymentId) => rpc('payment_bind', { p_order: id, p_payment: paymentId }),
    recordPayment: (id, evidence) => rpc('record_payment', { p_order: id, p_evidence: evidence }),
    markUncertain: (id, reason) => rpc('payment_uncertain', { p_order: id, p_reason: reason }),
    release: (id, evidence) => rpc('release_order', { p_order: id, p_evidence: evidence }),
    finalize: (id, evidence) => finalize({ tenantId, orderId: id, evidence }),
  };
}
