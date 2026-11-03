import { discoverMembershipVouchers } from './membershipVoucherQuote.js';
import { randomBytes } from 'node:crypto';
import { snapshotFormMembershipPayment } from './formMembershipPaymentQuote.js';

export const FORM_VOUCHER_MODES = {
  upfront: 'stripe_upfront', monthly_card: 'stripe_monthly', direct_debit: 'direct_debit',
};

export class FormVoucherVerificationError extends Error {
  constructor(code, message, status = 409) {
    super(message);
    this.code = code;
    this.status = status;
    this.retryable = status === 503;
  }
}

function verificationUnavailable() {
  throw new FormVoucherVerificationError('FORM_VOUCHER_VERIFICATION_UNAVAILABLE',
    'Your saved checkout could not be verified right now. Retry checking its status; do not start another payment.', 503);
}

export function requireFormScope(formId, paymentFieldId) {
  if (![formId, paymentFieldId].every(v => typeof v === 'string' && v.trim().length > 0)) {
    throw new FormVoucherVerificationError('FORM_VOUCHER_SCOPE_REQUIRED',
      'The renewal form and payment field must each be supplied once. Reload the saved form.', 400);
  }
}

export function formVoucherMonthlySnapshot(snapshot, election) {
  if (election?.quote?.simulation?.formRenewal?.state !== 'post_grace_renewal') return snapshot;
  if (!election.id || !snapshot?.voucher_funding?.settlement_id) {
    throw new Error('Post-grace monthly credit requires its reserved funding');
  }
  if (snapshot.post_grace_election_id && snapshot.post_grace_election_id !== election.id) {
    throw new Error('Monthly credit belongs to another renewal');
  }
  return { ...snapshot, post_grace_election_id: election.id };
}

export function validateFormVoucherSelection(discovery, ids) {
  if (!discovery?.enabled || !Array.isArray(ids) || ids.length < 1 || ids.length > 100
      || ids.some(id => typeof id !== 'string' || !id)
      || new Set(ids).size !== ids.length) {
    throw new Error('Select one or more available membership vouchers.');
  }
  const available = new Map(discovery.vouchers.map(v => [v.id, v]));
  if (ids.some(id => !available.has(id))) {
    throw new Error('A selected voucher is no longer available. Refresh your available credit.');
  }
  return ids.map(id => available.get(id));
}

export async function formVoucherCheckoutReady(db) {
  const result = await db.rpc('form_membership_voucher_checkout_ready_v2');
  if (result.error && ['42883', 'PGRST202'].includes(result.error.code)) return false;
  if (result.error) throw new Error('Could not verify credit checkout availability');
  return result.data === true;
}

export function formVoucherBreakdown(election) {
  const simulation = election.quote?.simulation;
  if (!simulation?.success || !FORM_VOUCHER_MODES[election.payment_method]) {
    throw new Error('A saved renewal and payment method are required before vouchers can be used.');
  }
  const snapshot = snapshotFormMembershipPayment(simulation);
  const commitment = snapshot.simResult.commitment;
  return {
    ...simulation, totalWithVat: simulation.totalWithVat ?? simulation.finalCost,
    ...(commitment?.term_key ? { commitment } : {}),
    formVoucher: {
      version: 1, electionId: election.id, paymentMode: FORM_VOUCHER_MODES[election.payment_method],
      simulation,
    },
  };
}

export async function bindFormMembershipVoucherCheckout(db, { tenantId, memberId, election, formId, paymentFieldId }) {
  requireFormScope(formId, paymentFieldId);
  const breakdown = formVoucherBreakdown(election);
  Object.assign(breakdown.formVoucher, { formId, paymentFieldId });
  const { data, error } = await db.rpc('bind_form_membership_voucher_checkout', {
    p_tenant_id: tenantId, p_member_id: memberId, p_election_id: election.id,
    p_breakdown: breakdown, p_token: randomBytes(32).toString('hex'),
  });
  if (error || !data?.id) throw new Error(error?.message || 'Could not save the credit checkout');
  if (formId && (data.cost_breakdown?.formVoucher?.formId !== formId
      || data.cost_breakdown?.formVoucher?.paymentFieldId !== paymentFieldId)) {
    throw new Error('Continue the credit checkout in the original renewal form.');
  }
  return data;
}

export async function loadFormVoucherAuthority(db, token) {
  const marker = token.cost_breakdown?.formVoucher;
  if (!marker) return null;
  const result = await db.from('form_membership_voucher_checkout').select('*')
    .eq('fee_token_id', token.id).eq('tenant_id', token.tenant_id).eq('member_id', token.member_id).is('released_at', null).maybeSingle();
  if (result.error) verificationUnavailable();
  if (!result.data || result.data.election_id !== marker.electionId) {
    throw new Error('The form credit checkout could not be verified');
  }
  const saved = await db.from('membership_successor_election').select('*')
    .eq('id', marker.electionId).eq('tenant_id', token.tenant_id).eq('member_id', token.member_id).maybeSingle();
  const e = saved.data;
  if (saved.error) verificationUnavailable();
  if (!e || e.organization_id || e.status !== 'reserved' || e.origin !== 'form'
      || (e.switch_state && e.switch_state !== 'idle')
      || e.quote?.payerMemberId !== token.member_id
      || FORM_VOUCHER_MODES[e.payment_method] !== marker.paymentMode
      || e.quote?.simulation?.membershipYear?.label !== token.membership_year
      ) {
    throw new Error('The reserved renewal no longer matches this credit checkout');
  }
  return e;
}

export async function readFormVoucherCheckout(db, { tenantId, memberId, checkoutId, formId, paymentFieldId }) {
  requireFormScope(formId, paymentFieldId);
  if (typeof checkoutId !== 'string' || !checkoutId) throw new FormVoucherVerificationError(
    'FORM_VOUCHER_CHECKOUT_REQUIRED', 'The saved form checkout is required', 400);
  const fee = await db.from('membership_fee_token').select('*').eq('id', checkoutId)
    .eq('tenant_id', tenantId).eq('member_id', memberId).is('organization_id', null).maybeSingle();
  const token = fee.data;
  if (fee.error) verificationUnavailable();
  if (token && (!token.cost_breakdown?.formVoucher?.formId || !token.cost_breakdown?.formVoucher?.paymentFieldId)) {
    throw new FormVoucherVerificationError('FORM_VOUCHER_SCOPE_UNVERIFIED',
      'This saved checkout needs support to verify its original renewal form. Do not start another payment.');
  }
  if (!token || token.cost_breakdown?.formVoucher?.formId !== formId
      || token.cost_breakdown?.formVoucher?.paymentFieldId !== paymentFieldId) {
    throw new FormVoucherVerificationError('FORM_VOUCHER_CHECKOUT_MISMATCH',
      'The saved checkout does not belong to this member and form. Contact support to verify the original checkout; do not start another payment.');
  }
  const election = await loadFormVoucherAuthority(db, token);
  if (!election) throw new Error('The saved renewal could not be verified');
  let history = null;
  if (token.history_record_id) {
    const saved = await db.from('member_membership_history').select('*').eq('id', token.history_record_id)
      .eq('tenant_id', tenantId).eq('member_id', memberId)
      .eq('membership_successor_election_id', election.id).maybeSingle();
    if (saved.error) verificationUnavailable();
    if (!saved.data) throw new Error('The saved membership payment could not be verified');
    history = saved.data;
  }
  const setup = await formVoucherSetupStatus(db, { tenantId, memberId, electionId: election.id, token: token.token });
  return { token, election, history, setup };
}

export async function findFormVoucherCheckout(db, { tenantId, memberId, electionId, formId, paymentFieldId }) {
  if (!electionId) return null;
  const found = await db.from('form_membership_voucher_checkout').select('fee_token_id')
    .eq('tenant_id', tenantId).eq('member_id', memberId).eq('election_id', electionId)
    .is('released_at', null).maybeSingle();
  if (found.error && ['42P01', 'PGRST205'].includes(found.error.code)) return null;
  if (found.error) verificationUnavailable();
  if (!found.data) return null;
  // Discovery of an existing election must not bypass the form-scope checks
  // used by a saved answer. Never offer its payment capability in another form.
  const receipt = await readFormVoucherCheckout(db, {
    tenantId, memberId, checkoutId: found.data.fee_token_id, formId, paymentFieldId,
  });
  return receipt.token.token;
}

export async function formVoucherSetupStatus(db, { tenantId, memberId, electionId, token }) {
  if (!token || !electionId) return null;
  const fee = await db.from('membership_fee_token').select('id')
    .eq('token', token).eq('tenant_id', tenantId).eq('member_id', memberId).maybeSingle();
  if (fee.error) verificationUnavailable();
  if (!fee.data) throw new Error('Credit checkout status could not be verified');
  const funding = await db.from('membership_voucher_settlement').select('billing_agreement_id,state')
    .eq('fee_token_id', fee.data.id).eq('tenant_id', tenantId).neq('state', 'released').maybeSingle();
  if (funding.error) verificationUnavailable();
  if (!funding.data?.billing_agreement_id || !['plan_committed', 'committed'].includes(funding.data.state)) return null;
  const agreement = await db.from('membership_billing_agreements')
    .select('id,provider,status,gocardless_mandate_id')
    .eq('id', funding.data.billing_agreement_id).eq('tenant_id', tenantId).eq('member_id', memberId)
    .eq('membership_successor_election_id', electionId).is('organization_id', null).maybeSingle();
  if (agreement.error) verificationUnavailable();
  const a = agreement.data;
  if (!a || !['active', 'first_payment_pending'].includes(a.status)) return null;
  if (a.provider === 'gocardless' && a.gocardless_mandate_id) {
    return { status: 'direct_debit_started', agreementId: a.id };
  }
  if (a.provider !== 'stripe') return null;
  const plan = await db.from('membership_payment_plans').select('id,stripe_subscription_id,status')
    .eq('billing_agreement_id', a.id).eq('tenant_id', tenantId).eq('member_id', memberId)
    .is('organization_id', null).maybeSingle();
  if (plan.error) verificationUnavailable();
  return plan.data?.stripe_subscription_id && ['active', 'first_payment_pending'].includes(plan.data.status)
    ? { status: 'monthly_card_started', agreementId: a.id } : null;
}

export function formVoucherHistoryFields(token) {
  const marker = token.cost_breakdown?.formVoucher;
  if (!marker) return {};
  return {
    membership_successor_election_id: marker.electionId,
    previous_term_id: marker.simulation.previousTerm?.id || null,
    renewal_policy_snapshot: marker.simulation.config,
    term_start_date: marker.simulation.membershipYear.start.slice(0, 10),
    term_end_date: marker.simulation.membershipYear.end.slice(0, 10),
    status: 'pending_payment_setup',
  };
}

/**
 * Discovery does not create a fee token, reserve a successor, or reserve credit.
 * Ownership is taken exclusively from the authenticated payment controller.
 */
export async function discoverFormMembershipVouchers(db, { tenantId, memberId, organizationId, currency }) {
  if (!tenantId || !memberId) throw new Error('Verified membership owner is required');
  if (organizationId) return { enabled: false, vouchers: [] };
  const result = await discoverMembershipVouchers(db, {
    tenant_id: tenantId, member_id: memberId, organization_id: null, currency: currency || 'GBP',
  });
  return {
    enabled: result.enabled,
    currency: currency || 'GBP',
    checkoutReady: await formVoucherCheckoutReady(db),
    vouchers: result.vouchers.map(({ id, code, displayName, ownerType, value, expires_at }) =>
      ({ id, code, displayName, ownerType, value, expires_at })),
  };
}
