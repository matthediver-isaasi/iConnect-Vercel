import { createHash } from 'node:crypto';
import { assertVoucherEligible } from './voucherCreditService.js';
import { orderVoucherIdsForRedemption } from './voucherOrdering.js';
import { normalizeVoucherSettings, voucherDisplayName } from '../../shared/voucherPolicy.js';
import { monthlyVoucherCreditLimit } from './membershipVoucherMonthly.js';
import { invoiceReferenceFromRow } from './feeTokenInvoiceReference.js';
import { variableMembershipCreditSchedule } from './membershipVariableVoucherAllocation.js';

const SETTINGS = ['individual_vouchers_enabled', 'organization_voucher_display_name', 'member_voucher_display_name'];

export function membershipAmountMinor(value) {
  if (value == null || value === '' || !Number.isFinite(Number(value)) || Number(value) < 0) {
    throw new Error('Membership amount is unavailable');
  }
  const minor = Math.round(Number(value) * 100);
  if (!Number.isSafeInteger(minor)) throw new Error('Membership amount is out of range');
  return minor;
}

/** Finite purchased-term funding, never a change to a recurring unit price.
 * Each instalment retains its gross liability and explicit funding allocation.
 * Cash is balanced first so rounding cannot manufacture a sub-minimum payment.
 */
export function allocateMembershipTerm(grossMinor, creditMinor, count = 1, minimumMinor = 0) {
  if (![grossMinor, creditMinor, count, minimumMinor].every(Number.isSafeInteger)
      || grossMinor < 0 || creditMinor < 0 || creditMinor > grossMinor
      || count < 1 || count > 120 || minimumMinor < 0) {
    throw new Error('Invalid finite membership allocation');
  }
  const cashMinor = grossMinor - creditMinor;
  const split = total => Array.from({ length: count }, (_, i) =>
    Math.floor(total / count) + (i < total % count ? 1 : 0));
  const gross = split(grossMinor);
  const cash = split(cashMinor);
  const instalments = gross.map((amount, i) => ({
    sequence: i + 1, grossMinor: amount, creditMinor: amount - cash[i], cashMinor: cash[i],
  }));
  const belowMinimum = instalments.some(row => row.cashMinor > 0 && row.cashMinor < minimumMinor);
  return {
    grossMinor, creditMinor, cashMinor, instalments, belowMinimum,
    providerRequired: cashMinor > 0,
    // Callers must offer a different credit allocation or upfront settlement;
    // silently increasing the payable total is never permitted.
    paymentPath: cashMinor === 0 ? 'credit_only' : belowMinimum ? 'adjust_credit_or_pay_upfront' : 'provider',
  };
}

export function membershipVoucherBasis(token, monthlySnapshot = null) {
  const variable = monthlySnapshot?.collection_policy?.pricing_policy === 'dynamic';
  const grossMinor = variable ? null : membershipAmountMinor(token.cost_breakdown?.totalWithVat ?? token.final_cost);
  const basis = {
    tenantId: token.tenant_id, tokenId: token.id, memberId: token.member_id || null,
    organizationId: token.organization_id || null, historyId: token.history_record_id || null,
    currency: (token.currency || 'GBP').toUpperCase(), grossMinor,
    membershipYear: token.membership_year, breakdown: token.cost_breakdown || {},
    ...(variable ? { variableTerms: monthlySnapshot } : {}),
  };
  return { ...basis, fingerprint: createHash('sha256').update(JSON.stringify(basis)).digest('hex') };
}

export async function resolveMembershipVoucherAuthority(db, token, req, deps = {}) {
  const context = await (deps.getTenantContext || (await import('./tenantContext.js')).getTenantContext)(req);
  if (!context?.isAuthenticated || context.tenantId !== token.tenant_id || !context.memberId) return null;
  const { data: actor, error } = await db.from('member').select('id,tenant_id,organization_id,role_id')
    .eq('id', context.memberId).eq('tenant_id', token.tenant_id).maybeSingle();
  if (error) throw new Error('Could not verify authenticated credit authority');
  if (!actor?.organization_id) return null;
  let purchaseOrganizationId = token.organization_id;
  if (token.member_id) {
    const { data: owner, error: ownerError } = await db.from('member').select('organization_id')
      .eq('id', token.member_id).eq('tenant_id', token.tenant_id).maybeSingle();
    if (ownerError) throw new Error('Could not verify membership purchaser organisation');
    purchaseOrganizationId = owner?.organization_id;
  }
  if (!purchaseOrganizationId || purchaseOrganizationId !== actor.organization_id) return null;
  const { data: organization, error: orgError } = await db.from('organization').select('id,tenant_id,voucher_allowed_role_ids')
    .eq('id', purchaseOrganizationId).eq('tenant_id', token.tenant_id).maybeSingle();
  if (orgError) throw new Error('Could not verify organisation credit permissions');
  if (!organization) return null;
  return { authenticatedMemberId: actor.id, organization, roleId: actor.role_id };
}

export async function discoverMembershipVouchers(db, token, now = new Date(), authority = null) {
  const { data: rows, error } = await db.from('system_settings')
    .select('setting_key, setting_value').eq('tenant_id', token.tenant_id).in('setting_key', SETTINGS);
  if (error) throw new Error('Could not verify membership credit settings');
  const settings = normalizeVoucherSettings(rows);
  const personalEnabled = settings.individual_vouchers_enabled && !!token.member_id && !token.organization_id;
  // The authenticated authority is resolved afresh by the server for each
  // discovery, quote and commitment. A bearer token never supplies this.
  const organizationEnabled = !!authority?.authenticatedMemberId && authority.organization?.tenant_id === token.tenant_id;
  if (!personalEnabled && !organizationEnabled) {
    return { enabled: false, vouchers: [], settings };
  }
  const candidates = [];
  if (personalEnabled) {
    const { data, error: voucherError } = await db.from('voucher').select('*')
      .eq('tenant_id', token.tenant_id).eq('member_id', token.member_id).is('organization_id', null)
      .eq('status', 'active').gt('value', 0)
      .or(`expires_at.gt.${now.toISOString()},and(expires_at.is.null,funding_source.eq.membership_change)`);
    if (voucherError) throw new Error('Could not load personal membership credit');
    candidates.push(...(data || []));
  }
  if (organizationEnabled) {
    const { data, error: voucherError } = await db.from('voucher').select('*')
      .eq('tenant_id', token.tenant_id).eq('organization_id', authority.organization.id).is('member_id', null)
      .eq('status', 'active').gt('value', 0).gt('expires_at', now.toISOString());
    if (voucherError) throw new Error('Could not load permitted organisation credit');
    candidates.push(...(data || []));
  }
  const context = { tenantId: token.tenant_id, memberId: token.member_id,allowMembershipChangeCredit:true,
    allowOrganization: organizationEnabled, isAuthenticated: organizationEnabled,
    organizationId: authority?.organization?.id, organization: authority?.organization,
    roleId: authority?.roleId, settings, currency: token.currency || 'GBP', now };
  const vouchers = candidates.filter(voucher => {
    try { assertVoucherEligible(voucher, context); return true; } catch { return false; }
  });
  return { enabled: true, settings, authenticatedMemberId: authority?.authenticatedMemberId || null,
    vouchers: vouchers.map(voucher => ({
    id: voucher.id, code: voucher.code, member_id: voucher.member_id,
    organization_id: voucher.organization_id, tenant_id: token.tenant_id,
    ownerType: voucher.member_id ? 'member' : 'organization',
    displayName: voucherDisplayName(settings, voucher.member_id ? 'member' : 'organization'),
    value: voucher.value, expires_at: voucher.expires_at, issued_at: voucher.issued_at,
  })) };
}

export function buildMembershipVoucherQuote(token, discovery, ids, now = new Date(), monthlySnapshot = null) {
  if (!discovery.enabled || (!!token.member_id === !!token.organization_id)) {
    throw new Error('Credit is not enabled for this membership purchase');
  }
  if (!Array.isArray(ids) || ids.length > 100 || ids.some(id => typeof id !== 'string')
      || new Set(ids).size !== ids.length) throw new Error('Select distinct eligible credit IDs');
  if (token.status !== 'pending' || token.stripe_payment_intent_id || token.stripe_payment_attempted_at) {
    throw new Error('Credit cannot be changed after payment setup has started');
  }
  const variable = monthlySnapshot?.collection_policy?.pricing_policy === 'dynamic';
  if (variable && (monthlySnapshot.payment_mode !== 'direct_debit'
      || monthlySnapshot.invoicing_mode !== 'per_instalment'
      || !monthlySnapshot.commitment?.term_key || !token.member_id || token.organization_id)) {
    throw new Error('Variable credit requires an individual Direct Debit term with per-instalment invoicing');
  }
  const basis = membershipVoucherBasis(token, monthlySnapshot);
  const byId = Object.fromEntries(discovery.vouchers.map(voucher => [voucher.id, voucher]));
  if (ids.some(id => !byId[id])) throw new Error('Selected credit is unavailable for this member');
  if (ids.some(id => {
    const voucher = byId[id];
    return voucher.ownerType === 'organization'
      ? !discovery.authenticatedMemberId
      : !token.member_id || !!token.organization_id;
  })) throw new Error('Selected credit does not have authority for this purchase');
  const availableMinor = ids.reduce((total, id) => total + membershipAmountMinor(byId[id].value), 0);
  const minimumMinor = { GBP: 30, USD: 50, EUR: 50, AUD: 50, NZD: 50 }[basis.currency] || 50;
  let creditCap = variable ? availableMinor : Math.min(basis.grossMinor, availableMinor);
  if (monthlySnapshot && !variable) {
    if (membershipAmountMinor(monthlySnapshot.plan_total) !== basis.grossMinor) {
      throw new Error('The selected monthly offer requires a new fixed-term fee quote before credit can be applied');
    }
    creditCap = monthlyVoucherCreditLimit({ grossMinor: basis.grossMinor, availableMinor,
      count: monthlySnapshot.instalment_count,
      minimumMinor: monthlySnapshot.payment_mode === 'direct_debit' ? 100 : minimumMinor });
  }
  // A tiny cash balance is not chargeable. Leave a little credit unused
  // rather than silently increasing the fee or making the purchase impossible.
  if (!monthlySnapshot && basis.grossMinor > creditCap && basis.grossMinor - creditCap < minimumMinor) {
    creditCap = Math.max(0, basis.grossMinor - minimumMinor);
  }
  let remainingCredit = creditCap;
  const allocations = orderVoucherIdsForRedemption(ids, byId, false).orderedIds.map(id => {
    const voucher = byId[id];
    const amountMinor = Math.min(remainingCredit, membershipAmountMinor(voucher.value));
    remainingCredit -= amountMinor;
    return { voucherId: id, ownerType: voucher.ownerType || 'member',
      memberId: voucher.member_id || (voucher.ownerType !== 'organization' ? token.member_id : null),
      organizationId: voucher.organization_id || null,
      displayName: voucher.displayName, amountMinor };
  }).filter(row => row.amountMinor > 0);
  const remaining = basis.grossMinor - creditCap + remainingCredit;
  return {
    version: 1, tokenId: token.id, fingerprint: basis.fingerprint, currency: basis.currency,
    tokenUpdatedAt: token.updated_at || null,
    authenticatedMemberId: allocations.some(row => row.ownerType === 'organization') ? discovery.authenticatedMemberId : null,
    paymentMode: monthlySnapshot?.payment_mode || 'stripe_upfront',
    monthlySnapshot,
    grossMinor: basis.grossMinor, creditMinor: variable ? creditCap : basis.grossMinor - remaining,
    cashMinor: variable ? null : remaining,
    ...(variable ? { variableCredit: true, creditSchedule: variableMembershipCreditSchedule({
      creditMinor: creditCap, instalmentCount: monthlySnapshot.instalment_count,
    }) } : {}),
    allocations, quotedAt: now.toISOString(),
    expiresAt: new Date(Math.min(now.getTime() + 15 * 60 * 1000, Date.parse(token.expires_at))).toISOString(),
    // Preview itself never reserves funds; acceptance uses a separate RPC.
    settlementEnabled: true,
  };
}

export async function persistMembershipVoucherQuote(db, token, ids, now = new Date(), authority = null, monthlySnapshot = null) {
  if (monthlySnapshot && token.history_record_id) {
    const history = await db.from(token.organization_id ? 'organization_membership_history' : 'member_membership_history')
      .select('*').eq('id',token.history_record_id).eq('tenant_id',token.tenant_id)
      .eq(token.organization_id ? 'organization_id' : 'member_id',token.organization_id || token.member_id).maybeSingle();
    if (history.error || !history.data) throw new Error('Original membership invoice history is unavailable');
    if (invoiceReferenceFromRow(history.data)) monthlySnapshot = { ...monthlySnapshot,invoicing_mode:'annual' };
  }
  const discovery = await discoverMembershipVouchers(db, token, now, authority);
  const quote = buildMembershipVoucherQuote(token, discovery, ids, now, monthlySnapshot);
  const { data, error } = await db.from('membership_voucher_quote').insert({
    tenant_id: token.tenant_id, fee_token_id: token.id, member_id: token.member_id || null,
    organization_id: token.organization_id || null, authenticated_member_id: quote.authenticatedMemberId,
    fingerprint: quote.fingerprint, quote, expires_at: quote.expiresAt,
  }).select('id').single();
  if (error || !data?.id) throw new Error('Could not save the credit quote; membership voucher quote migration may be required');
  return { ...quote, id: data.id };
}
