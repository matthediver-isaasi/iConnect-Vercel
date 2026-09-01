// Task #3620 — member-facing monthly card (Stripe subscription) checkout.
//
//   POST { action: 'start', memberId } -> begin monthly-card payment for the
//     current membership year. Creates (idempotently) the billing agreement
//     with the immutable terms snapshot, the pending membership-history row,
//     creates/reuses the Stripe Customer and starts a subscription-mode
//     Checkout Session (fixed number of monthly instalments), returning
//     { checkoutUrl }.
//
//   GET ?memberId=... -> latest card agreement status for the member.
//
// Mirrors api/membership/direct-debit.js: same auth (self-or-admin), same
// approval gate BEFORE any agreement exists, same idempotent re-entry, and
// a mutual-exclusion guard so a member can never pay the same year by card
// plan AND Direct Debit.

import { supabase } from '../_lib/database.js';
import { resolveTenantFromRequest } from '../_lib/tenantResolver.js';
import { simulateMembershipForMember } from '../_lib/membershipSimulation.js';
import { getStripeCredentials, findOrCreateStripeCustomer } from '../_lib/stripeCredentials.js';
import { resolveCardMonthlyOffer, buildCardAgreementSnapshot, CARD_PLAN_KIND } from '../_lib/stripeMonthlyCard.js';
import { STATUS } from '../_lib/gocardlessState.js';
import { authorizeMemberAccess } from './payment-plan.js';

const OPEN_AGREEMENT_STATUSES = [
  STATUS.PAYMENT_SETUP_REQUIRED,
  STATUS.MANDATE_PENDING,
  STATUS.FIRST_PAYMENT_PENDING,
  STATUS.ACTIVE,
  STATUS.PAYMENT_GRACE_PERIOD,
  STATUS.PAYMENT_OVERDUE,
];

export default async function handler(req, res) {
  if (!supabase) return res.status(503).json({ error: 'Database not configured' });
  try {
    let resolvedTenantId = null;
    try {
      const tenantData = await resolveTenantFromRequest(req);
      resolvedTenantId = tenantData?.id || null;
    } catch { /* fall back to member tenant below */ }

    if (req.method === 'GET') return handleGet(req, res, resolvedTenantId);
    if (req.method === 'POST') return handlePost(req, res, resolvedTenantId);
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    console.error('[MonthlyCard] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

async function loadMember(memberId, resolvedTenantId, res, req) {
  const auth = await authorizeMemberAccess(req, memberId);
  if (!auth.ok) {
    res.status(403).json({ error: 'Not authorized for this member' });
    return null;
  }
  const { data: member } = await supabase
    .from('member')
    .select('id, organization_id, tenant_id, email, first_name, last_name')
    .eq('id', memberId)
    .maybeSingle();
  if (!member?.tenant_id) {
    res.status(404).json({ error: 'Member not found' });
    return null;
  }
  if (resolvedTenantId && member.tenant_id !== resolvedTenantId) {
    res.status(403).json({ error: 'Member does not belong to this tenant' });
    return null;
  }
  if (member.organization_id) {
    res.status(400).json({ error: 'Monthly card payment is only available for individual memberships' });
    return null;
  }
  return member;
}

async function checkApproval(tenantId, memberId, membershipYearLabel) {
  try {
    const { data: setting } = await supabase
      .from('system_settings')
      .select('setting_value')
      .eq('setting_key', 'membership_require_approval')
      .eq('tenant_id', tenantId)
      .maybeSingle();
    if (setting?.setting_value !== 'true') return { blocked: false };

    const { data: invoicing } = await supabase
      .from('member_membership_invoicing')
      .select('fees_approved')
      .eq('tenant_id', tenantId)
      .eq('member_id', memberId)
      .eq('membership_year', membershipYearLabel)
      .maybeSingle();
    if (invoicing?.fees_approved) return { blocked: false };
    return { blocked: true };
  } catch {
    return { blocked: false };
  }
}

/**
 * Mutual-exclusion guard: any open agreement of the OTHER provider for the
 * same membership year blocks a new one (double-payment protection both
 * ways). Exported for reuse by the DD start path.
 */
export async function findOpenAgreementForYear({ tenantId, memberId, yearLabel, db = supabase }) {
  const { data, error } = await db
    .from('membership_billing_agreements')
    .select('id, status, provider, metadata')
    .eq('tenant_id', tenantId)
    .eq('member_id', memberId)
    .in('status', OPEN_AGREEMENT_STATUSES)
    .order('created_at', { ascending: false })
    .limit(20);
  if (error) {
    console.error('[MonthlyCard] open-agreement lookup failed:', error.message);
    return null;
  }
  return (data || []).find((a) => {
    const snap = a.metadata?.card || a.metadata?.dd;
    return (snap?.membership_year || null) === yearLabel;
  }) || null;
}

/**
 * Annual one-off payment guard: blocked when ANY open monthly-plan agreement
 * (card or Direct Debit) exists for the same membership year. Used by every
 * annual PaymentIntent creation path (public fee token + form field).
 */
export async function annualPaymentBlockedByOpenPlan({ tenantId, memberId, yearLabel, db = supabase }) {
  const open = await findOpenAgreementForYear({ tenantId, memberId, yearLabel, db });
  if (!open) return null;
  return { provider: open.provider || 'gocardless', status: open.status, agreementId: open.id };
}

async function handleGet(req, res, resolvedTenantId) {
  const { memberId } = req.query;
  if (!memberId) return res.status(400).json({ error: 'memberId is required' });
  const member = await loadMember(memberId, resolvedTenantId, res, req);
  if (!member) return;

  const { data: agreements, error } = await supabase
    .from('membership_billing_agreements')
    .select('id, status, provider, stripe_subscription_id, metadata, created_at')
    .eq('tenant_id', member.tenant_id)
    .eq('member_id', member.id)
    .eq('provider', 'stripe')
    .order('created_at', { ascending: false })
    .limit(1);
  if (error) return res.status(500).json({ error: 'Failed to load agreement' });
  const agreement = agreements?.[0] || null;
  if (!agreement) return res.json({ agreement: null });
  return res.json({
    agreement: {
      id: agreement.id,
      status: agreement.status,
      provider: 'stripe',
      hasSubscription: !!agreement.stripe_subscription_id,
      terms: agreement.metadata?.card || null,
    },
  });
}

async function handlePost(req, res, resolvedTenantId) {
  const { action, memberId } = req.body || {};
  if (action !== 'start') return res.status(400).json({ error: 'Unknown action' });
  if (!memberId) return res.status(400).json({ error: 'memberId is required' });

  const member = await loadMember(memberId, resolvedTenantId, res, req);
  if (!member) return;
  const tenantId = member.tenant_id;

  const stripeCredentials = await getStripeCredentials(tenantId, 'membership');
  if (!stripeCredentials?.secret_key) {
    return res.status(400).json({ error: 'Card payment is not available for this organisation' });
  }

  const simResult = await simulateMembershipForMember(tenantId, member.id, { source: 'monthly-card', mode: 'manual' });
  if (!simResult.success) {
    return res.status(400).json({ error: simResult.error || 'Could not calculate membership fees' });
  }
  const offer = resolveCardMonthlyOffer(simResult);
  if (!offer) {
    return res.status(400).json({ error: 'Monthly card payment is not available for this membership' });
  }

  const yearLabel = simResult.membershipYear?.label;

  // Approval gate — enforced BEFORE the agreement is created.
  const approval = await checkApproval(tenantId, member.id, yearLabel);
  if (approval.blocked) {
    return res.status(403).json({ error: 'Your membership fees are awaiting approval. Please try again once they have been approved.' });
  }

  // Already paid / already recorded with another method for this year?
  const { data: existingHistory } = await supabase
    .from('member_membership_history')
    .select('id, status, payment_status, payment_method, billing_agreement_id, stripe_payment_intent_id')
    .eq('tenant_id', tenantId)
    .eq('member_id', member.id)
    .eq('membership_year', yearLabel)
    .maybeSingle();
  if (existingHistory && existingHistory.payment_method !== 'card_monthly') {
    return res.status(400).json({ error: 'Membership for this year is already recorded with another payment method' });
  }
  if (existingHistory && (existingHistory.payment_status === 'paid' || existingHistory.stripe_payment_intent_id)) {
    return res.status(400).json({ error: 'Membership for this year has already been paid' });
  }

  // Double-payment guard: an open Direct Debit agreement for the same year
  // blocks starting a card plan (the reverse guard lives in the DD start).
  const openOther = await findOpenAgreementForYear({ tenantId, memberId: member.id, yearLabel });
  if (openOther && openOther.provider !== 'stripe') {
    return res.status(400).json({ error: 'A monthly Direct Debit plan is already set up for this membership year' });
  }

  const idempotencyKey = `card-agree:${tenantId}:${member.id}:${yearLabel}`;

  // Idempotent re-entry: reuse the in-flight agreement + its Checkout URL.
  const { data: existingAgreement } = await supabase
    .from('membership_billing_agreements')
    .select('*')
    .eq('idempotency_key', idempotencyKey)
    .maybeSingle();
  if (existingAgreement) {
    if (existingAgreement.status === STATUS.PAYMENT_SETUP_REQUIRED && existingAgreement.redirect_url) {
      return res.json({ checkoutUrl: existingAgreement.redirect_url, agreementId: existingAgreement.id, resumed: true });
    }
    return res.json({ agreementId: existingAgreement.id, status: existingAgreement.status, resumed: true });
  }

  const snapshot = buildCardAgreementSnapshot({ offer, simResult });
  const Stripe = (await import('stripe')).default;
  const stripe = new Stripe(stripeCredentials.secret_key);
  const environment = stripeCredentials.secret_key.startsWith('sk_test_') ? 'test' : 'live';

  const customer = await findOrCreateStripeCustomer(stripe, {
    email: member.email,
    name: [member.first_name, member.last_name].filter(Boolean).join(' ') || undefined,
    metadata: { tenant_id: tenantId, member_id: member.id },
  });
  if (!customer?.id) {
    return res.status(502).json({
      error: 'Could not prepare a secure Stripe customer for this membership checkout.',
    });
  }

  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const origin = host ? `${proto}://${host}` : '';

  const currency = (offer.currency || 'GBP').toLowerCase();
  let session;
  try {
    session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customer.id,
      billing_address_collection: 'required',
      customer_update: { address: 'auto' },
      line_items: [{
        quantity: 1,
        price_data: {
          currency,
          unit_amount: offer.monthlyAmountMinor,
          recurring: { interval: 'month' },
          product_data: {
            name: `Membership ${yearLabel || ''}`.trim(),
            description: `${offer.instalmentCount} monthly instalments of ${offer.currency} ${offer.monthlyAmount.toFixed(2)} (total ${offer.currency} ${offer.planTotal.toFixed(2)})`,
          },
        },
      }],
      metadata: {
        kind: CARD_PLAN_KIND,
        tenant_id: tenantId,
        member_id: member.id,
        membership_year: yearLabel || '',
      },
      subscription_data: {
        // Stripe-side finite-billing boundary: even if our post-completion
        // cancel call fails, Stripe stops the subscription itself before an
        // (instalmentCount+1)-th invoice could be raised. First invoice is at
        // checkout, the Nth at start + (N-1) months; cancel_at sits 15 days
        // after that and safely before start + N months.
        cancel_at: (() => {
          const d = new Date();
          d.setUTCMonth(d.getUTCMonth() + (offer.instalmentCount - 1));
          d.setUTCDate(d.getUTCDate() + 15);
          return Math.floor(d.getTime() / 1000);
        })(),
        metadata: {
          kind: CARD_PLAN_KIND,
          tenant_id: tenantId,
          member_id: member.id,
          membership_year: yearLabel || '',
        },
      },
      success_url: `${origin}/membership/monthly-card/complete?member_id=${member.id}&card=success`,
      cancel_url: `${origin}/membership/monthly-card/cancelled?member_id=${member.id}&card=cancelled`,
    });
  } catch (err) {
    console.error('[MonthlyCard] Checkout session creation failed:', err.message);
    return res.status(502).json({ error: 'Could not start card checkout. Please try again.' });
  }

  const agreementInsert = {
    tenant_id: tenantId,
    member_id: member.id,
    agreement_type: 'member',
    provider: 'stripe',
    stripe_customer_id: customer?.id || null,
    stripe_checkout_session_id: session.id,
    status: STATUS.PAYMENT_SETUP_REQUIRED,
    idempotency_key: idempotencyKey,
    redirect_url: session.url,
    environment,
    metadata: { card: snapshot },
  };

  const { data: agreement, error: agreeErr } = await supabase
    .from('membership_billing_agreements')
    .insert(agreementInsert)
    .select()
    .single();
  if (agreeErr) {
    if (agreeErr.code === '23505') {
      const { data: raced } = await supabase
        .from('membership_billing_agreements')
        .select('*')
        .eq('idempotency_key', idempotencyKey)
        .maybeSingle();
      if (raced?.redirect_url) return res.json({ checkoutUrl: raced.redirect_url, agreementId: raced.id, resumed: true });
      if (raced) return res.json({ agreementId: raced.id, status: raced.status, resumed: true });
    }
    console.error('[MonthlyCard] Failed to create agreement:', agreeErr);
    // Best-effort: expire the orphaned checkout session.
    try { await stripe.checkout.sessions.expire(session.id); } catch {}
    return res.status(500).json({ error: 'Failed to start card plan set-up' });
  }

  // Pending membership-history row linked to the agreement (webhook flips it).
  if (!existingHistory) {
    const { error: histErr } = await supabase.from('member_membership_history').insert({
      tenant_id: tenantId,
      member_id: member.id,
      membership_year: yearLabel,
      config_id: simResult.config?.id || null,
      band_id: simResult.matchedBand?.id || null,
      tier_label: simResult.tierLabel,
      field_value: simResult.fieldValue,
      annual_cost: simResult.annualCost,
      final_cost: snapshot.plan_total,
      currency: offer.currency,
      billing_period: 'monthly_card',
      vat_rate_percent: simResult.vatRatePercent || null,
      vat_amount: simResult.vatAmount || 0,
      total_with_vat: snapshot.plan_total,
      payment_method: 'card_monthly',
      status: 'pending_payment_setup',
      payment_status: 'unpaid',
      billing_agreement_id: agreement.id,
      notes: `Monthly card plan: ${offer.instalmentCount} x ${offer.currency} ${offer.monthlyAmount}`,
    });
    if (histErr) {
      console.error('[MonthlyCard] Failed to create membership history row:', histErr);
      return res.status(500).json({ error: 'Failed to record membership' });
    }
  } else if (!existingHistory.billing_agreement_id) {
    const { error: linkErr } = await supabase
      .from('member_membership_history')
      .update({ billing_agreement_id: agreement.id })
      .eq('id', existingHistory.id);
    if (linkErr) console.error('[MonthlyCard] Failed to link history row:', linkErr);
  }

  // Confirm-mode renewal (Task #3621): a member starting a card plan for the
  // renewal year themselves marks any pending 'notice_sent' renewal row
  // confirmed (provider-agnostic; best-effort, mirrors the DD start path).
  try {
    const { markRenewalConfirmed } = await import('../_lib/gocardlessDdRenewals.js');
    await markRenewalConfirmed({ tenantId, memberId: member.id, yearLabel, newAgreementId: agreement.id });
  } catch {}

  return res.json({ checkoutUrl: session.url, agreementId: agreement.id });
}
