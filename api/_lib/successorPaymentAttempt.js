/** Called only after retrieving an intent from the tenant's membership provider. */
export async function resumeSuccessorPaymentAttempt(db, stripe, reservation, cancelled, now) {
  if (cancelled.status !== 'canceled' || !cancelled.id) throw new Error('Confirmed cancellation is required');
  const { data: attempts, error } = await db.from('membership_successor_payment_attempt')
    .select('*').eq('tenant_id', reservation.tenant_id).eq('quote_id', reservation.id)
    .order('attempt_number', { ascending: false }).limit(1);
  if (error) throw new Error('Could not reconcile the saved payment attempts');
  let attempt = attempts?.[0];
  if (attempt?.provider_intent_id) {
    const current = await stripe.paymentIntents.retrieve(attempt.provider_intent_id);
    if (current.status !== 'canceled') return current;
    cancelled = current;
    attempt = null;
  }
  if (!attempt) {
    const claimed = await db.rpc('reserve_successor_payment_attempt', {
      p_tenant_id: reservation.tenant_id, p_quote_id: reservation.id,
      p_cancelled_intent_id: cancelled.id,
    });
    if (claimed.error || !claimed.data?.id) throw new Error('Could not reserve a replacement payment attempt');
    attempt = claimed.data;
  }
  if (attempt.provider_intent_id) return stripe.paymentIntents.retrieve(attempt.provider_intent_id);
  const created = Date.parse(attempt.created_at);
  if (!Number.isFinite(created) || new Date(now).getTime() - created >= 23 * 60 * 60 * 1000) {
    throw new Error('The interrupted payment attempt requires provider reconciliation before retrying');
  }
  const params = reservation.quote.paymentIntentParams;
  const intent = await stripe.paymentIntents.create({ ...params, metadata: {
    ...params.metadata, membership_quote_id: reservation.id, membership_attempt_id: attempt.id,
  } }, { idempotencyKey: `membership-attempt:${attempt.id}` });
  await bindSuccessorPaymentAttempt(db, reservation, intent, attempt.id);
  return intent;
}

export async function bindSuccessorPaymentAttempt(db, reservation, intent, attemptId) {
  const result = await db.rpc('bind_successor_payment_attempt', {
    p_tenant_id: reservation.tenant_id, p_quote_id: reservation.id,
    p_attempt_id: attemptId, p_intent_id: intent.id,
  });
  if (result.error || result.data !== true) throw new Error('Could not bind the replacement payment attempt');
}