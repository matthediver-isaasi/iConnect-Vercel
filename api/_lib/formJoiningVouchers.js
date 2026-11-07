import { randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { snapshotFormMembershipPayment } from './formMembershipPaymentQuote.js';

export async function findJoiningVoucherCheckout(db, { tenantId, memberId }) {
  const { data, error } = await db.from('form_joining_voucher_checkout').select('*')
    .eq('tenant_id', tenantId).eq('member_id', memberId).is('released_at', null).maybeSingle();
  if (error && ['42P01', 'PGRST205'].includes(error.code)) return null;
  if (error) throw new Error('Your first-membership checkout could not be verified. Please retry.');
  return data;
}

export async function bindJoiningVoucherCheckout(db, { tenantId, memberId, simulation, paymentMethod, formId, paymentFieldId }) {
  const modes = { upfront: 'stripe_upfront', monthly_card: 'stripe_monthly', direct_debit: 'direct_debit' };
  if (!modes[paymentMethod] || !formId || !paymentFieldId || !simulation?.success) {
    throw new Error('A verified membership quote and payment choice are required.');
  }
  const frozen = snapshotFormMembershipPayment(structuredClone(simulation)).simResult;
  const breakdown = { ...frozen, totalWithVat: frozen.totalWithVat ?? frozen.finalCost,
    formJoiningVoucher: { version: 1, formId, paymentFieldId, paymentMode: modes[paymentMethod], simulation: frozen } };
  const { data, error } = await db.rpc('bind_form_joining_voucher_checkout', {
    p_tenant_id: tenantId, p_member_id: memberId, p_breakdown: breakdown,
    p_token: randomBytes(32).toString('hex'),
  });
  if (error || !data?.id) throw new Error(error?.message || 'Could not save first-membership credit checkout.');
  return data;
}

export async function loadJoiningVoucherAuthority(db, token) {
  const marker = token.cost_breakdown?.formJoiningVoucher;
  if (!marker) return null;
  const saved = await findJoiningVoucherCheckout(db, { tenantId: token.tenant_id, memberId: token.member_id });
  if (!saved || saved.fee_token_id !== token.id || token.organization_id
      || !isDeepStrictEqual(saved.breakdown, token.cost_breakdown)
      || marker.simulation?.membershipYear?.label !== token.membership_year
      || Number(token.final_cost) !== Number(marker.simulation?.finalCost)
      || token.currency !== (marker.simulation?.currency || 'GBP')) {
    throw new Error('The saved first-membership credit checkout requires review. Do not start another payment.');
  }
  const owner = await db.from('member').select('id,membership_paused').eq('tenant_id', token.tenant_id)
    .eq('id', token.member_id).maybeSingle();
  if (owner.error || !owner.data || owner.data.membership_paused === true) {
    throw new Error('Membership owner could not be verified or membership is paused.');
  }
  return marker;
}

export function joiningVoucherHistoryFields(token) {
  const sim = token.cost_breakdown?.formJoiningVoucher?.simulation;
  if (!sim) return {};
  return {
    ...(sim.commitment || sim.paymentSchedule || {}),
    term_start_date: String(sim.membershipYear.start).slice(0, 10),
    term_end_date: String(sim.membershipYear.end).slice(0, 10),
    renewal_policy_snapshot: sim.config,
    status: 'pending_payment_setup',
  };
}
