import { FunnelJourneyError } from '../../shared/eventFunnelJourney.mjs';
import { funnelMembershipEnabled } from './funnelMembershipRollout.js';

const fail = (message, code = 'MEMBERSHIP_UNAVAILABLE', status = 409) => { throw new FunnelJourneyError(message, code, status); };
const normalEmail = value => String(value || '').trim().toLowerCase();
const tierScope = tier => tier?.structure_scope_type === 'member' ? 'member' : 'organization';
const escapeLike = value => value.replace(/[\\%_]/g, match => `\\${match}`);

/**
 * Server-built evidence for accepted complimentary membership offers. Runs
 * before any payment or provider commitment; the order-confirmation trigger
 * re-verifies every field. Never activates a membership or changes pricing.
 * Returns [] when no offer was accepted.
 */
export async function resolveFunnelMemberships({ db, tenantId, snapshot, route, plan }) {
  const accepted = route?.acceptedMembershipNodeIds || [];
  if (!accepted.length) return [];
  const ready = funnelMembershipEnabled() ? await db.rpc('event_funnel_membership_ready') : { data: false };
  if (ready.error || ready.data !== true) fail('Complimentary membership offers are not available yet. Decline the offer to continue.', 'MEMBERSHIP_UNAVAILABLE', 503);
  const nodes = new Map(snapshot.graph.nodes.map(node => [node.id, node]));
  const purchaser = snapshot.session.member_id || null;
  const result = [];
  for (const nodeId of accepted) {
    const node = nodes.get(nodeId);
    if (node?.type !== 'membership') fail('This membership offer is no longer available.');
    const { scheduleId, scope, recipientMode } = node.membership;
    const tierRead = await db.from('membership_tier_config').select('id,name,structure_scope_type,is_active')
      .eq('tenant_id', tenantId).eq('id', scheduleId).maybeSingle();
    if (tierRead.error) fail('Membership availability could not be verified.', 'MEMBERSHIP_UNAVAILABLE', 503);
    const tier = tierRead.data;
    if (!tier || tier.is_active === false || tierScope(tier) !== scope) {
      fail('This membership offer is no longer available. Decline it to continue.');
    }
    const qualifyingNodeIds = node.requires?.length ? [...node.requires] : [snapshot.graph.entry];
    const registrations = plan.lines.filter(line => qualifyingNodeIds.includes(line.nodeId))
      .flatMap(line => line.registrations || []);
    if (!registrations.length) fail('This membership offer needs a qualifying booking in this checkout.');
    const allBookings = registrations.map(registration => registration.id);
    let recipients;
    if (!purchaser) {
      fail('Sign in as a member to accept this complimentary membership, or decline the offer.', 'MEMBERSHIP_RECIPIENT_UNAVAILABLE');
    }
    if (scope === 'organization') {
      const member = await db.from('member').select('id,organization_id').eq('tenant_id', tenantId).eq('id', purchaser).maybeSingle();
      if (member.error) fail('Membership eligibility could not be verified.', 'MEMBERSHIP_UNAVAILABLE', 503);
      if (!member.data?.organization_id) {
        fail(`${tier.name} is an organisation membership, and your member record has no organisation. Decline the offer to continue.`, 'MEMBERSHIP_RECIPIENT_UNAVAILABLE');
      }
      recipients = [{ kind: 'organization', id: member.data.organization_id, bookingIds: allBookings }];
    } else if (recipientMode === 'purchaser') {
      recipients = [{ kind: 'member', id: purchaser, bookingIds: allBookings }];
    } else {
      const byEmail = new Map();
      for (const registration of registrations) {
        const email = normalEmail(registration.row?.attendee_email);
        if (!email) fail('Every named attendee needs an email address to receive this membership.', 'MEMBERSHIP_RECIPIENT_UNAVAILABLE');
        byEmail.set(email, [...(byEmail.get(email) || []), registration.id]);
      }
      const byMember = new Map();
      const missing = [];
      for (const [email, bookingIds] of byEmail) {
        const found = await db.from('member').select('id,email').eq('tenant_id', tenantId).ilike('email', escapeLike(email)).limit(2);
        if (found.error) fail('Membership eligibility could not be verified.', 'MEMBERSHIP_UNAVAILABLE', 503);
        const matches = (found.data || []).filter(row => normalEmail(row.email) === email);
        if (matches.length !== 1) { missing.push(email); continue; }
        byMember.set(matches[0].id, [...(byMember.get(matches[0].id) || []), ...bookingIds]);
      }
      if (missing.length) {
        fail(`${missing.length === 1 ? 'One named attendee does' : `${missing.length} named attendees do`} not have a single matching member record, so ${tier.name} cannot be given to each attendee. Correct the attendee emails or decline the offer.`, 'MEMBERSHIP_RECIPIENT_UNAVAILABLE');
      }
      recipients = [...byMember].map(([id, bookingIds]) => ({ kind: 'member', id, bookingIds }));
    }
    result.push({ nodeId, scheduleId, scheduleName: tier.name, scope, recipientMode, recipients, qualifyingNodeIds });
  }
  return result;
}

export function publicMemberships(memberships = []) {
  return memberships.map(item => ({ nodeId: item.nodeId, scheduleName: item.scheduleName, scope: item.scope,
    recipientMode: item.recipientMode, recipientCount: item.recipients.length }));
}
