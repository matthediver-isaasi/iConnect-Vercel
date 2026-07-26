// GoCardless Phase 2 — member-facing Direct Debit checkout endpoint.
//
//   POST { action: 'start', memberId }  -> begin monthly-DD payment for the
//     current membership year. Creates (idempotently) the billing agreement
//     with the immutable terms snapshot, the pending membership-history row,
//     and either:
//       - a GoCardless hosted Billing Request Flow (new mandate), returning
//         { authorisationUrl }, or
//       - if the member already has an active mandate (renewal), reuses it:
//         creates the subscription immediately and returns { reusedMandate: true }.
//
//   GET ?memberId=... -> current DD status for the member's latest agreement.
//
// Approval gating: when membership_require_approval is on and fees are not
// approved, the start action is refused BEFORE any agreement is created.

import { supabase } from '../_lib/database.js';
import { resolveTenantFromRequest } from '../_lib/tenantResolver.js';
import { simulateMembershipForMember } from '../_lib/membershipSimulation.js';
import { gocardlessForTenant, buildIdempotencyKey } from '../_lib/gocardless.js';
import { getGocardlessCredentials } from '../_lib/gocardlessCredentials.js';
import {
  resolveDdOffer,
  buildAgreementSnapshot,
  findReusableMandate,
  ensureSubscriptionForAgreement,
  activateMembershipForAgreement,
} from '../_lib/gocardlessDirectDebit.js';
import { sendDdLifecycleEmail } from '../_lib/gocardlessDdEmails.js';
import { markRenewalConfirmed } from '../_lib/gocardlessDdRenewals.js';
import { STATUS } from '../_lib/gocardlessState.js';
import { authorizeMemberAccess } from './payment-plan.js';

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
    console.error('[DirectDebit] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

async function loadMember(memberId, resolvedTenantId, res, req) {
  // Only the member themself (by session) or a tenant admin may start or
  // view a Direct Debit plan for this memberId.
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
    res.status(400).json({ error: 'Direct Debit is only available for individual memberships' });
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

async function handleGet(req, res, resolvedTenantId) {
  const { memberId } = req.query;
  if (!memberId) return res.status(400).json({ error: 'memberId is required' });
  const member = await loadMember(memberId, resolvedTenantId, res, req);
  if (!member) return;

  const { data: agreements, error } = await supabase
    .from('membership_billing_agreements')
    .select('id, status, gocardless_mandate_id, metadata, created_at')
    .eq('tenant_id', member.tenant_id)
    .eq('member_id', member.id)
    .order('created_at', { ascending: false })
    .limit(1);
  if (error) return res.status(500).json({ error: 'Failed to load agreement' });
  const agreement = agreements?.[0] || null;
  if (!agreement) return res.json({ agreement: null });
  return res.json({
    agreement: {
      id: agreement.id,
      status: agreement.status,
      hasMandate: !!agreement.gocardless_mandate_id,
      terms: agreement.metadata?.dd || null,
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

  const creds = await getGocardlessCredentials(tenantId);
  if (!creds?.accessToken) {
    return res.status(400).json({ error: 'Direct Debit is not available for this organisation' });
  }

  const simResult = await simulateMembershipForMember(tenantId, member.id, { source: 'direct-debit', mode: 'manual' });
  if (!simResult.success) {
    return res.status(400).json({ error: simResult.error || 'Could not calculate membership fees' });
  }
  const offer = resolveDdOffer(simResult);
  if (!offer) {
    return res.status(400).json({ error: 'Monthly Direct Debit is not available for this membership' });
  }

  const yearLabel = simResult.membershipYear?.label;

  // Approval gate — enforced BEFORE the agreement is created.
  const approval = await checkApproval(tenantId, member.id, yearLabel);
  if (approval.blocked) {
    return res.status(403).json({ error: 'Your membership fees are awaiting approval. Please try again once they have been approved.' });
  }

  // Already paid / already in progress for this year?
  const { data: existingHistory } = await supabase
    .from('member_membership_history')
    .select('id, status, payment_status, payment_method, billing_agreement_id')
    .eq('tenant_id', tenantId)
    .eq('member_id', member.id)
    .eq('membership_year', yearLabel)
    .maybeSingle();
  if (existingHistory && existingHistory.payment_method !== 'direct_debit') {
    return res.status(400).json({ error: 'Membership for this year is already recorded with another payment method' });
  }

  const idempotencyKey = buildIdempotencyKey('dd-agree', tenantId, member.id, yearLabel);

  // Idempotent re-entry: reuse the in-flight agreement + its hosted flow URL.
  const { data: existingAgreement } = await supabase
    .from('membership_billing_agreements')
    .select('*')
    .eq('idempotency_key', idempotencyKey)
    .maybeSingle();
  if (existingAgreement) {
    if (existingAgreement.status === STATUS.PAYMENT_SETUP_REQUIRED && existingAgreement.redirect_url) {
      return res.json({ authorisationUrl: existingAgreement.redirect_url, agreementId: existingAgreement.id, resumed: true });
    }
    return res.json({ agreementId: existingAgreement.id, status: existingAgreement.status, resumed: true });
  }

  const snapshot = buildAgreementSnapshot({ offer, simResult });
  const client = await gocardlessForTenant(tenantId);

  // Renewal path: reuse an existing active mandate — no hosted flow needed.
  const reusable = await findReusableMandate({ tenantId, memberId: member.id });

  let agreementInsert = {
    tenant_id: tenantId,
    member_id: member.id,
    agreement_type: 'member',
    status: STATUS.PAYMENT_SETUP_REQUIRED,
    idempotency_key: idempotencyKey,
    environment: creds.environment || 'sandbox',
    metadata: { dd: snapshot },
  };

  let authorisationUrl = null;
  if (reusable) {
    agreementInsert.gocardless_mandate_id = reusable.mandateId;
    agreementInsert.gocardless_customer_id = reusable.customerId;
    agreementInsert.status = STATUS.MANDATE_PENDING;
  } else {
    const billingRequest = await client.createBillingRequest({
      idempotencyKey: buildIdempotencyKey('dd-br', tenantId, member.id, yearLabel),
      currency: offer.currency,
      metadata: { tenant_id: tenantId, member_id: member.id, membership_year: yearLabel, kind: 'monthly_direct_debit' },
    });
    // Send the payer back to the tenant's own site (the request origin),
    // not the platform-level GOCARDLESS_REDIRECT_BASE_URL default.
    const proto = req.headers['x-forwarded-proto'] || 'https';
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const origin = host ? `${proto}://${host}` : null;
    const flow = await client.createBillingRequestFlow({
      billingRequestId: billingRequest.id,
      redirectUri: origin ? `${origin}/membership/direct-debit/complete?member_id=${member.id}` : undefined,
      exitUri: origin ? `${origin}/membership/direct-debit/cancelled?member_id=${member.id}` : undefined,
      idempotencyKey: buildIdempotencyKey('dd-brf', tenantId, member.id, yearLabel),
      prefilledCustomer: {
        email: member.email || undefined,
        given_name: member.first_name || undefined,
        family_name: member.last_name || undefined,
      },
    });
    agreementInsert.gocardless_billing_request_id = billingRequest.id;
    agreementInsert.gocardless_billing_request_flow_id = flow.id;
    agreementInsert.redirect_url = flow.authorisation_url;
    authorisationUrl = flow.authorisation_url;
  }

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
      if (raced?.redirect_url) return res.json({ authorisationUrl: raced.redirect_url, agreementId: raced.id, resumed: true });
      if (raced) return res.json({ agreementId: raced.id, status: raced.status, resumed: true });
    }
    console.error('[DirectDebit] Failed to create agreement:', agreeErr);
    return res.status(500).json({ error: 'Failed to start Direct Debit set-up' });
  }

  // Pending membership-history row linked to the agreement. The webhook
  // (or the reuse path below) flips it per the tier's activation rule.
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
      billing_period: 'monthly_direct_debit',
      vat_rate_percent: simResult.vatRatePercent || null,
      vat_amount: simResult.vatAmount || 0,
      total_with_vat: snapshot.plan_total,
      payment_method: 'direct_debit',
      status: 'pending_payment_setup',
      payment_status: 'unpaid',
      billing_agreement_id: agreement.id,
      notes: `Monthly Direct Debit: ${offer.instalmentCount} x ${offer.currency} ${offer.monthlyAmount}`,
    });
    if (histErr) {
      console.error('[DirectDebit] Failed to create membership history row:', histErr);
      return res.status(500).json({ error: 'Failed to record membership' });
    }
  } else if (!existingHistory.billing_agreement_id) {
    const { error: linkErr } = await supabase
      .from('member_membership_history')
      .update({ billing_agreement_id: agreement.id })
      .eq('id', existingHistory.id);
    if (linkErr) console.error('[DirectDebit] Failed to link history row:', linkErr);
  }

  await sendDdLifecycleEmail('setup_started', agreement, { db: supabase });

  // Phase 5: if a confirmation-required renewal notice is pending for this
  // year, this start IS the member's confirmation. Best-effort, never throws.
  await markRenewalConfirmed({ tenantId, memberId: member.id, yearLabel, newAgreementId: agreement.id });

  if (reusable) {
    // Mandate is already active: create the subscription now and apply the
    // activation rule immediately (same code path the webhook uses).
    const subResult = await ensureSubscriptionForAgreement(agreement, {});
    const actResult = await activateMembershipForAgreement(agreement, { trigger: 'mandate_active' });
    await sendDdLifecycleEmail('mandate_active', agreement, {
      db: supabase,
      extraContext: { firstChargeDate: subResult.plan?.next_charge_date || subResult.plan?.start_date || null },
    });
    return res.json({
      agreementId: agreement.id,
      reusedMandate: true,
      subscriptionCreated: subResult.created,
      activation: actResult.detail,
    });
  }

  return res.json({ authorisationUrl, agreementId: agreement.id });
}
