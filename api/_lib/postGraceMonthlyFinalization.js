import { finalizePostGraceRecordDates } from './postGraceFinalization.js';

const marker = agreement => agreement?.metadata?.card?.post_grace_election_id
  || agreement?.metadata?.dd?.post_grace_election_id;
async function reservationFor(db, agreement) {
  const electionId = marker(agreement);
  if (!electionId) return null;
  if (electionId !== agreement.membership_successor_election_id || !agreement.member_id || agreement.organization_id) {
    throw new Error('Restart agreement identity does not match its reservation');
  }
  const { data, error } = await db.from('membership_post_grace_renewal').select('*')
    .eq('tenant_id', agreement.tenant_id).eq('member_id', agreement.member_id).eq('election_id', electionId).maybeSingle();
  if (error || !data || data.status === 'released') throw new Error('Restart payment reservation is unavailable');
  return data;
}
async function applied(db, reservation) {
  const { data, error } = await db.from('membership_post_grace_date_application').select('state')
    .eq('reservation_id', reservation.id).eq('tenant_id', reservation.tenant_id)
    .eq('member_id', reservation.member_id).maybeSingle();
  if (error) throw new Error('Restart date application could not be verified');
  return reservation.status === 'settled' && data?.state === 'applied';
}
export async function postGraceActivationReady(db, agreement) {
  const reservation = await reservationFor(db, agreement);
  return !reservation || await applied(db, reservation);
}
async function finalize(db, agreement, reservation, evidence) {
  await finalizePostGraceRecordDates(db, {
    tenantId: agreement.tenant_id, memberId: agreement.member_id, electionId: reservation.election_id,
    evidence: { ...evidence, tenantId: agreement.tenant_id, memberId: agreement.member_id, reservationId: reservation.id },
  });
}
async function refresh(db, agreement, plan) {
  const result = await db.from('membership_billing_agreements').select('*')
    .eq('tenant_id', agreement.tenant_id).eq('member_id', agreement.member_id).eq('id', agreement.id).maybeSingle();
  if (result.error || !result.data) throw new Error('Finalized restart agreement could not be refreshed');
  Object.assign(agreement, result.data);
  if (plan) {
    const result = await db.from('membership_payment_plans').select('*')
      .eq('tenant_id', agreement.tenant_id).eq('member_id', agreement.member_id).eq('id', plan.id).maybeSingle();
    if (result.error || !result.data) throw new Error('Finalized restart plan could not be refreshed');
    Object.assign(plan, result.data);
  }
}
export async function finalizePostGraceCardInvoice(db, { stripe, agreement, plan }) {
  const reservation = await reservationFor(db, agreement);
  if (!reservation) return;
  if (!await applied(db, reservation)) {
    if (reservation.payment_method !== 'monthly_card' || !plan?.stripe_subscription_id) {
      throw new Error('Restart card subscription cannot be verified');
    }
    // Webhooks can arrive out of order. Ask the provider for the first actual
    // paid invoice rather than dating service from whichever callback arrives.
    const paid = [];
    let cursor;
    for (let page = 0; page < 20; page++) {
      const result = await stripe.invoices.list({ subscription: plan.stripe_subscription_id,
        status: 'paid', limit: 100, ...(cursor ? { starting_after: cursor } : {}) });
      if (!Array.isArray(result.data)) throw new Error('Stripe payment history is unavailable');
      paid.push(...result.data.filter(invoice => invoice.status === 'paid' && Number(invoice.amount_paid) > 0));
      if (!result.has_more) { cursor = null; break; }
      const next = result.data.at(-1)?.id;
      if (!next || cursor === next) throw new Error('Stripe payment history did not advance');
      cursor = next;
    }
    if (cursor) throw new Error('Stripe payment history is incomplete');
    paid.sort((a, b) => Number(a.status_transitions?.paid_at) - Number(b.status_transitions?.paid_at));
    const first = paid[0];
    if (!first || !Number.isSafeInteger(first.status_transitions?.paid_at)) {
      throw new Error('First successful Stripe instalment is unavailable');
    }
    await finalize(db, agreement, reservation, {
      provider: 'stripe', id: first.id, status: 'succeeded',
      paidAt: new Date(first.status_transitions.paid_at * 1000).toISOString(),
      amountMinor: first.amount_paid, currency: first.currency.toUpperCase(),
    });
  }
  await refresh(db, agreement, plan);
}

export async function finalizePostGraceDirectDebit(db, { gc, agreement, plan, paymentId }) {
  const reservation = await reservationFor(db, agreement);
  if (!reservation) return;
  if (!await applied(db, reservation)) {
    if (reservation.payment_method !== 'direct_debit') throw new Error('Restart is not a Direct Debit purchase');
    const payments = [];
    const initialId = agreement.metadata?.gocardless_initial_payment?.id;
    if (initialId) payments.push(await gc.getPayment(initialId));
    if (plan) {
      const subscriptionId = plan.gocardless_subscription_id;
      const mandateId = agreement.gocardless_mandate_id;
      if (!subscriptionId && !mandateId) throw new Error('Direct Debit payment scope is unavailable');
      let after;
      for (let page = 0; page < 20; page++) {
        const result = await gc.listPaymentsPage({ ...(subscriptionId ? { subscriptionId } : { mandateId }),
          after, limit: 100 });
        payments.push(...result.payments.filter(payment => subscriptionId || payment.metadata?.plan_id === plan.id));
        if (!result.after) { after = null; break; }
        if (after === result.after) throw new Error('Direct Debit payment history did not advance');
        after = result.after;
      }
      if (after) throw new Error('Direct Debit payment history is incomplete');
    } else if (!initialId || initialId !== paymentId) {
      throw new Error('Initial Direct Debit payment identity is unavailable');
    }
    // charge_date is the provider's bank collection date, accepted only after
    // the payment is confirmed/paid out; neither setup nor creation is payment.
    const confirmed = payments.filter(payment => ['confirmed', 'paid_out'].includes(payment.status)
      && Number(payment.amount) > 0);
    if (confirmed.some(payment => !/^\d{4}-\d{2}-\d{2}$/.test(payment.charge_date || ''))) {
      throw new Error('Confirmed Direct Debit collection date is unavailable');
    }
    confirmed.sort((a, b) => a.charge_date.localeCompare(b.charge_date));
    const first = confirmed[0];
    if (!first) throw new Error('First confirmed Direct Debit collection is unavailable');
    await finalize(db, agreement, reservation, {
      provider: 'gocardless', id: first.id, status: first.status,
      paidAt: `${first.charge_date}T00:00:00.000Z`, amountMinor: first.amount,
      currency: first.currency.toUpperCase(),
    });
  }
  await refresh(db, agreement, plan);
}
