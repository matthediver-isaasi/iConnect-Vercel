import { buildPostGraceDateTransition } from './postGraceDateTransition.js';

async function one(query, label, required = true) {
  const { data, error } = await query.maybeSingle();
  if (error || (required && !data)) {
    throw new Error(`${label} unavailable: ${error?.message || 'record not found'}`);
  }
  return data;
}

/**
 * Server-only adapter. Evidence must come from the verified provider payment,
 * never from a browser return or mandate setup. It writes through ONE RPC;
 * there is intentionally no REST-update fallback on an absent migration.
 *
 * This finalizes local dates only. Callers must reconcile provider scheduling
 * before releasing their collection hold or activating membership access.
 */
export async function finalizePostGraceRecordDates(db, {
  tenantId, memberId, electionId, evidence, now = new Date(),
}) {
  if (!tenantId || !memberId || !electionId) throw new Error('Scoped successor identity is required');
  const saved = await one(db.from('membership_post_grace_renewal').select('*')
    .eq('tenant_id', tenantId).eq('member_id', memberId).eq('election_id', electionId),
  'Post-grace reservation', false);
  if (!saved) return { applicable: false };
  if (saved.status === 'released') throw new Error('Post-grace checkout has been released');
  if (evidence?.tenantId !== tenantId || evidence?.memberId !== memberId
      || evidence?.reservationId !== saved.id) {
    throw new Error('Provider evidence does not belong to this post-grace reservation');
  }
  const receipt = await one(db.from('membership_post_grace_date_application').select('*')
    .eq('reservation_id', saved.id).eq('tenant_id', tenantId).eq('member_id', memberId),
  'Post-grace application', false);
  let expected;
  if (receipt) {
    // An exact replay uses the original before image, not the now-updated row.
    // The RPC still verifies payment ID, provider, amount and timestamp.
    if (receipt.state !== 'applied') throw new Error('Post-grace application requires recovery');
    expected = receipt.before_rows;
  } else {
    const history = await one(db.from('member_membership_history').select('*')
      .eq('tenant_id', tenantId).eq('member_id', memberId)
      .neq('status', 'expired_checkout')
      .eq('membership_successor_election_id', electionId), 'Pending membership');
    let agreement = null, plan = null;
    if (saved.payment_method !== 'upfront') {
      if (!history.billing_agreement_id) throw new Error('Pending membership has no billing agreement');
      agreement = await one(db.from('membership_billing_agreements').select('*')
        .eq('id', history.billing_agreement_id).eq('tenant_id', tenantId).eq('member_id', memberId),
      'Pending agreement');
      plan = await one(db.from('membership_payment_plans').select('*')
        .eq('billing_agreement_id', agreement.id).eq('tenant_id', tenantId).eq('member_id', memberId),
      'Pending payment plan', !!agreement.payment_plan_id);
    }
    const funded = agreement?.metadata?.card?.voucher_funding || agreement?.metadata?.dd?.voucher_funding;
    const transition = funded ? { before: { history, agreement, plan } } : buildPostGraceDateTransition({
      reservation: {
        id: saved.id, tenantId, memberId, electionId, historyId: history.id,
        previousTermId: saved.previous_term_id, paymentMethod: saved.payment_method,
        firstPaymentMinor: Number(saved.first_payment_minor), currency: saved.currency,
        createdAt: saved.created_at, graceEndDate: saved.grace_end_date,
        commencementBasis: 'confirmed_payment',
      },
      evidence, history, agreement, plan, now,
    });
    expected = transition.before;
  }
  const funded = expected.agreement?.metadata?.card?.voucher_funding || expected.agreement?.metadata?.dd?.voucher_funding;
  // The protected funded RPC verifies the actual cash and reserved credit
  // separately before it calls the common atomic date writer. Never disguise
  // the provider's net cash amount as a gross payment in JavaScript.
  const { data, error } = await db.rpc(funded ? 'apply_post_grace_funded_dates' : 'apply_post_grace_record_dates', {
    p_tenant_id: tenantId, p_member_id: memberId, p_reservation_id: saved.id,
    p_provider: evidence.provider, p_payment_id: evidence.id, p_status: evidence.status,
    p_paid_at: evidence.paidAt,
    ...(funded ? { p_cash_minor: evidence.amountMinor, p_settlement_id: funded.settlement_id }
      : { p_amount_minor: evidence.amountMinor }),
    p_currency: evidence.currency, p_expected: expected,
  });
  if (error) throw new Error(`Post-grace dates were not finalized: ${error.message}`);
  if (!data || data.state !== 'applied' || data.reservation_id !== saved.id
      || data.tenant_id !== tenantId || data.member_id !== memberId) {
    throw new Error('Post-grace finalization receipt could not be verified');
  }
  return { applicable: true, receipt: data, releaseCollectionHold: false };
}
