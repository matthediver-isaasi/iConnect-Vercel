// GoCardless Phase 3 — organisational membership Direct Debit checkout.
//
//   POST { action: 'start', memberId, payerChoice: 'self'|'billing_contact',
//          billingContactEmail?, billingContactName? }
//     Starts monthly DD for the member's organisation's current membership
//     year. The member must belong to the organisation (session) or be a
//     tenant admin. Two payer routes:
//       - 'self': the primary contact confirms they are authorised on the
//         org's bank account -> GoCardless hosted flow now ({ authorisationUrl }).
//       - 'billing_contact': a secure, expiring, single-use set-up link is
//         emailed to the billing contact ({ invitationSent: true }).
//
//   POST admin actions (tenant admin only): { action: 'resend-payer-link' |
//     'change-payer' | 'revoke-link', agreementId, ... }
//
//   GET ?memberId=... -> current org DD status (latest agreement + live invite).
//
// Approval gating mirrors the member endpoint: when membership_require_approval
// is on and the org's fees are not approved, start is refused before any
// agreement is created.

import { supabase } from '../_lib/database.js';
import { resolveTenantFromRequest } from '../_lib/tenantResolver.js';
import { getTenantContext, hasAdminAccess } from '../_lib/tenantContext.js';
import { getSessionMember } from '../_lib/session.js';
import { simulateMembershipForOrg } from '../_lib/membershipSimulation.js';
import { gocardlessForTenant, buildIdempotencyKey } from '../_lib/gocardless.js';
import { getGocardlessCredentials } from '../_lib/gocardlessCredentials.js';
import {
  resolveDdOffer,
  buildAgreementSnapshot,
  findReusableMandate,
  ensureSubscriptionForAgreement,
  activateMembershipForAgreement,
} from '../_lib/gocardlessDirectDebit.js';
import { sendDdLifecycleEmail, sendDdInvitationEmail } from '../_lib/gocardlessDdEmails.js';
import { STATUS } from '../_lib/gocardlessState.js';
import {
  createInvitation,
  revokeInvitationsForAgreement,
} from '../_lib/gocardlessDdInvitations.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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
    console.error('[OrgDirectDebit] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

// Session self (org member) or tenant admin. Returns { member, org } or null.
async function loadOrgContext(memberId, resolvedTenantId, res, req) {
  let authorized = false;
  try {
    const sessionMember = await getSessionMember(req);
    if (sessionMember?.id && String(sessionMember.id) === String(memberId)) authorized = true;
  } catch { /* fall through */ }
  if (!authorized) {
    try {
      const context = await getTenantContext(req);
      if (context?.tenantId && (await hasAdminAccess(context))) authorized = true;
    } catch { /* not admin */ }
  }
  if (!authorized) {
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
  if (!member.organization_id) {
    res.status(400).json({ error: 'This member is not part of an organisation' });
    return null;
  }
  const { data: org } = await supabase
    .from('organization')
    .select('id, name, tenant_id, invoicing_email')
    .eq('id', member.organization_id)
    .maybeSingle();
  if (!org || org.tenant_id !== member.tenant_id) {
    res.status(404).json({ error: 'Organisation not found' });
    return null;
  }
  return { member, org };
}

async function checkOrgApproval(tenantId, organizationId, membershipYearLabel) {
  try {
    const { data: setting } = await supabase
      .from('system_settings')
      .select('setting_value')
      .eq('setting_key', 'membership_require_approval')
      .eq('tenant_id', tenantId)
      .maybeSingle();
    if (setting?.setting_value !== 'true') return { blocked: false };

    const { data: invoicing } = await supabase
      .from('organisation_membership_invoicing')
      .select('fees_approved')
      .eq('tenant_id', tenantId)
      .eq('organization_id', organizationId)
      .eq('membership_year', membershipYearLabel)
      .maybeSingle();
    if (invoicing?.fees_approved) return { blocked: false };
    return { blocked: true };
  } catch {
    return { blocked: false };
  }
}

function requestOrigin(req) {
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return host ? `${proto}://${host}` : null;
}

async function latestAgreementForOrg(tenantId, organizationId) {
  const { data: agreements, error } = await supabase
    .from('membership_billing_agreements')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('organization_id', organizationId)
    .order('created_at', { ascending: false })
    .limit(1);
  if (error) throw new Error(`load org agreement failed: ${error.message}`);
  return agreements?.[0] || null;
}

async function pendingInvitationForAgreement(agreementId) {
  const { data } = await supabase
    .from('membership_dd_invitations')
    .select('id, status, invited_email, invited_name, expires_at, created_at')
    .eq('billing_agreement_id', agreementId)
    .eq('status', 'pending')
    .order('created_at', { ascending: false })
    .limit(1);
  return data?.[0] || null;
}

async function handleGet(req, res, resolvedTenantId) {
  const { memberId } = req.query;
  if (!memberId) return res.status(400).json({ error: 'memberId is required' });
  const ctx = await loadOrgContext(memberId, resolvedTenantId, res, req);
  if (!ctx) return;
  const { member, org } = ctx;

  const agreement = await latestAgreementForOrg(member.tenant_id, org.id);
  if (!agreement) return res.json({ agreement: null });

  const invitation = agreement.dd_payer === 'billing_contact'
    ? await pendingInvitationForAgreement(agreement.id)
    : null;

  return res.json({
    agreement: {
      id: agreement.id,
      status: agreement.status,
      hasMandate: !!agreement.gocardless_mandate_id,
      ddPayer: agreement.dd_payer || null,
      billingContact: agreement.billing_contact_email ? {
        name: agreement.billing_contact_name || null,
        email: agreement.billing_contact_email,
      } : null,
      mandateCompletedBy: agreement.mandate_completed_by || null,
      terms: agreement.metadata?.dd || null,
    },
    invitation: invitation ? {
      invitedEmail: invitation.invited_email,
      invitedName: invitation.invited_name,
      expiresAt: invitation.expires_at,
    } : null,
  });
}

async function handlePost(req, res, resolvedTenantId) {
  const { action } = req.body || {};
  if (action === 'start') return handleStart(req, res, resolvedTenantId);
  if (action === 'resend-payer-link' || action === 'change-payer' || action === 'revoke-link') {
    return handleAdminAction(req, res, action);
  }
  return res.status(400).json({ error: 'Unknown action' });
}

async function handleStart(req, res, resolvedTenantId) {
  const { memberId, payerChoice, billingContactEmail, billingContactName } = req.body || {};
  if (!memberId) return res.status(400).json({ error: 'memberId is required' });
  if (payerChoice !== 'self' && payerChoice !== 'billing_contact') {
    return res.status(400).json({ error: 'payerChoice must be self or billing_contact' });
  }
  if (payerChoice === 'billing_contact') {
    if (!billingContactEmail || !EMAIL_RE.test(String(billingContactEmail).trim())) {
      return res.status(400).json({ error: 'A valid billing contact email is required' });
    }
  }

  const ctx = await loadOrgContext(memberId, resolvedTenantId, res, req);
  if (!ctx) return;
  const { member, org } = ctx;
  const tenantId = member.tenant_id;

  const creds = await getGocardlessCredentials(tenantId);
  if (!creds?.accessToken) {
    return res.status(400).json({ error: 'Direct Debit is not available for this organisation' });
  }

  const simResult = await simulateMembershipForOrg(tenantId, org.id, { source: 'direct-debit', mode: 'manual' });
  if (!simResult.success) {
    return res.status(400).json({ error: simResult.error || 'Could not calculate membership fees' });
  }
  const offer = resolveDdOffer(simResult);
  if (!offer) {
    return res.status(400).json({ error: 'Monthly Direct Debit is not available for this membership' });
  }

  const yearLabel = simResult.membershipYear?.label;

  // Approval gate — enforced BEFORE the agreement is created.
  const approval = await checkOrgApproval(tenantId, org.id, yearLabel);
  if (approval.blocked) {
    return res.status(403).json({ error: 'Your membership fees are awaiting approval. Please try again once they have been approved.' });
  }

  // Already paid / already in progress for this year?
  const { data: existingHistory } = await supabase
    .from('organisation_membership_history')
    .select('id, status, payment_status, payment_method, billing_agreement_id')
    .eq('tenant_id', tenantId)
    .eq('organization_id', org.id)
    .eq('membership_year', yearLabel)
    .maybeSingle();
  if (existingHistory && existingHistory.payment_method && existingHistory.payment_method !== 'direct_debit') {
    return res.status(400).json({ error: 'Membership for this year is already recorded with another payment method' });
  }

  const idempotencyKey = buildIdempotencyKey('dd-agree-org', tenantId, org.id, yearLabel);

  // Idempotent re-entry: reuse the in-flight agreement.
  const { data: existingAgreement } = await supabase
    .from('membership_billing_agreements')
    .select('*')
    .eq('idempotency_key', idempotencyKey)
    .maybeSingle();
  if (existingAgreement) {
    if (existingAgreement.status === STATUS.PAYMENT_SETUP_REQUIRED) {
      if (existingAgreement.dd_payer === 'billing_contact') {
        const invitation = await pendingInvitationForAgreement(existingAgreement.id);
        return res.json({ agreementId: existingAgreement.id, invitationSent: !!invitation, resumed: true });
      }
      if (existingAgreement.redirect_url) {
        return res.json({ authorisationUrl: existingAgreement.redirect_url, agreementId: existingAgreement.id, resumed: true });
      }
    }
    return res.json({ agreementId: existingAgreement.id, status: existingAgreement.status, resumed: true });
  }

  const snapshot = {
    ...buildAgreementSnapshot({ offer, simResult }),
    organization_name: org.name,
    field_value: simResult.fieldValue ?? null,
  };
  const client = await gocardlessForTenant(tenantId);

  // Renewal path: reuse the org's existing active mandate (self route only —
  // the billing-contact route implies the payer must complete a new flow).
  const reusable = payerChoice === 'self'
    ? await findReusableMandate({ tenantId, organizationId: org.id })
    : null;

  const agreementInsert = {
    tenant_id: tenantId,
    organization_id: org.id,
    agreement_type: 'organization',
    status: STATUS.PAYMENT_SETUP_REQUIRED,
    idempotency_key: idempotencyKey,
    environment: creds.environment || 'sandbox',
    metadata: { dd: snapshot },
    primary_contact_member_id: member.id,
    dd_payer: payerChoice,
    billing_contact_email: payerChoice === 'billing_contact' ? String(billingContactEmail).trim().toLowerCase() : null,
    billing_contact_name: payerChoice === 'billing_contact' ? (billingContactName || '').trim() || null : null,
    mandate_completed_by: payerChoice === 'self' ? member.email || null : null,
  };

  let authorisationUrl = null;
  if (reusable) {
    agreementInsert.gocardless_mandate_id = reusable.mandateId;
    agreementInsert.gocardless_customer_id = reusable.customerId;
    agreementInsert.status = STATUS.MANDATE_PENDING;
  } else if (payerChoice === 'self') {
    const billingRequest = await client.createBillingRequest({
      idempotencyKey: buildIdempotencyKey('dd-br-org', tenantId, org.id, yearLabel),
      currency: offer.currency,
      metadata: { tenant_id: tenantId, organization_id: org.id, membership_year: yearLabel, kind: 'monthly_direct_debit' },
    });
    const origin = requestOrigin(req);
    const flow = await client.createBillingRequestFlow({
      billingRequestId: billingRequest.id,
      redirectUri: origin ? `${origin}/membership/direct-debit/complete?member_id=${member.id}&org=1` : undefined,
      exitUri: origin ? `${origin}/membership/direct-debit/cancelled?member_id=${member.id}&org=1` : undefined,
      idempotencyKey: buildIdempotencyKey('dd-brf-org', tenantId, org.id, yearLabel),
      prefilledCustomer: {
        email: member.email || undefined,
        given_name: member.first_name || undefined,
        family_name: member.last_name || undefined,
        company_name: org.name || undefined,
      },
    });
    agreementInsert.gocardless_billing_request_id = billingRequest.id;
    agreementInsert.gocardless_billing_request_flow_id = flow.id;
    agreementInsert.redirect_url = flow.authorisation_url;
    authorisationUrl = flow.authorisation_url;
  }
  // billing_contact route: the GC billing request + flow are created at
  // link-accept time (so the GC flow can't go stale before the contact acts).

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
    console.error('[OrgDirectDebit] Failed to create agreement:', agreeErr);
    return res.status(500).json({ error: 'Failed to start Direct Debit set-up' });
  }

  // Pending membership-history row linked to the agreement.
  if (!existingHistory) {
    const { error: histErr } = await supabase.from('organisation_membership_history').insert({
      tenant_id: tenantId,
      organization_id: org.id,
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
      console.error('[OrgDirectDebit] Failed to create membership history row:', histErr);
      return res.status(500).json({ error: 'Failed to record membership' });
    }
  } else if (!existingHistory.billing_agreement_id) {
    const { error: linkErr } = await supabase
      .from('organisation_membership_history')
      .update({ billing_agreement_id: agreement.id })
      .eq('id', existingHistory.id);
    if (linkErr) console.error('[OrgDirectDebit] Failed to link history row:', linkErr);
  }

  if (payerChoice === 'billing_contact') {
    const invitation = await createInvitation({
      tenantId,
      organizationId: org.id,
      billingAgreementId: agreement.id,
      invitedEmail: billingContactEmail,
      invitedName: billingContactName || null,
      invitedByMemberId: member.id,
    });
    const origin = requestOrigin(req);
    const emailResult = await sendDdInvitationEmail({
      agreement,
      invitation,
      organizationName: org.name,
      setupUrl: `${origin || ''}/dd-setup/${invitation.token}`,
    });
    return res.json({
      agreementId: agreement.id,
      invitationSent: emailResult.sent,
      invitationExpiresAt: invitation.expires_at,
      ...(emailResult.sent ? {} : { warning: 'Invitation created but the email could not be sent. Use the resend option.' }),
    });
  }

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

  return res.json({ authorisationUrl, agreementId: agreement.id });
}

// Admin-only management of the billing-contact link.
async function handleAdminAction(req, res, action) {
  const context = await getTenantContext(req);
  if (!context?.tenantId || !(await hasAdminAccess(context))) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  const { agreementId, billingContactEmail, billingContactName } = req.body || {};
  if (!agreementId) return res.status(400).json({ error: 'agreementId is required' });

  const { data: agreement } = await supabase
    .from('membership_billing_agreements')
    .select('*')
    .eq('id', agreementId)
    .eq('tenant_id', context.tenantId)
    .maybeSingle();
  if (!agreement || !agreement.organization_id) {
    return res.status(404).json({ error: 'Organisation billing agreement not found' });
  }
  if (agreement.gocardless_mandate_id || agreement.status !== STATUS.PAYMENT_SETUP_REQUIRED) {
    return res.status(400).json({ error: 'The Direct Debit set-up for this agreement is no longer pending' });
  }

  const { data: org } = await supabase
    .from('organization')
    .select('id, name')
    .eq('id', agreement.organization_id)
    .maybeSingle();

  if (action === 'revoke-link') {
    await revokeInvitationsForAgreement(agreement.id);
    return res.json({ revoked: true });
  }

  let targetEmail = agreement.billing_contact_email;
  let targetName = agreement.billing_contact_name;
  if (action === 'change-payer') {
    if (!billingContactEmail || !EMAIL_RE.test(String(billingContactEmail).trim())) {
      return res.status(400).json({ error: 'A valid billing contact email is required' });
    }
    targetEmail = String(billingContactEmail).trim().toLowerCase();
    targetName = (billingContactName || '').trim() || null;
    const { error: upErr } = await supabase
      .from('membership_billing_agreements')
      .update({
        dd_payer: 'billing_contact',
        billing_contact_email: targetEmail,
        billing_contact_name: targetName,
        mandate_completed_by: null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', agreement.id);
    if (upErr) {
      console.error('[OrgDirectDebit] change-payer update failed:', upErr);
      return res.status(500).json({ error: 'Failed to update payer' });
    }
  } else if (action === 'resend-payer-link') {
    if (agreement.dd_payer !== 'billing_contact' || !targetEmail) {
      return res.status(400).json({ error: 'This agreement has no billing contact to resend to' });
    }
  }

  // Fresh single-live link (supersedes any earlier pending invitation).
  const invitation = await createInvitation({
    tenantId: context.tenantId,
    organizationId: agreement.organization_id,
    billingAgreementId: agreement.id,
    invitedEmail: targetEmail,
    invitedName: targetName,
    invitedByMemberId: context.member?.id || null,
  });
  const origin = requestOrigin(req);
  const emailResult = await sendDdInvitationEmail({
    agreement: { ...agreement, billing_contact_email: targetEmail, billing_contact_name: targetName },
    invitation,
    organizationName: org?.name,
    setupUrl: `${origin || ''}/dd-setup/${invitation.token}`,
  });
  return res.json({
    invitationSent: emailResult.sent,
    invitationExpiresAt: invitation.expires_at,
    invitedEmail: targetEmail,
    ...(emailResult.sent ? {} : { warning: 'Invitation created but the email could not be sent.' }),
  });
}
