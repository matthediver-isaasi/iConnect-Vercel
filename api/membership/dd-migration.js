// GoCardless Phase 5 — member-facing migration invite endpoint.
//
// Existing members (paying by Stripe / invoice) are invited by an admin to
// switch to monthly Direct Debit from a specified membership year
// (switch_from_year). The token IS the authorisation — the link is secure,
// expiring and single-use, mirroring the Phase 3 billing-contact flow.
//
//   GET  ?token=...             -> invite preview (offer terms, switch year)
//   POST { token, action: 'accept' }  -> start mandate set-up
//        - active mandate exists: subscription created immediately (reuse)
//        - otherwise: GoCardless hosted flow ({ authorisationUrl })
//   POST { token, action: 'decline' } -> mark invite declined
//
// The member's CURRENT membership year/payment method is never touched:
// the agreement + history row are created for switch_from_year only.

import { supabase } from '../_lib/database.js';
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
import {
  validateMigrationInvite,
  MIGRATION_INVITE_INVALID_MESSAGES,
} from '../_lib/gocardlessDdMigration.js';
import { STATUS } from '../_lib/gocardlessState.js';

export default async function handler(req, res) {
  if (!supabase) return res.status(503).json({ error: 'Database not configured' });
  try {
    if (req.method === 'GET') return handleGet(req, res);
    if (req.method === 'POST') return handlePost(req, res);
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    console.error('[DdMigration] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

async function loadInvite(token) {
  if (!token || typeof token !== 'string') return null;
  const { data } = await supabase
    .from('membership_dd_migration_invites')
    .select('*')
    .eq('token', token)
    .maybeSingle();
  return data || null;
}

async function loadOfferForInvite(invite) {
  const simResult = await simulateMembershipForMember(invite.tenant_id, invite.member_id, {
    source: 'dd-migration',
    mode: 'manual',
    targetYear: invite.switch_from_year,
  });
  if (!simResult?.success) return { simResult, offer: null };
  if (simResult.config?.dd_migration_enabled !== true) return { simResult, offer: null };
  return { simResult, offer: resolveDdOffer(simResult) };
}

async function handleGet(req, res) {
  const invite = await loadInvite(req.query.token);
  const check = validateMigrationInvite(invite);
  if (!check.valid) {
    return res.status(invite ? 410 : 404).json({
      error: MIGRATION_INVITE_INVALID_MESSAGES[check.reason] || 'Invitation not valid',
      reason: check.reason,
    });
  }

  const { data: member } = await supabase
    .from('member')
    .select('id, first_name, last_name, email')
    .eq('id', invite.member_id)
    .maybeSingle();

  const { simResult, offer } = await loadOfferForInvite(invite);
  if (!offer) {
    return res.status(400).json({ error: 'Monthly Direct Debit is no longer available for this membership. Please contact the organisation.' });
  }

  return res.json({
    invite: {
      switchFromYear: invite.switch_from_year,
      expiresAt: invite.expires_at,
      status: invite.status,
    },
    memberName: member ? `${member.first_name || ''} ${member.last_name || ''}`.trim() : null,
    offer: {
      monthlyAmount: offer.monthlyAmount,
      instalmentCount: offer.instalmentCount,
      planTotal: offer.planTotal,
      currency: offer.currency,
      tierLabel: simResult.tierLabel || null,
    },
  });
}

async function handlePost(req, res) {
  const { token, action } = req.body || {};
  if (!['accept', 'decline'].includes(action)) return res.status(400).json({ error: 'Unknown action' });

  const invite = await loadInvite(token);
  const check = validateMigrationInvite(invite);
  if (!check.valid) {
    return res.status(invite ? 410 : 404).json({
      error: MIGRATION_INVITE_INVALID_MESSAGES[check.reason] || 'Invitation not valid',
      reason: check.reason,
    });
  }

  if (action === 'decline') {
    const { error } = await supabase
      .from('membership_dd_migration_invites')
      .update({ status: 'declined', declined_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('id', invite.id)
      .eq('status', 'invited');
    if (error) return res.status(500).json({ error: 'Failed to record your response' });
    return res.json({ declined: true });
  }

  // --- accept ---------------------------------------------------------
  const tenantId = invite.tenant_id;
  const creds = await getGocardlessCredentials(tenantId);
  if (!creds?.accessToken) {
    return res.status(400).json({ error: 'Direct Debit is not available for this organisation' });
  }

  const { data: member } = await supabase
    .from('member')
    .select('id, first_name, last_name, email')
    .eq('id', invite.member_id)
    .eq('tenant_id', tenantId)
    .maybeSingle();
  if (!member) return res.status(404).json({ error: 'Member not found' });

  const { simResult, offer } = await loadOfferForInvite(invite);
  if (!offer) {
    return res.status(400).json({ error: 'Monthly Direct Debit is no longer available for this membership. Please contact the organisation.' });
  }
  const yearLabel = simResult.membershipYear?.label || invite.switch_from_year;

  // The switch year must not already be paid via another method.
  const { data: existingHistory } = await supabase
    .from('member_membership_history')
    .select('id, payment_method, billing_agreement_id')
    .eq('tenant_id', tenantId)
    .eq('member_id', member.id)
    .eq('membership_year', yearLabel)
    .maybeSingle();
  if (existingHistory && existingHistory.payment_method !== 'direct_debit') {
    return res.status(400).json({ error: `Your ${yearLabel} membership is already recorded with another payment method.` });
  }

  const idempotencyKey = buildIdempotencyKey('dd-agree', tenantId, member.id, yearLabel);
  const { data: existingAgreement } = await supabase
    .from('membership_billing_agreements')
    .select('*')
    .eq('idempotency_key', idempotencyKey)
    .maybeSingle();
  if (existingAgreement) {
    if (existingAgreement.status === STATUS.PAYMENT_SETUP_REQUIRED && existingAgreement.redirect_url) {
      return res.json({ authorisationUrl: existingAgreement.redirect_url, flowId: existingAgreement.gocardless_billing_request_flow_id || null, environment: existingAgreement.environment || 'sandbox', agreementId: existingAgreement.id, resumed: true });
    }
    return res.json({ agreementId: existingAgreement.id, status: existingAgreement.status, resumed: true });
  }

  const snapshot = buildAgreementSnapshot({ offer, simResult });
  const client = await gocardlessForTenant(tenantId);
  const reusable = await findReusableMandate({ tenantId, memberId: member.id });

  const agreementInsert = {
    tenant_id: tenantId,
    member_id: member.id,
    agreement_type: 'member',
    status: STATUS.PAYMENT_SETUP_REQUIRED,
    idempotency_key: idempotencyKey,
    environment: creds.environment || 'sandbox',
    metadata: { dd: { ...snapshot, migration_invite_id: invite.id } },
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
      if (raced?.redirect_url) return res.json({ authorisationUrl: raced.redirect_url, flowId: raced.gocardless_billing_request_flow_id || null, environment: raced.environment || 'sandbox', agreementId: raced.id, resumed: true });
      if (raced) return res.json({ agreementId: raced.id, status: raced.status, resumed: true });
    }
    console.error('[DdMigration] Failed to create agreement:', agreeErr);
    return res.status(500).json({ error: 'Failed to start Direct Debit set-up' });
  }

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
      notes: `Migration to monthly Direct Debit: ${offer.instalmentCount} x ${offer.currency} ${offer.monthlyAmount}`,
    });
    if (histErr) console.error('[DdMigration] Failed to create membership history row:', histErr);
  } else if (!existingHistory.billing_agreement_id) {
    await supabase
      .from('member_membership_history')
      .update({ billing_agreement_id: agreement.id })
      .eq('id', existingHistory.id);
  }

  // Single-use: mark the invite accepted + linked to the agreement.
  const { error: linkErr } = await supabase
    .from('membership_dd_migration_invites')
    .update({
      status: 'accepted',
      accepted_at: new Date().toISOString(),
      billing_agreement_id: agreement.id,
      updated_at: new Date().toISOString(),
    })
    .eq('id', invite.id)
    .eq('status', 'invited');
  if (linkErr) console.error('[DdMigration] Failed to mark invite accepted:', linkErr);

  await sendDdLifecycleEmail('setup_started', agreement, { db: supabase });

  if (reusable) {
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

  return res.json({ authorisationUrl, flowId: agreement.gocardless_billing_request_flow_id || null, environment: agreement.environment || 'sandbox', agreementId: agreement.id });
}
