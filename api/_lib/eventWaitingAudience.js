const normalize = value => String(value || '').trim().toLowerCase();
const validId = value => typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value);
const size = 200;
async function rows(query) {
  const { data, error } = await query;
  if (error || !Array.isArray(data)) throw error || new Error('Waiting list audience unavailable');
  return data;
}
export function waitingAudienceIds(segment) {
  const ids = segment?.ids || [];
  if (!Array.isArray(ids) || !ids.length || ids.length > 100 || ids.some(id => !validId(id))) throw new Error('Select valid waiting list events');
  return [...new Set(ids)];
}
export async function waitingAudienceChunk(db,tenant,segment,cursor) {
  const ids = waitingAudienceIds(segment);
  let query = db.from('event_waiting_entry').select('id,email,first_name,last_name,member_id')
    .eq('tenant_id',tenant).eq('status','active').in('event_id',ids);
  if (cursor) query = query.gt('id',cursor);
  const entries = await rows(query.order('id').limit(size));
  const emails = [...new Set(entries.map(e => normalize(e.email)))];
  // Resolve current member identity/opt-out, including colleagues added before
  // they had a member account. Existing bounded identity RPC is authoritative.
  let members = [];
  if (emails.length) {
    const {data,error} = await db.rpc('campaign_preparation_email_members',{p_tenant:tenant,p_emails:emails,p_trim:true});
    if (error || !Array.isArray(data)) throw error || new Error('Waiting list identities unavailable');
    members = data;
  }
  const byEmail = new Map(members.map(m => [normalize(m.email),m]));
  return { candidates:entries.map(e => {
    const member = byEmail.get(normalize(e.email));
    return {id:member?.id || e.id,member_id:member?.id || null,email:normalize(e.email),
      first_name:e.first_name,last_name:e.last_name,
      communications_opted_out_all:member?.any_opted_out === true || member?.communications_opted_out_all === true};
  }), done:entries.length<size,cursor:entries.at(-1)?.id };
}
export async function resolveWaitingAudience(db,tenant,ids) {
  const result = []; let cursor;
  for (;;) {
    const page = await waitingAudienceChunk(db,tenant,{ids},cursor);
    result.push(...page.candidates);
    if (page.done) return result;
    cursor=page.cursor;
  }
}
// Only direct waiting-list campaigns are exposed. Reject mixing with other
// audiences: otherwise withdrawal could be silently undone by another segment.
export function campaignWaitingIds(campaign) {
  const segments = Array.isArray(campaign.target_audiences) ? campaign.target_audiences : [];
  const waiting = segments.filter(s => s.type === 'event_waiting_list');
  if (campaign.target_type !== 'event_waiting_list' && !waiting.length) return null;
  if (segments.some(s => s.type !== 'event_waiting_list')) throw new Error('Waiting list campaigns cannot mix audience types');
  const ids = waiting.length ? waiting.flatMap(waitingAudienceIds) : campaign.target_ids;
  return waitingAudienceIds({ids});
}
export async function activeWaitingEmails(db,tenant,campaign,emails) {
  const ids = campaignWaitingIds(campaign);
  if (!ids) return null;
  if (emails.length>100) throw new Error('Waiting list eligibility batch too large');
  const active = new Set();
  // Keyset pagination: never assume <=100 entries for <=100 email addresses.
  let cursor;
  for (;;) {
    let query = db.from('event_waiting_entry').select('id,email').eq('tenant_id',tenant)
      .eq('status','active').in('event_id',ids).in('email',[...new Set(emails.map(normalize))]);
    if(cursor) query=query.gt('id',cursor);
    const found=await rows(query.order('id').limit(size));
    found.forEach(row=>active.add(normalize(row.email)));
    if(found.length<size) return active;
    cursor=found.at(-1).id;
  }
}
