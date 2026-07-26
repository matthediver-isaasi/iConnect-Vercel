// GoCardless Phase 3 — billing-contact Direct Debit invitations.
//
// An organisation's primary contact may choose to send the mandate set-up
// link to the organisation's billing contact instead of completing it
// themselves. The link carries a crypto-random token that:
//   - expires after an admin-configurable number of days
//     (system_settings key 'dd_invite_expiry_days', default 7, clamp 1-90)
//   - is single-use: once the mandate flow completes, the invitation is
//     marked 'completed' and the token can no longer start a new flow
//   - is revocable / replaceable by tenant admins (resend / change payer)
//
// Pure decision logic (exported for node --test):
//   - generateInviteToken()
//   - computeExpiry(now, days)
//   - validateInvitation(invitation, now)  -> { valid, reason }
//
// Impure orchestration (injectable { db }):
//   - resolveInviteExpiryDays(tenantId)
//   - createInvitation(...)               supersedes prior pending invites
//   - markInvitationCompletedForAgreement(agreementId)

import crypto from 'node:crypto';
import { supabase } from './database.js';

export const DEFAULT_INVITE_EXPIRY_DAYS = 7;
export const MIN_INVITE_EXPIRY_DAYS = 1;
export const MAX_INVITE_EXPIRY_DAYS = 90;

export function generateInviteToken() {
  return crypto.randomBytes(32).toString('hex');
}

export function clampExpiryDays(value) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n) || Number.isNaN(n)) return DEFAULT_INVITE_EXPIRY_DAYS;
  return Math.min(MAX_INVITE_EXPIRY_DAYS, Math.max(MIN_INVITE_EXPIRY_DAYS, n));
}

export function computeExpiry(now = new Date(), days = DEFAULT_INVITE_EXPIRY_DAYS) {
  const base = now instanceof Date ? now : new Date(now);
  return new Date(base.getTime() + clampExpiryDays(days) * 24 * 60 * 60 * 1000);
}

/**
 * Is this invitation usable right now?
 * Returns { valid: boolean, reason?: 'not_found'|'revoked'|'superseded'|'completed'|'expired' }.
 */
export function validateInvitation(invitation, now = new Date()) {
  if (!invitation) return { valid: false, reason: 'not_found' };
  if (invitation.status === 'revoked') return { valid: false, reason: 'revoked' };
  if (invitation.status === 'superseded') return { valid: false, reason: 'superseded' };
  if (invitation.status === 'completed') return { valid: false, reason: 'completed' };
  if (invitation.status !== 'pending') return { valid: false, reason: 'not_found' };
  const exp = invitation.expires_at ? new Date(invitation.expires_at) : null;
  if (!exp || Number.isNaN(exp.getTime()) || exp <= now) {
    return { valid: false, reason: 'expired' };
  }
  return { valid: true };
}

export const INVITE_INVALID_MESSAGES = Object.freeze({
  not_found: 'This payment set-up link is invalid.',
  revoked: 'This payment set-up link has been withdrawn. Please contact the organisation for a new link.',
  superseded: 'A newer payment set-up link has been issued. Please use the most recent email.',
  completed: 'This payment set-up link has already been used.',
  expired: 'This payment set-up link has expired. Please ask for a new link.',
});

export async function resolveInviteExpiryDays(tenantId, { db = supabase } = {}) {
  try {
    const { data } = await db
      .from('system_settings')
      .select('setting_value')
      .eq('setting_key', 'dd_invite_expiry_days')
      .eq('tenant_id', tenantId)
      .maybeSingle();
    if (data?.setting_value != null && String(data.setting_value).trim() !== '') {
      return clampExpiryDays(data.setting_value);
    }
  } catch { /* fall back to default */ }
  return DEFAULT_INVITE_EXPIRY_DAYS;
}

/**
 * Create a fresh pending invitation for a billing agreement, superseding any
 * earlier pending invitations for the same agreement (only one live link at
 * a time). Returns the inserted row (including the raw token for the email).
 */
export async function createInvitation({
  tenantId, organizationId, billingAgreementId,
  invitedEmail, invitedName = null, invitedByMemberId = null,
  expiryDays = null, now = new Date(), db = supabase,
}) {
  if (!tenantId || !organizationId || !billingAgreementId || !invitedEmail) {
    throw new Error('tenantId, organizationId, billingAgreementId and invitedEmail are required');
  }
  const days = expiryDays != null ? clampExpiryDays(expiryDays) : await resolveInviteExpiryDays(tenantId, { db });

  const { error: supErr } = await db
    .from('membership_dd_invitations')
    .update({ status: 'superseded', updated_at: new Date().toISOString() })
    .eq('billing_agreement_id', billingAgreementId)
    .eq('status', 'pending');
  if (supErr) throw new Error(`supersede prior invitations failed: ${supErr.message}`);

  const { data, error } = await db
    .from('membership_dd_invitations')
    .insert({
      tenant_id: tenantId,
      organization_id: organizationId,
      billing_agreement_id: billingAgreementId,
      token: generateInviteToken(),
      status: 'pending',
      invited_email: String(invitedEmail).trim().toLowerCase(),
      invited_name: invitedName || null,
      invited_by_member_id: invitedByMemberId || null,
      expires_at: computeExpiry(now, days).toISOString(),
    })
    .select()
    .single();
  if (error) throw new Error(`create invitation failed: ${error.message}`);
  return data;
}

/**
 * Mark the pending invitation(s) for an agreement completed — called when
 * the GoCardless billing request is fulfilled (mandate created). Makes the
 * token single-use. Best-effort idempotent.
 */
export async function markInvitationCompletedForAgreement(billingAgreementId, { db = supabase } = {}) {
  if (!billingAgreementId) return { updated: false };
  const { data, error } = await db
    .from('membership_dd_invitations')
    .update({
      status: 'completed',
      completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('billing_agreement_id', billingAgreementId)
    .eq('status', 'pending')
    .select('id');
  if (error) {
    console.error('[DD Invitations] mark completed failed:', error.message);
    return { updated: false, error: error.message };
  }
  return { updated: (data || []).length > 0 };
}

/**
 * Revoke the live pending invitation(s) for an agreement (admin action).
 */
export async function revokeInvitationsForAgreement(billingAgreementId, { db = supabase } = {}) {
  if (!billingAgreementId) return { updated: false };
  const { data, error } = await db
    .from('membership_dd_invitations')
    .update({
      status: 'revoked',
      revoked_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('billing_agreement_id', billingAgreementId)
    .eq('status', 'pending')
    .select('id');
  if (error) throw new Error(`revoke invitations failed: ${error.message}`);
  return { updated: (data || []).length > 0 };
}
