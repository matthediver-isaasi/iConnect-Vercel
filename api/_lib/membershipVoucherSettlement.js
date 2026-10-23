import { membershipVoucherBasis } from './membershipVoucherQuote.js';
import { simulationFromMemberStart } from './memberStartPayment.js';
import { simulationFromFeeCommitment, feeTokenCommitment } from './rollingFeeCommitment.js';
import { createHash } from 'node:crypto';

export async function createGuardedPortalMembershipIntent(db, stripe, owner, payload) {
  const sourceKey = owner.sourceKey || `portal:${owner.memberId ? 'member' : 'organization'}:${owner.memberId || owner.organizationId}:${owner.membershipYear}`;
  if (owner.token) await claimMembershipFeePayment(db, owner.token, 'create_payment');
  const guard = await claimMembershipTermPayment(db, { ...owner, sourceKey, rail: 'create_payment' });
  let previous = null;
  if (guard.installed) {
    const started = await db.rpc('membership_payment_start_provider', {
      p_tenant_id: owner.tenantId, p_source_key: sourceKey,
      p_basis: { amount: payload.amount, currency: payload.currency, metadata: payload.metadata },
    });
    if (started.error) throw new Error(started.error.message);
    previous = started.data?.provider_payment_id;
  }
  const intent = previous ? await stripe.paymentIntents.retrieve(previous)
    : await stripe.paymentIntents.create(payload, { idempotencyKey: owner.providerIdempotencyKey || `membership-portal:${createHash('sha256').update(sourceKey).digest('hex')}` });
  if (intent.amount !== payload.amount || intent.currency !== payload.currency || intent.status === 'canceled') {
    throw new Error('Original membership payment requires reconciliation before another attempt');
  }
  if (guard.installed && !previous) {
    const saved = await db.from('membership_payment_term_claim').update({ provider_payment_id: intent.id })
      .eq('tenant_id', owner.tenantId).eq('source_key', sourceKey).is('provider_payment_id', null);
    if (saved.error) throw new Error('Payment created; its identity requires reconciliation before retry');
  }
  return intent;
}

export async function claimMembershipTermPayment(db, { tenantId, memberId = null, organizationId = null, membershipYear, sourceKey, rail }) {
  const { error } = await db.rpc('membership_payment_term_guard', {
    p_tenant_id: tenantId, p_member_id: memberId, p_organization_id: organizationId,
    p_year: membershipYear, p_source_key: sourceKey, p_rail: rail,
  });
  // Before rollout there can be no voucher settlements. After migration every
  // entry point shares this same term lock; a real conflict is never ignored.
  if (error && ['42883', 'PGRST202'].includes(error.code)) return { installed: false };
  if (error) throw new Error(error.message);
  return { installed: true };
}

export async function claimMembershipFeePayment(db, token, rail) {
  const { error } = await db.rpc('membership_fee_checkout_guard', {
    p_tenant_id: token.tenant_id, p_token_id: token.id, p_rail: rail,
  });
  if (error && ['42883', 'PGRST202'].includes(error.code)) return { installed: false };
  if (error) throw new Error(error.message);
  return { installed: true };
}

export async function loadMembershipVoucherSettlement(db, token) {
  const { data, error } = await db.from('membership_voucher_settlement').select('*')
    .eq('tenant_id', token.tenant_id).eq('fee_token_id', token.id).neq('state', 'released').maybeSingle();
  // Old tenants without the additive migration retain the original payment path.
  if (error && !['42P01', 'PGRST205'].includes(error.code)) throw new Error(error.message);
  return data || null;
}

async function historySnapshot(db, token, deps) {
  const memberPurchase = !!token.member_id;
  const table = memberPurchase ? 'member_membership_history' : 'organisation_membership_history';
  const ownerColumn = memberPurchase ? 'member_id' : 'organization_id';
  const ownerId = token.member_id || token.organization_id;
  if (token.history_record_id) {
    const { data, error } = await db.from(table).select('*')
      .eq('tenant_id', token.tenant_id).eq(ownerColumn, ownerId)
      .eq('id', token.history_record_id).single();
    if (error || !data) throw new Error('Membership history unavailable');
    if (['paid', 'unverified', 'voided'].includes(data.payment_status)) throw new Error('Membership requires financial review');
    let config = null, band = null;
    if (data.config_id) {
      const loaded = await db.from('membership_tier_config').select('*').eq('id', data.config_id).eq('tenant_id', token.tenant_id).maybeSingle();
      if (loaded.error) throw new Error('Could not freeze membership accounting configuration');
      config = loaded.data;
    }
    if (data.band_id) {
      const loaded = await db.from('membership_tier_band').select('*').eq('id', data.band_id).eq('tenant_id', token.tenant_id).maybeSingle();
      if (loaded.error) throw new Error('Could not freeze membership accounting tax mapping');
      band = loaded.data;
    }
    return { ...data, __accounting: {
      vatRate: token.cost_breakdown?.taxType || band?.vat_rate || config?.flat_vat_rate || null,
      nominalCode: band?.nominal_code || config?.nominal_code || null,
    } };
  }
  const renewal = token.cost_breakdown?.renewalQuote;
  const savedRenewal = renewal ? { ...token.cost_breakdown, success: true,
    config: renewal.config, incentiveConfig: renewal.incentiveConfig, membershipYear: renewal.membershipYear,
    currency: token.currency, finalCost: Number(token.final_cost),
    totalWithVat: token.cost_breakdown.totalWithVat ?? Number(token.final_cost),
    billingPeriod: renewal.config?.billing_period || 'annual' } : null;
  const regenerated = token.cost_breakdown?.membershipVoucherRequote?.simulation;
  if (!memberPurchase && !savedRenewal && !simulationFromFeeCommitment(token) && !regenerated) {
    throw new Error('Original organisation membership terms are unavailable; request a new saved fee quote.');
  }
  const sim = regenerated || simulationFromMemberStart(token) || simulationFromFeeCommitment(token) || savedRenewal
    || (deps.simulate ? await deps.simulate(token) : await (await import('./membershipSimulation.js'))
      .simulateMembershipForMember(token.tenant_id, token.member_id, {
        source: 'voucher-payment', mode: 'manual', targetYear: token.membership_year,
      }));
  if (!sim?.success || sim.membershipYear?.label !== token.membership_year) throw new Error('Membership terms require review');
  const cb = token.cost_breakdown || {};
  const { membershipIncentiveSnapshot } = await import('./membershipIncentiveSnapshot.js');
  return {
    ...membershipIncentiveSnapshot(sim), ...(feeTokenCommitment(token) || {}),
    tenant_id: token.tenant_id, [ownerColumn]: ownerId, membership_year: token.membership_year,
    config_id: sim.config?.id || null, band_id: sim.matchedBand?.id || null,
    tier_label: token.tier_label, annual_cost: sim.annualCost, prorata_cost: sim.prorataCost,
    free_period_discount: sim.freeDiscount || 0, rollover_discount: sim.rolloverDiscount || 0,
    custom_discount_total: sim.customDiscountTotal || 0, final_cost: Number(token.final_cost),
    currency: token.currency || 'GBP', billing_period: sim.billingPeriod || 'annual',
    vat_rate_percent: cb.vatRatePercent ?? sim.vatRatePercent ?? null,
    vat_amount: cb.vatAmount ?? sim.vatAmount ?? 0,
    total_with_vat: cb.totalWithVat ?? Number(token.final_cost),
    payment_status: 'unpaid', status: 'active',
    ...(renewal ? { term_start_date: renewal.membershipYear.start.slice(0, 10),
      term_end_date: renewal.membershipYear.end.slice(0, 10), annual_renewal_state: 'renewed' } : {}),
    notes: 'Membership funded by voucher credit; cash and voucher funding recorded separately.',
    __accounting: { vatRate: sim.taxType || sim.matchedBand?.vat_rate || sim.config?.flat_vat_rate || null,
      nominalCode: sim.matchedBand?.nominal_code || sim.config?.nominal_code || null },
  };
}

export async function reserveMembershipVoucherSettlement(db, token, quoteId, deps = {}) {
  if (!!token.member_id === !!token.organization_id) throw new Error('Membership token owner required');
  const existing = await loadMembershipVoucherSettlement(db, token);
  if (existing) {
    if (existing.quote_id !== quoteId || existing.state === 'released') throw new Error('A different credit commitment exists');
    return existing;
  }
  const quoteResult = await db.from('membership_voucher_quote').select('quote')
    .eq('id', quoteId).eq('tenant_id', token.tenant_id).eq('fee_token_id', token.id).single();
  if (quoteResult.error || !quoteResult.data) throw new Error('Saved membership credit quote is unavailable');
  const variable = quoteResult.data.quote.variableCredit === true;
  const basis = membershipVoucherBasis(token, variable ? quoteResult.data.quote.monthlySnapshot : null);
  const snapshot = await historySnapshot(db, token, deps);
  const { invoiceReferenceFromRow } = await import('./feeTokenInvoiceReference.js');
  const reference = invoiceReferenceFromRow(snapshot) || invoiceReferenceFromRow(token);
  if (variable && reference) throw new Error('An existing annual invoice requires reconciliation before variable monthly credit');
  if (reference) {
    const provider = deps.accountingProvider || (await import('./accountingProvider.js')).getAccountingProviderByName(reference.provider);
    const invoice = await provider.fetchInvoiceStatus(reference.invoiceId, token.tenant_id);
    if (!invoice || invoice.voided || Math.round(Number(invoice.balance) * 100) !== basis.grossMinor) {
      throw new Error('Existing invoice balance has changed. Ask the administrator for a refreshed membership fee quote before applying credit.');
    }
  }
  const { data, error } = await db.rpc(variable ? 'membership_variable_voucher_reserve' : 'membership_voucher_reserve', {
    p_tenant_id: token.tenant_id, p_token_id: token.id, p_quote_id: quoteId,
    p_fingerprint: basis.fingerprint, p_history_snapshot: snapshot,
    p_authenticated_member_id: deps.authority?.authenticatedMemberId || null,
  });
  if (error) throw new Error(error.message);
  const facade = deps.facade || await import('./accountingProvider.js');
  const accountingProvider = reference?.provider || await facade.getActiveAccountingProvider(token.tenant_id);
  if (['xero', 'quickbooks'].includes(accountingProvider)) {
    await (await import('./membershipVoucherAccountingBinding.js')).pinMembershipAccountingBinding(db, data, accountingProvider, deps);
  }
  return data;
}

export function assertMembershipVoucherPayment(token, settlement, pi) {
  const funding = settlement.funding;
  if (settlement.state === 'released' || !pi?.id || pi.status !== 'succeeded'
      || pi.id !== settlement.provider_payment_id
      || pi.amount !== funding.remainingMinor
      || pi.currency?.toUpperCase() !== funding.currency
      || pi.metadata?.tenant_id !== token.tenant_id
      || pi.metadata?.token_id !== token.id
      || (token.member_id ? pi.metadata?.member_id !== token.member_id || !!pi.metadata?.organization_id
        : pi.metadata?.organization_id !== token.organization_id || !!pi.metadata?.member_id)
      || pi.metadata?.membership_year !== token.membership_year
      || pi.metadata?.membership_voucher_settlement_id !== settlement.id) {
    throw new Error('Captured cash does not match the membership credit commitment; do not pay again');
  }
}

export async function startMembershipVoucherPayment(db, token, settlement, deps = {}) {
  if (settlement.state === 'released') throw new Error('Credit commitment was released');
  if (settlement.funding.remainingMinor === 0) {
    return completeMembershipVoucherSettlement(db, token, settlement, null, deps);
  }
  const { remainingMinor: amount, currency } = settlement.funding;
  const minimum = { GBP: 30, USD: 50, EUR: 50, AUD: 50, NZD: 50 }[currency] || 50;
  if (amount < minimum) throw new Error('Remaining cash is below the card minimum. Cancel this unstarted credit reservation and select less credit, or use enough credit to cover the full amount.');
  const getStripe = deps.getStripe || (async () => {
    const { getStripeCredentials } = await import('./stripeCredentials.js');
    const credentials = await getStripeCredentials(token.tenant_id, 'membership');
    if (!credentials?.is_enabled || !credentials.secret_key) throw new Error('Membership card payments are unavailable');
    const Stripe = (await import('stripe')).default;
    return new Stripe(credentials.secret_key);
  });
  const stripeResult = await getStripe();
  const stripe = stripeResult.stripe || stripeResult;
  if (settlement.provider_payment_id) {
    const pi = await stripe.paymentIntents.retrieve(settlement.provider_payment_id);
    if (pi.status === 'succeeded') return completeMembershipVoucherSettlement(db, token, settlement, pi, deps);
    if (pi.status === 'canceled' || pi.amount !== amount || pi.metadata?.membership_voucher_settlement_id !== settlement.id) {
      throw new Error('Saved payment requires reconciliation; no second payment was created');
    }
    return { clientSecret: pi.client_secret, paymentIntentId: pi.id, funding: settlement.funding };
  }
  // Persist before the network call. A timeout keeps the reservation; never
  // release an uncertain provider outcome. Stripe retries use the same key.
  if (settlement.provider_attempted_at && Date.now() - Date.parse(settlement.provider_attempted_at) > 23 * 60 * 60 * 1000) {
    throw new Error('Previous payment outcome needs reconciliation; no second payment was created');
  }
  const { data: attempt, error: attemptError } = await db.from('membership_voucher_settlement')
    .update({ state: 'provider_pending', provider_attempted_at: settlement.provider_attempted_at || new Date().toISOString() })
    .eq('id', settlement.id).eq('state', 'reserved').select('id').maybeSingle();
  if (attemptError) throw new Error('Could not persist payment attempt');
  if (!attempt) {
    const current = await loadMembershipVoucherSettlement(db, token);
    if (current?.id !== settlement.id || current.state !== 'provider_pending') throw new Error('Membership payment commitment changed');
  }
  const pi = await stripe.paymentIntents.create({
    amount, currency: currency.toLowerCase(), receipt_email: token.recipient_email || undefined,
    metadata: { tenant_id: token.tenant_id, token_id: token.id,
      ...(token.member_id ? { member_id: token.member_id } : { organization_id: token.organization_id }),
      membership_year: token.membership_year, membership_voucher_settlement_id: settlement.id },
    description: `Membership cash balance — ${token.membership_year}`,
  }, { idempotencyKey: `membership-credit:${settlement.id}` });
  const { error: linkError } = await db.from('membership_voucher_settlement')
    .update({ provider_payment_id: pi.id }).eq('id', settlement.id).eq('state', 'provider_pending');
  if (linkError) throw new Error('Payment created but awaiting reconciliation; retry this purchase, not another payment');
  const { error: tokenError } = await db.from('membership_fee_token')
    .update({ stripe_payment_intent_id: pi.id, stripe_client_secret: pi.client_secret })
    .eq('id', token.id).eq('tenant_id', token.tenant_id);
  if (tokenError) throw new Error('Payment token link needs reconciliation; retry this purchase');
  return { clientSecret: pi.client_secret, paymentIntentId: pi.id, funding: settlement.funding };
}

export async function completeMembershipVoucherSettlement(db, token, settlement, pi, deps = {}) {
  if (pi && !settlement.provider_payment_id && settlement.state === 'provider_pending') {
    // Webhook may beat the create-payment response to persistence.
    assertMembershipVoucherPayment(token, { ...settlement, provider_payment_id: pi.id }, pi);
    const { error: linkError } = await db.from('membership_voucher_settlement')
      .update({ provider_payment_id: pi.id }).eq('id', settlement.id).is('provider_payment_id', null);
    if (linkError) throw new Error('Could not reconcile membership payment identity');
    settlement = await loadMembershipVoucherSettlement(db, token);
  }
  if (settlement.funding.remainingMinor > 0) assertMembershipVoucherPayment(token, settlement, pi);
  else if (pi) throw new Error('Fully funded membership must not have a provider payment');
  const { data, error } = await db.rpc('membership_voucher_complete', {
    p_tenant_id: token.tenant_id, p_token_id: token.id, p_payment_id: pi?.id || null,
    p_cash_minor: settlement.funding.remainingMinor, p_currency: settlement.funding.currency,
  });
  if (error) throw new Error(error.message);
  let accountingError = null;
  try {
    const account = deps.account || (await import('./membershipVoucherAccounting.js')).accountMembershipVoucherSettlement;
    await account(db, token, data, pi);
  } catch (error) {
    accountingError = error.message;
    const { error: persistError } = await db.from('membership_voucher_settlement')
      .update({ accounting_status: 'failed', accounting_error: accountingError }).eq('id', data.id);
    if (persistError) accountingError += '; could not persist accounting retry state';
  }
  let workflowWarning = null;
  try {
    const fire = deps.firePaidWorkflow || (await import('./zeroDueMembership.js')).fireNewZeroDueMembershipPaidWorkflow;
    await fire({ table: token.member_id ? 'member_membership_history' : 'organisation_membership_history', row: { id: data.history_record_id },
      client: db, source: 'membership_voucher_funding' });
  } catch (error) {
    workflowWarning = `Membership is funded; paid-workflow delivery needs retry: ${error.message}`;
  }
  return { success: true, recordCreated: true, settlementId: data.id, funding: data.funding,
    accountingSyncError: accountingError,
    warning: accountingError ? 'Membership is funded; invoice accounting needs reconciliation. Do not pay again.' : workflowWarning };
}

export async function releaseMembershipVoucherSettlement(db, token, settlement, stripe) {
  if (!settlement) return { released: true };
  if (settlement.state === 'committed') throw new Error('Funded membership cannot release its credit');
  let outcome = 'not_started';
  if (settlement.provider_attempted_at) {
    if (!settlement.provider_payment_id || !stripe) throw new Error('Payment outcome is uncertain; credit remains reserved pending reconciliation');
    let pi = await stripe.paymentIntents.retrieve(settlement.provider_payment_id);
    if (pi.status === 'succeeded' || pi.status === 'processing') throw new Error('Payment is successful or processing; do not release credit');
    if (pi.status !== 'canceled') pi = await stripe.paymentIntents.cancel(pi.id);
    if (pi.status !== 'canceled') throw new Error('Provider did not confirm cancellation; credit remains reserved');
    outcome = 'cancelled';
  }
  const { data, error } = await db.rpc('membership_voucher_release', {
    p_tenant_id: token.tenant_id, p_token_id: token.id,
    p_payment_id: settlement.provider_payment_id, p_outcome: outcome,
  });
  if (error) throw new Error(error.message);
  return data;
}
