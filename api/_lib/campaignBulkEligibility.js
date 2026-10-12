import { isActiveCommunicationMember } from '../../shared/communicationCategoryMembership.js';

const normalize = value => String(value || '').trim().toLowerCase();
const literal = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
async function rows(query, cap = 201) {
  const { data, error } = await query.limit(cap);
  if (error || !Array.isArray(data) || data.length >= cap) throw new Error('Incomplete campaign eligibility check');
  return data;
}

// Bounded set reads, never one request per recipient. No cross-batch cache:
// each submission and resumed campaign sees current consent and suppressions.
export async function bulkRecipientEligibility(db, entries, campaign, tenantId) {
  if (!entries.length || entries.length > 100 || campaign.tenant_id !== tenantId) throw new Error('Invalid eligibility scope');
  const recipients = entries.map(e => e.recipient);
  const ids = recipients.map(r => r.id);
  const emails = [...new Set(recipients.map(r => normalize(r.email)))];
  const memberIds = [...new Set(recipients.map(r => r.member_id).filter(Boolean))];
  const prepared = Boolean(campaign.preparation_generation);
  const unsubscribeQueries = [];
  if (prepared) for (let offset = 0; offset < emails.length; offset += 20) {
    // imatch preserves literal '*' and case-insensitive address semantics;
    // small chunks also bound URL length for long email addresses.
    let query = db.from('email_unsubscribe').select('email,unsubscribe_type,communication_category_id')
      .eq('tenant_id', tenantId)
      .filter('email', 'imatch', `^(${emails.slice(offset, offset + 20).map(literal).join('|')})$`);
    query = campaign.communication_category_id
      ? query.or(`unsubscribe_type.eq.all,communication_category_id.eq.${campaign.communication_category_id}`)
      : query.eq('unsubscribe_type', 'all');
    unsubscribeQueries.push(rows(query));
  }
  // Start independent lookups together, but settle every read before returning.
  const queries = [
    prepared ? rows(db.from('campaign_preparation_recipient').select('recipient_id,recipient')
      .eq('generation', campaign.preparation_generation).in('recipient_id', ids)) : Promise.resolve([]),
    prepared && memberIds.length ? rows(db.from('member')
      .select('id,email,login_enabled,communications_opted_out_all')
      .eq('tenant_id', tenantId).in('id', memberIds)) : Promise.resolve([]),
    prepared && memberIds.length && campaign.communication_category_id
      ? rows(db.from('member_communication_preference').select('member_id')
        .eq('tenant_id', tenantId).eq('category_id', campaign.communication_category_id)
        .eq('is_subscribed', true).in('member_id', memberIds)) : Promise.resolve([]),
    rows(db.from('email_address_bounce').select('email').eq('tenant_id', tenantId)
      .in('email', emails).is('resolved_at', null)),
    ...unsubscribeQueries,
  ];
  const settled = await Promise.allSettled(queries);
  if (settled.some(r => r.status === 'rejected')) throw new Error('Campaign eligibility could not be verified');
  const [staged, members, preferences, bounces, ...unsubscribeSets] = settled.map(r => r.value);
  const provenance = new Map(staged.map(r => [r.recipient_id, r.recipient]));
  const memberMap = new Map(members.map(r => [r.id, r]));
  const optedIn = new Set(preferences.map(r => r.member_id));
  const bounced = new Set(bounces.map(r => normalize(r.email)));
  const unsubscribed = new Set(unsubscribeSets.flat().filter(r => r.unsubscribe_type === 'all' ||
    (campaign.communication_category_id && r.unsubscribe_type === 'category' &&
      r.communication_category_id === campaign.communication_category_id)).map(r => normalize(r.email)));
  const result = new Map();
  for (const r of recipients) {
    const email = normalize(r.email);
    if (prepared && (!provenance.get(r.id) || typeof provenance.get(r.id) !== 'object' ||
      Array.isArray(provenance.get(r.id)))) throw new Error('Missing prepared consent provenance');
    let state = 'ready';
    if (prepared && provenance.get(r.id)?.bypass_opt_out !== true) {
      const member = memberMap.get(r.member_id);
      if (unsubscribed.has(email) || (r.member_id && (!member ||
        member.communications_opted_out_all === true || normalize(member.email) !== email ||
        (campaign.communication_category_id && (!isActiveCommunicationMember(member) || !optedIn.has(member.id)))))) {
        state = 'unsubscribed';
      }
    }
    // Consent exceptions never exempt a hard-bounced address.
    if (bounced.has(email)) state = 'cancelled';
    result.set(r.id, state);
  }
  return result;
}
