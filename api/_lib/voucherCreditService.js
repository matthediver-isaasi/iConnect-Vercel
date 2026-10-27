/**
 * Task 5241 service contract (all identities/settings must be server-derived).
 *
 * canReadVoucher(voucher, {tenantId, memberId, organizationId, isAdmin})
 * assertVoucherEligible(voucher, {tenantId, memberId, organizationId,
 *   isAuthenticated, isAdmin, roleId, organization, settings, currency,
 *   allowOrganization=true, now})
 * reserveVoucherCredit(db, {tenantId, purchaseKey, memberId,
 *   authenticatedMemberId=null, voucherIds, payableMinor, currency='GBP',
 *   allowOrganization=true, manualOrder=false}) -> reservation JSON
 * commitVoucherCredit(db, {tenantId, purchaseKey}) -> reservation JSON
 * releaseVoucherCredit(db, {tenantId, purchaseKey, providerOutcome})
 *   outcome MUST be 'not_started', 'failed', 'cancelled', or 'refunded';
 *   never release an uncertain/pending provider outcome.
 * administerVoucher(db, {tenantId, voucherId=null, operation, values,
 *   actor, idempotencyKey}) -> voucher JSON.
 * Admin authority MUST be checked by caller before administerVoucher.
 * refundBookingVoucherCredit(db, {tenantId, bookingId, source,
 *   refundAllocation=null, reversalOptions={}}) -> {vouchers, replacements}.
 * Source must be 'booking' or 'complex_event_booking'. Caller authorizes the
 * cancellation and replacement policy; RPC derives original usage/owners from
 * persisted booking+ledger, never from caller-provided voucher IDs or amounts.
 * refundVoucherAllocation(db, {tenantId, allocationId, refundKey,
 *   cumulativeMinor, reversalOptions={}}) -> original-owner refund result.
 * For confirmed existing non-booking refunds only. Caller verifies provider
 * evidence and derives the cumulative allocation from the purchased funding.
 * The RPC serializes original-purchase refunds, caps total restoration to
 * original usage, and requires explicit expiry approval for replacements.
 *
 * SQL RPCs:
 * voucher_credit_reserve(p_tenant_id uuid,p_purchase_key text,p_member_id uuid,
 *   p_authenticated_member_id uuid,p_voucher_ids uuid[],p_payable_minor bigint,
 *   p_currency text,p_allow_organization boolean,p_manual_order boolean)
 * voucher_credit_transition(p_tenant_id uuid,p_purchase_key text,p_action text,
 *   p_provider_outcome text)
 * voucher_admin_write(p_tenant_id uuid,p_voucher_id uuid,p_operation text,
 *   p_values jsonb,p_actor text,p_idempotency_key text)
 * 'issue' creates; 'update' applies metadata and absolute value adjustment with
 * ledger; 'delete' only deletes never-used zero-value vouchers. 'expire' is
 * CRON/SERVER ONLY: elapsed expiry required; outstanding reservations block it;
 * values must be {}; it atomically records expiry and zeros remaining credit.
 * RPCs are service_role-only. Never forward raw request actor/tenant/identity.
 */
import { normalizeVoucherSettings, voucherOwnerType } from '../../shared/voucherPolicy.js';

export class VoucherCreditError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = 'VoucherCreditError';
    this.statusCode = statusCode;
  }
}

export function canReadVoucher(voucher, context) {
  if (!voucher || !context?.tenantId || voucher.tenant_id !== context.tenantId) return false;
  if (context.isAdmin === true) return true;
  const type = voucherOwnerType(voucher);
  return type === 'member'
    ? !!context.memberId && voucher.member_id === context.memberId
    : type === 'organization' && !!context.organizationId && voucher.organization_id === context.organizationId;
}

export function assertVoucherEligible(voucher, context) {
  if (!canReadVoucher(voucher, { ...context, isAdmin: false })) {
    throw new VoucherCreditError('Voucher is not owned by the purchaser', 403);
  }
  const type = voucherOwnerType(voucher);
  if (type === 'member') {
    if (!normalizeVoucherSettings(context.settings).individual_vouchers_enabled) {
      throw new VoucherCreditError('Individual vouchers are disabled', 403);
    }
  } else {
    if (context.allowOrganization === false || context.isAuthenticated !== true
      || context.organization?.id !== voucher.organization_id
      || context.organization?.tenant_id !== context.tenantId) {
      throw new VoucherCreditError('Authenticated organization authority is required', 403);
    }
    const roles = context.organization.voucher_allowed_role_ids || [];
    if (!Array.isArray(roles) || (roles.length && !roles.includes(context.roleId))) {
      throw new VoucherCreditError('Your role cannot use organization vouchers', 403);
    }
  }
  const now = new Date(context.now ?? Date.now()).getTime();
  const membershipCredit=voucher.funding_source==='membership_change'&&!!voucher.member_id;
  if(membershipCredit&&context.allowMembershipChangeCredit!==true){
    throw new VoucherCreditError('This credit is available for eligible membership payments only');
  }
  const expires = membershipCredit&&voucher.expires_at==null ? Infinity : Date.parse(voucher.expires_at);
  const starts = voucher.valid_from == null ? -Infinity : Date.parse(voucher.valid_from);
  if (voucher.status !== 'active' || !(Number(voucher.value) > 0)
    || (expires!==Infinity&&!Number.isFinite(expires)) || expires <= now || Number.isNaN(starts) || starts > now) {
    throw new VoucherCreditError('Voucher is not currently available');
  }
  if ((voucher.currency || 'GBP').toUpperCase() !== (context.currency || 'GBP').toUpperCase()) {
    throw new VoucherCreditError('Voucher currency does not match the purchase');
  }
  return voucher;
}

async function rpc(db, name, args) {
  const { data, error } = await db.rpc(name, args);
  if (error) throw new VoucherCreditError(error.message, error.code === '42501' ? 403 : 409);
  return data;
}

export function reserveVoucherCredit(db, input) {
  if (!Number.isSafeInteger(input.payableMinor) || input.payableMinor < 0) {
    throw new VoucherCreditError('An authoritative nonnegative minor-unit total is required');
  }
  return rpc(db, 'voucher_credit_reserve', {
    p_tenant_id: input.tenantId, p_purchase_key: input.purchaseKey,
    p_member_id: input.memberId, p_authenticated_member_id: input.authenticatedMemberId || null,
    p_voucher_ids: input.voucherIds || [], p_payable_minor: input.payableMinor,
    p_currency: (input.currency || 'GBP').toUpperCase(),
    p_allow_organization: input.allowOrganization !== false, p_manual_order: input.manualOrder === true,
  });
}
export function commitVoucherCredit(db, input) {
  return rpc(db, 'voucher_credit_transition', {
    p_tenant_id: input.tenantId, p_purchase_key: input.purchaseKey,
    p_action: 'commit', p_provider_outcome: null,
  });
}
export function releaseVoucherCredit(db, input) {
  if (!['not_started', 'failed', 'cancelled', 'refunded'].includes(input.providerOutcome)) {
    throw new VoucherCreditError('Reconcile the provider outcome before releasing voucher credit', 409);
  }
  return rpc(db, 'voucher_credit_transition', {
    p_tenant_id: input.tenantId, p_purchase_key: input.purchaseKey,
    p_action: 'release', p_provider_outcome: input.providerOutcome,
  });
}
export function administerVoucher(db, input) {
  return rpc(db, 'voucher_admin_write', {
    p_tenant_id: input.tenantId, p_voucher_id: input.voucherId || null,
    p_operation: input.operation, p_values: input.values || {},
    p_actor: input.actor, p_idempotency_key: input.idempotencyKey,
  });
}

export function refundVoucherAllocation(db, input) {
  return rpc(db, 'voucher_credit_refund_allocation', {
    p_tenant_id: input.tenantId, p_allocation_id: input.allocationId,
    p_refund_key: input.refundKey, p_cumulative_minor: input.cumulativeMinor,
    p_reversal_options: input.reversalOptions || {},
  });
}

export function refundBookingVoucherCredit(db, input) {
  if (!['booking', 'complex_event_booking'].includes(input.source)) {
    throw new VoucherCreditError('An explicit booking source is required');
  }
  return rpc(db, 'voucher_credit_refund_booking', {
    p_tenant_id: input.tenantId, p_booking_id: input.bookingId,
    p_source: input.source, p_refund_allocation: input.refundAllocation || {},
    p_reversal_options: input.reversalOptions || {},
  });
}
