// GoCardless Phase 5 — migration of EXISTING members (paying by Stripe /
// invoice) onto monthly Direct Debit.
//
// Workflow:
//   1. Tier config opts in via dd_migration_enabled (plus dd_enabled).
//   2. Admin invites a member (membership_dd_migration_invites row + email
//      with a secure token link). switch_from_year is the membership year
//      the DD starts from — the invite NEVER touches the member's current
//      paid year.
//   3. Member opens the link, sees the offer, accepts (mandate set-up via
//      the standard hosted flow, or instant reuse of an active mandate) or
//      declines.
//   4. Funnel derived at report time from the invite + its linked agreement/
//      plan: invited -> accepted -> mandate active -> subscription active,
//      with declined / expired / revoked / failed branches.
//
// Token semantics mirror the Phase 3 org billing-contact invitations:
// single-use, superseded by re-invite, expiry clamped 1-90 days.

import { supabase } from './database.js';
import {
  generateInviteToken,
  computeExpiry,
  resolveInviteExpiryDays,
} from './gocardlessDdInvitations.js';

export const MIGRATION_INVITE_STATUSES = Object.freeze([
  'invited', 'accepted', 'declined', 'revoked', 'superseded', 'expired',
]);

/**
 * Pure: validate a migration invite row. Returns { valid, reason? }.
 * reason: 'not_found' | 'revoked' | 'superseded' | 'declined' | 'expired' | 'accepted'
 */
export function validateMigrationInvite(invite, now = new Date()) {
  if (!invite) return { valid: false, reason: 'not_found' };
  if (invite.status === 'revoked') return { valid: false, reason: 'revoked' };
  if (invite.status === 'superseded') return { valid: false, reason: 'superseded' };
  if (invite.status === 'declined') return { valid: false, reason: 'declined' };
  if (invite.status === 'accepted') return { valid: false, reason: 'accepted' };
  if (invite.status === 'expired') return { valid: false, reason: 'expired' };
  if (invite.expires_at && new Date(invite.expires_at) <= now) {
    return { valid: false, reason: 'expired' };
  }
  return { valid: true };
}

export const MIGRATION_INVITE_INVALID_MESSAGES = Object.freeze({
  not_found: 'This invitation link is not valid.',
  revoked: 'This invitation has been withdrawn. Please contact the organisation.',
  superseded: 'A newer invitation has been sent. Please use the most recent email.',
  declined: 'This invitation was declined. Please contact the organisation if you have changed your mind.',
  accepted: 'This invitation has already been used.',
  expired: 'This invitation has expired. Please contact the organisation for a new link.',
});

/**
 * Create a migration invite for a member, superseding any earlier live
 * invites for the same member. Returns the new invite row.
 */
export async function createMigrationInvite({
  tenantId,
  memberId,
  invitedEmail,
  invitedBy = null,
  switchFromYear,
  db = supabase,
} = {}) {
  if (!tenantId || !memberId || !switchFromYear) {
    throw new Error('tenantId, memberId and switchFromYear are required');
  }
  await db
    .from('membership_dd_migration_invites')
    .update({ status: 'superseded', updated_at: new Date().toISOString() })
    .eq('tenant_id', tenantId)
    .eq('member_id', memberId)
    .eq('status', 'invited');

  const days = await resolveInviteExpiryDays(tenantId, { db });
  const { data, error } = await db
    .from('membership_dd_migration_invites')
    .insert({
      tenant_id: tenantId,
      member_id: memberId,
      token: generateInviteToken(),
      invited_email: invitedEmail || null,
      invited_by: invitedBy,
      switch_from_year: switchFromYear,
      status: 'invited',
      expires_at: computeExpiry(new Date(), days).toISOString(),
    })
    .select()
    .single();
  if (error) throw new Error(`create migration invite failed: ${error.message}`);
  return data;
}

/**
 * Derive the funnel stage for one invite (+ optionally its agreement/plan).
 * Stages: invited | accepted | mandate_active | subscription_active |
 *         declined | revoked | expired | superseded | failed
 */
export function migrationFunnelStage(invite, { agreement = null, plan = null } = {}, now = new Date()) {
  if (!invite) return null;
  if (['declined', 'revoked', 'superseded'].includes(invite.status)) return invite.status;
  if (invite.status === 'expired') return 'expired';
  if (invite.status === 'invited') {
    return invite.expires_at && new Date(invite.expires_at) <= now ? 'expired' : 'invited';
  }
  // accepted
  if (plan && ['cancelled', 'failed'].includes(String(plan.status || '').toLowerCase())) return 'failed';
  if (plan && plan.gocardless_subscription_id) return 'subscription_active';
  if (agreement?.gocardless_mandate_id) return 'mandate_active';
  return 'accepted';
}

/**
 * Build the conversion-funnel report for a tenant.
 * Returns { counts, invites: [{ ...invite, stage, memberName, memberEmail }] }.
 */
export async function buildMigrationFunnel(tenantId, { db = supabase } = {}) {
  const { data: invites, error } = await db
    .from('membership_dd_migration_invites')
    .select('*')
    .eq('tenant_id', tenantId)
    .order('created_at', { ascending: false });
  if (error) throw new Error(`load migration invites failed: ${error.message}`);
  const rows = invites || [];

  const agreementIds = rows.map((i) => i.billing_agreement_id).filter(Boolean);
  let agreementsById = new Map();
  let plansByAgreement = new Map();
  if (agreementIds.length) {
    const { data: agreements } = await db
      .from('membership_billing_agreements')
      .select('id, status, gocardless_mandate_id, metadata')
      .in('id', agreementIds);
    agreementsById = new Map((agreements || []).map((a) => [a.id, a]));
    const { data: plans } = await db
      .from('membership_payment_plans')
      .select('id, billing_agreement_id, status, gocardless_subscription_id')
      .in('billing_agreement_id', agreementIds);
    plansByAgreement = new Map((plans || []).map((p) => [p.billing_agreement_id, p]));
  }

  const memberIds = [...new Set(rows.map((i) => i.member_id))];
  let membersById = new Map();
  if (memberIds.length) {
    const { data: members } = await db
      .from('member')
      .select('id, first_name, last_name, email')
      .in('id', memberIds);
    membersById = new Map((members || []).map((m) => [m.id, m]));
  }

  const counts = {
    invited: 0, accepted: 0, mandate_active: 0, subscription_active: 0,
    declined: 0, expired: 0, revoked: 0, superseded: 0, failed: 0,
  };
  const enriched = rows.map((invite) => {
    const agreement = invite.billing_agreement_id ? agreementsById.get(invite.billing_agreement_id) : null;
    const plan = invite.billing_agreement_id ? plansByAgreement.get(invite.billing_agreement_id) : null;
    const stage = migrationFunnelStage(invite, { agreement, plan });
    if (counts[stage] != null) counts[stage] += 1;
    const member = membersById.get(invite.member_id);
    return {
      ...invite,
      token: undefined, // never expose live tokens in admin listings
      stage,
      memberName: member ? `${member.first_name || ''} ${member.last_name || ''}`.trim() : null,
      memberEmail: member?.email || null,
      hasMandate: !!agreement?.gocardless_mandate_id,
      planStatus: plan?.status || null,
    };
  });

  return { counts, invites: enriched };
}
