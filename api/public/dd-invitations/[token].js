// GoCardless Phase 3 — public billing-contact Direct Debit set-up link.
//
//   GET  /api/public/dd-invitations/:token
//     Validates the token and returns the plan summary the billing contact
//     must review: organisation, membership category, monthly amount,
//     instalments, total, expiry. Never leaks anything on invalid tokens.
//
//   POST /api/public/dd-invitations/:token  { action: 'accept', confirmAuthority: true }
//     Requires the explicit authority confirmation, then (idempotently)
//     creates the GoCardless billing request + hosted flow for the agreement
//     and returns { authorisationUrl }. The token stays usable until the
//     mandate flow completes (webhook marks the invitation 'completed').
//
// No session required — the token IS the credential.

import { supabase } from '../../_lib/database.js';
import { gocardlessForTenant, buildIdempotencyKey } from '../../_lib/gocardless.js';
import { getGocardlessCredentials } from '../../_lib/gocardlessCredentials.js';
import { STATUS } from '../../_lib/gocardlessState.js';
import { validateInvitation, INVITE_INVALID_MESSAGES } from '../../_lib/gocardlessDdInvitations.js';
import {
  buildMonthlyBillingRequest,
  monthlyBillingRequestFingerprint,
  publicDdConsentTerms,
  classifyMonthlyConsentAgreement,
  monthlyConsentReplacementKey,
  rotateStaleMonthlyConsentAgreement,
  attachMonthlyConsentFlow,
} from '../../_lib/gocardlessDirectDebit.js';

export default async function handler(req, res) {
  if (!supabase) return res.status(503).json({ error: 'Database not configured' });
  const token = String(req.query.token || '').trim();
  if (!token || !/^[a-f0-9]{64}$/i.test(token)) {
    return res.status(404).json({ error: INVITE_INVALID_MESSAGES.not_found });
  }
  try {
    const { data: invitation } = await supabase
      .from('membership_dd_invitations')
      .select('*')
      .eq('token', token)
      .maybeSingle();

    const check = validateInvitation(invitation);
    if (!check.valid) {
      const status = check.reason === 'not_found' ? 404 : 410;
      return res.status(status).json({ error: INVITE_INVALID_MESSAGES[check.reason] || INVITE_INVALID_MESSAGES.not_found, reason: check.reason });
    }

    const { data: loadedAgreement } = await supabase
      .from('membership_billing_agreements')
      .select('*')
      .eq('id', invitation.billing_agreement_id)
      .maybeSingle();
    let agreement = loadedAgreement;
    if (!agreement || agreement.tenant_id !== invitation.tenant_id) {
      return res.status(404).json({ error: INVITE_INVALID_MESSAGES.not_found });
    }
    if (agreement.gocardless_mandate_id || agreement.status !== STATUS.PAYMENT_SETUP_REQUIRED) {
      return res.status(410).json({ error: INVITE_INVALID_MESSAGES.completed, reason: 'completed' });
    }

    if (req.method === 'GET') return handleGet(res, invitation, agreement);
    if (req.method === 'POST') return handlePost(req, res, invitation, agreement);
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    console.error('[DD Invitation] Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

function summarise(invitation, agreement, orgName) {
  const snap = agreement.metadata?.dd || {};
  return {
    organizationName: orgName || snap.organization_name || 'the organisation',
    membershipYear: snap.membership_year || null,
    tierLabel: snap.tier_label || null,
    ...publicDdConsentTerms({
      monthlyAmount: snap.monthly_amount,
      instalmentCount: snap.instalment_count,
      planTotal: snap.plan_total,
      currency: snap.currency,
      firstCollectionRule: snap.first_collection_rule,
      collectionDay: snap.collection_day,
    }),
    invitedName: invitation.invited_name || null,
    expiresAt: invitation.expires_at,
  };
}

async function orgNameFor(agreement) {
  const { data: org } = await supabase
    .from('organization')
    .select('name')
    .eq('id', agreement.organization_id)
    .maybeSingle();
  return org?.name || null;
}

async function handleGet(res, invitation, agreement) {
  const orgName = await orgNameFor(agreement);
  return res.json({ invitation: summarise(invitation, agreement, orgName) });
}

async function handlePost(req, res, invitation, agreement) {
  const { action, confirmAuthority } = req.body || {};
  if (action !== 'accept') return res.status(400).json({ error: 'Unknown action' });
  if (confirmAuthority !== true) {
    return res.status(400).json({ error: 'You must confirm you are authorised to set up Direct Debits on this account' });
  }

  const tenantId = agreement.tenant_id;
  const creds = await getGocardlessCredentials(tenantId);
  if (!creds?.accessToken) {
    return res.status(400).json({ error: 'Direct Debit is not available right now. Please contact the organisation.' });
  }
  const client = await gocardlessForTenant(tenantId);

  let consent = classifyMonthlyConsentAgreement(agreement);
  if (consent.rotatable) {
    const replacementKey = monthlyConsentReplacementKey(
      agreement.idempotency_key || buildIdempotencyKey('dd-inv-agreement', agreement.id),
    );
    const oldSnapshot = agreement.metadata?.dd || {};
    const replacementSnapshot = {
      ...oldSnapshot,
      billing_request_mode: 'mandate_only',
    };
    delete replacementSnapshot.billing_request_payment;
    agreement = await rotateStaleMonthlyConsentAgreement({
      db: supabase,
      agreement,
      replacementIdempotencyKey: replacementKey,
      snapshot: replacementSnapshot,
      gc: client,
    });
    consent = classifyMonthlyConsentAgreement(agreement);
  }

  // Idempotent re-entry is allowed only for a coherent mandate-only flow.
  if (consent.resumable) {
    return res.json({ authorisationUrl: agreement.redirect_url, flowId: agreement.gocardless_billing_request_flow_id || null, environment: agreement.environment || 'sandbox', resumed: true });
  }
  if (consent.kind !== 'current_unstarted') {
    return res.status(409).json({ error: 'This Direct Debit set-up cannot be safely resumed. Please request a new invitation.' });
  }

  const snap = agreement.metadata?.dd || {};
  const metadata = {
    tenant_id: tenantId,
    organization_id: agreement.organization_id,
    membership_year: snap.membership_year || '',
    kind: 'monthly_direct_debit',
  };
  const billingRequest = await client.createBillingRequest({
    idempotencyKey: buildIdempotencyKey(
      'dd-br-inv',
      tenantId,
      agreement.id,
      agreement.idempotency_key,
      monthlyBillingRequestFingerprint(snap),
    ),
    ...buildMonthlyBillingRequest({ snapshot: snap, metadata }),
  });

  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const origin = host ? `${proto}://${host}` : null;
  const nameParts = (invitation.invited_name || '').trim().split(/\s+/).filter(Boolean);
  const flow = await client.createBillingRequestFlow({
    billingRequestId: billingRequest.id,
    redirectUri: origin ? `${origin}/dd-setup/${invitation.token}?flow=complete` : undefined,
    exitUri: origin ? `${origin}/dd-setup/${invitation.token}?flow=cancelled` : undefined,
    idempotencyKey: buildIdempotencyKey('dd-brf-inv', tenantId, agreement.id, agreement.idempotency_key),
    prefilledCustomer: {
      email: invitation.invited_email || undefined,
      given_name: nameParts[0] || undefined,
      family_name: nameParts.slice(1).join(' ') || undefined,
      company_name: snap.organization_name || undefined,
    },
  });

  agreement = await attachMonthlyConsentFlow({
    db: supabase,
    agreement,
    billingRequest,
    flow,
    extraUpdate: { mandate_completed_by: invitation.invited_email },
  });

  // Record first acceptance time (best-effort).
  if (!invitation.accepted_at) {
    await supabase
      .from('membership_dd_invitations')
      .update({ accepted_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('id', invitation.id)
      .is('accepted_at', null);
  }

  return res.json({ authorisationUrl: agreement.redirect_url, flowId: agreement.gocardless_billing_request_flow_id || null, environment: creds.environment || 'sandbox' });
}
