import { randomBytes, createHash } from 'node:crypto';
import { loadMemberCommunicationCategoryEligibility } from './communicationCategoryEligibility.js';
import { isEligibleCommunicationMember } from '../../shared/communicationCategoryMembership.js';
import { literalNormalizedEmailPattern, publicTicketEmailExists } from './publicTicketEmail.js';

export const consentHash = token => createHash('sha256').update(token).digest('hex');
function recoveryToken(tenantId, eventKind, eventId, purchaseReference, nonce) {
  return createHash('sha256').update(JSON.stringify([
    'event-registration-consent-v1', tenantId, eventKind, eventId, purchaseReference, nonce,
  ])).digest('base64url');
}
export async function consentData(query) {
  const { data, error } = await query;
  if (error) throw error;
  return data;
}

export async function cloneEventRegistrationCommunication(db, tenantId, kind, fromId, toId) {
  const config = await consentData(db.from('event_registration_communication').select('category_ids')
    .eq('tenant_id', tenantId).eq('event_kind', kind).eq('event_id', fromId).maybeSingle());
  if (!config?.category_ids?.length) return;
  const categories = await consentData(db.from('communication_category').select('id')
    .eq('tenant_id', tenantId).eq('is_active', true).in('id', config.category_ids));
  await consentData(db.rpc('set_event_registration_communication', {
    p_tenant_id: tenantId, p_event_kind: kind, p_event_id: toId,
    p_category_ids: categories.map(c => c.id),
  }));
}

// Called only at the fresh, fulfilled purchase boundary, never for allocation
// claims, payment initiation, raw booking lookups or historical replay.
export async function issueEventRegistrationConsent(db, {
  tenantId, eventKind, eventId, purchaseReference, purchaser, guestEmail, guestIdentity, allocation, recoveryNonce,
}) {
  if (allocation || !purchaseReference) return null;
  const config = await consentData(db.from('event_registration_communication').select('category_ids')
    .eq('tenant_id', tenantId).eq('event_kind', eventKind).eq('event_id', eventId).maybeSingle());
  if (!config?.category_ids?.length) return null;
  const email = String(purchaser?.email || guestIdentity?.email || guestEmail || '').trim().toLowerCase();
  // Snapshot only the identity supplying the email, never an attendee fallback.
  const identity = purchaser || guestIdentity;
  const name = value => typeof value === 'string' ? value.trim().slice(0, 255) || null : null;
  if (!email || !email.includes('@')) return null;
  if (purchaser && purchaser.tenant_id !== tenantId && purchaser.organization?.tenant_id !== tenantId) return null;
  const token = /^[a-f0-9]{64}$/.test(recoveryNonce || '')
    ? recoveryToken(tenantId, eventKind, eventId, purchaseReference, recoveryNonce)
    : randomBytes(32).toString('base64url');
  const { data, error } = await db.from('event_registration_consent').insert({
    tenant_id: tenantId, event_kind: eventKind, event_id: eventId,
    purchase_reference: purchaseReference, member_id: purchaser?.id || null,
    email, first_name: name(identity?.first_name), last_name: name(identity?.last_name),
    token_hash: consentHash(token),
    recovery_hash: /^[a-f0-9]{64}$/.test(recoveryNonce || '') ? consentHash(recoveryNonce) : null,
  }).select('id').single();
  if (error?.code === '23505') return null; // Never renew a completed/dismissed purchase.
  if (error) throw error;
  return { id: data.id, token };
}

export async function recoverEventRegistrationConsent(db, {
  tenantId, eventKind, eventId, purchaseReference, purchaser, recoveryNonce, allocation,
}) {
  if (allocation || !purchaseReference || !/^[a-f0-9]{64}$/.test(recoveryNonce || '')) return null;
  const offer = await consentData(db.from('event_registration_consent').select('id,member_id,token_hash,expires_at,completed_at')
    .eq('tenant_id', tenantId).eq('event_kind', eventKind).eq('event_id', eventId)
    .eq('purchase_reference', purchaseReference).eq('recovery_hash', consentHash(recoveryNonce)).maybeSingle());
  if (!offer || offer.completed_at || Date.parse(offer.expires_at) <= Date.now()
      || (offer.member_id || null) !== (purchaser?.id || null)) return null;
  if (purchaser && (purchaser.organization?.tenant_id || purchaser.tenant_id) !== tenantId) return null;
  const token = recoveryToken(tenantId, eventKind, eventId, purchaseReference, recoveryNonce);
  return consentHash(token) === offer.token_hash ? { id: offer.id, token } : null;
}

// Optional consent must not make an already-completed booking look unsuccessful.
export async function optionalEventRegistrationConsent(db, input) {
  try { return await issueEventRegistrationConsent(db, input); }
  catch { console.warn('[Event consent] Offer could not be prepared'); return null; }
}

export async function eligibleEventRegistrationCategories(db, offer) {
  const config = await consentData(db.from('event_registration_communication').select('category_ids')
    .eq('tenant_id', offer.tenant_id).eq('event_kind', offer.event_kind).eq('event_id', offer.event_id).maybeSingle());
  if (!config?.category_ids?.length) return [];
  const suppressed = await consentData(db.from('email_unsubscribe').select('id')
    .eq('tenant_id', offer.tenant_id).filter('email', 'imatch', literalNormalizedEmailPattern(offer.email))
    .eq('unsubscribe_type', 'all').limit(1));
  if (suppressed?.length) return [];
  let categories, subscribed;
  if (offer.member_id) {
    const eligibility = await loadMemberCommunicationCategoryEligibility(db, {
      tenantId: offer.tenant_id, memberId: offer.member_id,
    });
    if (!eligibility || !isEligibleCommunicationMember(eligibility.member)
        || eligibility.member.email.trim().toLowerCase() !== offer.email) return [];
    categories = eligibility.eligibleCategories;
    const preferences = await consentData(db.from('member_communication_preference').select('category_id')
      .eq('tenant_id', offer.tenant_id).eq('member_id', offer.member_id).eq('is_subscribed', true));
    subscribed = new Set((preferences || []).map(p => p.category_id));
  } else {
    // A typed email is never member authority. Use the same empty response for
    // collisions, suppression and no eligible choices; do not expose existence.
    if (await publicTicketEmailExists(db, offer.tenant_id, offer.email)) return [];
    const roles = await consentData(db.from('communication_category_role').select('category_id')
      .eq('tenant_id', offer.tenant_id));
    const restricted = new Set((roles || []).map(r => r.category_id));
    categories = await consentData(db.from('communication_category').select('id,name,description,system_key')
      .eq('tenant_id', offer.tenant_id).eq('is_active', true).eq('is_public', true)
      .in('id', config.category_ids).order('display_order'));
    categories = (categories || []).filter(c => !c.system_key && !restricted.has(c.id));
    const preferences = await consentData(db.from('email_subscriber').select('communication_category_id')
      .eq('tenant_id', offer.tenant_id).filter('email', 'imatch', literalNormalizedEmailPattern(offer.email)).eq('opted_out', false));
    subscribed = new Set((preferences || []).map(p => p.communication_category_id));
  }
  return categories.filter(c => config.category_ids.includes(c.id) && !subscribed.has(c.id))
    .map(({ id, name, description }) => ({ id, name, description }));
}
