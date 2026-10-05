import {
  PublicTicketMemberError, buildPublicTicketMemberSnapshot,
  loadPublicTicketMemberRoles, preflightPublicTicketMembers,
} from './publicTicketMemberCreation.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const unavailable = () => new PublicTicketMemberError(
  'PURCHASE_EVIDENCE_UNAVAILABLE', 'Unable to verify purchase details. Please retry without making another payment.', 503,
);

export async function loadPublicTicketPurchase(db, { tenantId, eventId, eventKind, requestId, paymentIntentId, allowMissingSchema = false }) {
  if (!tenantId || !eventId || !['simple', 'complex'].includes(eventKind)) throw unavailable();
  if (!requestId && !paymentIntentId) return null;
  if (requestId && !uuid.test(requestId)) {
    throw new PublicTicketMemberError('INVALID_PURCHASE_ID', 'A valid checkout reference is required.');
  }
  let query = db.from('public_ticket_member_purchase').select('*')
    .eq('tenant_id', tenantId).eq('event_id', eventId).eq('event_kind', eventKind);
  query = paymentIntentId ? query.eq('stripe_payment_intent_id', paymentIntentId) : query.eq('id', requestId);
  const { data, error } = await query.maybeSingle();
  if (allowMissingSchema && ['42P01', 'PGRST205'].includes(error?.code)) return null;
  if (error) throw unavailable();
  if (data && requestId && data.id !== requestId) {
    throw new PublicTicketMemberError('PURCHASE_MISMATCH', 'The payment belongs to a different checkout.', 409);
  }
  return data;
}

export async function preparePublicTicketPurchase({
  db, tenantId, eventId, eventKind, requestId, purchaser, items, authenticatedMember,
  resumeExisting = false,
}) {
  const enabled = items.some(item => item.ticket?.create_member_records === true);
  if (!enabled && !resumeExisting) return null;
  if (!enabled && !requestId) return null;
  if (!uuid.test(requestId || '')) {
    throw new PublicTicketMemberError('INVALID_PURCHASE_ID', 'A valid checkout reference is required.');
  }
  const existing = await loadPublicTicketPurchase(db, {
    tenantId, eventId, eventKind, requestId, allowMissingSchema: !enabled,
  });
  if (!enabled && !existing) return null;
  const roles = existing && resumeExisting
    ? existing.snapshot.ticket_policies.map(policy => ({ id: policy.role_id, tenant_id: tenantId }))
    : await loadPublicTicketMemberRoles(db, tenantId, items.map(item => item.ticket));
  const effectiveItems = existing && resumeExisting ? items.map(item => {
    const policy = existing.snapshot.ticket_policies.find(value => value.ticket_id === String(item.ticket.id));
    return policy ? { ...item, ticket: { ...item.ticket, visibility_mode: 'public_only', create_member_records: true, new_member_role_id: policy.role_id } } : item;
  }) : items;
  const snapshot = buildPublicTicketMemberSnapshot({ tenantId, purchaser, items: effectiveItems, roles });
  if (authenticatedMember?.tenant_id === tenantId) {
    throw new PublicTicketMemberError('PUBLIC_ONLY_MEMBER', 'Members cannot purchase Public only tickets.', 403);
  }
  if (!existing) {
    await preflightPublicTicketMembers({ db, tenantId, purchaser, items, roles, authenticatedMember });
  }
  // SQL compares immutable canonical snapshots under a row lock. A supplied
  // UUID is only an idempotency key; it cannot authorize changed identities.
  const { error } = await db.rpc('prepare_public_ticket_member_purchase', {
    p_id: requestId, p_tenant_id: tenantId, p_event_id: eventId,
    p_event_kind: eventKind, p_snapshot: snapshot,
  });
  if (error?.code === '23514') {
    throw new PublicTicketMemberError('PURCHASE_CHANGED', 'Purchase details changed. Start a new checkout before paying.', 409);
  }
  if (error) throw unavailable();
  return { ...existing, id: requestId, snapshot, state: existing?.state || 'prepared' };
}

export async function bindPublicTicketPayment(db, purchaseId, tenantId, paymentIntentId) {
  const { data, error } = await db.from('public_ticket_member_purchase')
    .update({ stripe_payment_intent_id: paymentIntentId })
    .eq('id', purchaseId).eq('tenant_id', tenantId)
    .is('stripe_payment_intent_id', null).select('id');
  if (error) throw unavailable();
  if (data?.length) return;
  const { data: receipt, error: readError } = await db.from('public_ticket_member_purchase')
    .select('stripe_payment_intent_id').eq('id', purchaseId).eq('tenant_id', tenantId).maybeSingle();
  if (readError || receipt?.stripe_payment_intent_id !== paymentIntentId) throw unavailable();
}

export function assertPublicTicketPaymentEvidence(paymentIntent, purchase, tenantId, eventId) {
  if (!paymentIntent || paymentIntent.status !== 'succeeded'
      || paymentIntent.metadata?.public_ticket_purchase_id !== purchase.id
      || paymentIntent.metadata?.tenant_id !== tenantId
      || paymentIntent.metadata?.event_id !== eventId
      || !paymentIntent.latest_charge || typeof paymentIntent.latest_charge !== 'object'
      || paymentIntent.latest_charge.refunded !== false
      || paymentIntent.latest_charge.paid !== true
      || paymentIntent.latest_charge.captured !== true
      || Number(paymentIntent.latest_charge?.amount_refunded || 0) > 0) {
    throw new PublicTicketMemberError(
      'PAYMENT_NOT_ELIGIBLE', 'Member records require a verified, captured and unrefunded payment.', 409,
    );
  }
}

export async function completePublicTicketMembers({
  db, purchase, tenantId, bookingIds, paymentStatus, paymentIntentId = null,
}) {
  if (!purchase) return { state: 'not_applicable' };
  if (!['paid', 'free'].includes(paymentStatus) || !bookingIds?.length) {
    return { state: 'excluded' };
  }
  // Call only after ALL bookings, capacity checks and reversible financial work
  // have succeeded. Neither Stripe authorization nor a single booking is proof.
  const evidence = { status: paymentStatus, complete_batch: true, payment_intent_id: paymentIntentId };
  const { error } = await db.from('public_ticket_member_purchase')
    .update({ state: 'ready', booking_ids: bookingIds, completion_evidence: evidence, updated_at: new Date().toISOString() })
    .eq('id', purchase.id).eq('tenant_id', tenantId).in('state', ['prepared', 'retryable', 'conflict']);
  if (error) return { state: 'retryable', code: 'completion_evidence_unavailable' };
  const result = await db.rpc('provision_public_ticket_members', { p_purchase_id: purchase.id });
  if (result.error) return { state: 'retryable', code: 'provisioning_unavailable' };
  return result.data;
}

// Recovery re-establishes the entire success boundary rather than trusting an
// old pending flag. It never charges, inserts bookings or edits existing people.
export async function recoverPublicTicketMembers({ db, purchase, loadPaymentIntent }) {
  if (purchase.state === 'completed') return { state: 'completed', replayed: true };
  if (!purchase.booking_ids?.length) return { state: 'prepared' };
  const source = purchase.event_kind === 'simple' ? 'booking' : 'complex_event_booking';
  const { data: bookings, error } = await db.from(source).select('*')
    .eq('tenant_id', purchase.tenant_id).eq('event_id', purchase.event_id).in('id', purchase.booking_ids);
  if (error || !Array.isArray(bookings)) throw unavailable();
  const expected = purchase.snapshot.booking_items.reduce((sum, item) => sum + item.attendees.length, 0);
  if (bookings.length !== expected || bookings.length !== purchase.booking_ids.length
      || bookings.some(booking => booking.status !== 'confirmed'
        || booking.member_id != null || booking.organization_id != null)) {
    await db.from('public_ticket_member_purchase').update({
      state: 'excluded', last_error_code: 'booking_batch_not_confirmed', updated_at: new Date().toISOString(),
    }).eq('id', purchase.id).neq('state', 'completed');
    return { state: 'excluded' };
  }
  let paymentStatus = 'free';
  if (purchase.stripe_payment_intent_id) {
    const intent = await loadPaymentIntent(purchase.tenant_id, purchase.stripe_payment_intent_id);
    assertPublicTicketPaymentEvidence(intent, purchase, purchase.tenant_id, purchase.event_id);
    if (bookings.some(booking => booking.payment_method !== 'card'
        || booking.stripe_payment_intent_id !== intent.id)) throw unavailable();
    paymentStatus = 'paid';
  } else if (bookings.some(booking => booking.payment_method !== 'free')) {
    throw new PublicTicketMemberError('PAYMENT_NOT_ELIGIBLE', 'This is not a confirmed free purchase.', 409);
  }
  return completePublicTicketMembers({
    db, purchase, tenantId: purchase.tenant_id, bookingIds: purchase.booking_ids,
    paymentStatus, paymentIntentId: purchase.stripe_payment_intent_id,
  });
}
