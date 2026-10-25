import { createHash } from 'node:crypto';
import { isResourceExcluded } from './roleVisibility.js';
import { simpleTicketClasses, loadComplexReleaseTickets } from './ticketReleaseAccess.js';
import { assertPrivateTicketsAccessible } from './privateTicketAccess.js';
import { isTicketAccessibleToMember, isActiveMemberOfGroup } from './ticketAccess.js';
import { isTicketVisibleToUser, resolveTicketPrice, parsePricingConfig } from './complexEventPricing.js';
import { enforceAttendeeJobTitles } from './attendeeJobTitleRequirement.js';
import { sanitizeOptionSelections, EMPTY_OPTION_SELECTIONS } from './eventOptionSelections.js';

export const WAITING_ENTRY_FIELDS = 'id,registration_id,tenant_id,event_id,event_kind,booker_member_id,member_id,first_name,last_name,email,job_title,ticket_class_id,ticket_name,advertised_price,currency,session_ids,attendee_details,event_title,event_start_date,event_end_date,event_location,status,created_at,withdrawn_at';
export const validWaitingId = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const fail = (message, statusCode = 400) => { throw Object.assign(new Error(message), { statusCode }); };

export async function waitingListAccess(db, member) {
  if (!member?.id || !member.tenant_id || !member.role_id || member.login_enabled === false || member.membership_paused === true) return null;
  const { data: role, error } = await db.from('role').select('excluded_features')
    .eq('tenant_id', member.tenant_id).eq('id', member.role_id).maybeSingle();
  if (error) throw error;
  if (!role) return null;
  const excluded = [...(Array.isArray(role.excluded_features) ? role.excluded_features : []),
    ...(Array.isArray(member.excluded_features) ? member.excluded_features : [])];
  return isResourceExcluded(excluded, 'events.my-tickets') ? null : excluded;
}

export function normalizeWaitingRequest(body) {
  if (!validWaitingId(body?.event_id) || !validWaitingId(body?.idempotency_key) ||
      !['simple','complex'].includes(body?.event_kind)) fail('A valid event and registration reference are required');
  if (!Array.isArray(body.attendees) || body.attendees.length < 1 || body.attendees.length > 100) fail('Provide between 1 and 100 attendees');
  const attendees = body.attendees.map(a => {
    if (!a || typeof a !== 'object') fail('Invalid attendee');
    const text = (value, max) => typeof value === 'string' && value.trim().length <= max ? value.trim() : '';
    const first_name = text(a.first_name, 150), last_name = text(a.last_name, 150), email = text(a.email, 254).toLowerCase();
    if (!first_name || !last_name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail('Provide a name and valid email for every attendee');
    const session_ids = a.session_ids ?? [];
    if (!Array.isArray(session_ids) || session_ids.length > 100 || session_ids.some(id => !validWaitingId(id))) fail('Invalid session selection');
    if (a.ticket_class_id != null && (typeof a.ticket_class_id !== 'string' || a.ticket_class_id.length > 150)) fail('Invalid ticket selection');
    return { first_name, last_name, email, job_title: text(a.job_title, 250),
      ticket_class_id: a.ticket_class_id || null, session_ids: [...new Set(session_ids)].sort(),
      dietary_selections: a.dietary_selections, allergy_selections: a.allergy_selections,
      accessibility_selections: a.accessibility_selections };
  });
  const keys = attendees.map(a => `${a.email}:${a.ticket_class_id || ''}`);
  if (new Set(keys).size !== keys.length) fail('Each attendee can join once per ticket type');
  const request = { event_id: body.event_id, event_kind: body.event_kind, attendees,
    third_party_consent: typeof body.third_party_consent === 'boolean' ? body.third_party_consent : null };
  return { ...request, idempotency_key: body.idempotency_key,
    request_hash: createHash('sha256').update(JSON.stringify(request)).digest('hex') };
}

export async function buildWaitingEntries(db, req, member, request, excluded) {
  const { data: event, error } = await db.from(request.event_kind === 'simple' ? 'event' : 'complex_event')
    .select('*').eq('tenant_id', member.tenant_id).eq('id', request.event_id).maybeSingle();
  if (error) throw error;
  if (!event) fail('Event not found', 404);
  if (!event.waiting_list_enabled || !['published','tbc','immediate'].includes(event.status) ||
      ['closed','cancelled','cancelling','completed'].includes(event.event_state) ||
      (event.registration_closes_at && new Date(event.registration_closes_at) <= new Date())) fail('This waiting list is not accepting registrations', 409);
  const ownEmail = String(member.email || '').trim().toLowerCase();
  if (event.member_group_id) {
    if (request.attendees.length !== 1 || request.attendees[0].email !== ownEmail) fail('Group events only allow self-registration', 403);
    if (event.group_event_public !== true && !await isActiveMemberOfGroup(db, member.id, event.member_group_id)) fail('Group membership is required', 403);
  }
  const tickets = request.event_kind === 'simple' ? simpleTicketClasses(event) : await loadComplexReleaseTickets(db, event);
  const ticketIds = request.attendees.map(a => a.ticket_class_id);
  await assertPrivateTicketsAccessible({ req, db, event, tickets, ticketIds, eventKind: request.event_kind });
  const { data: assignments, error: assignmentError } = await db.from('member_group_assignment')
    .select('group_id,expires_at').eq('member_id', member.id);
  if (assignmentError) throw assignmentError;
  const groups = (assignments || []).filter(a => !a.expires_at || new Date(a.expires_at) > new Date()).map(a => a.group_id);
  const members = [];
  const attendeeEmails = [...new Set(request.attendees.map(a => a.email))];
  for (let i = 0; i < attendeeEmails.length; i += 20) {
    const pattern = attendeeEmails.slice(i,i+20).map(email => email.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('|');
    const { data, error: memberError } = await db.from('member').select('id,email')
      .eq('tenant_id', member.tenant_id).filter('email','imatch',`^(${pattern})$`).limit(101);
    if (memberError || data?.length > 100) throw memberError || new Error('Unable to resolve attendees');
    members.push(...(data || []));
  }
  let sessions = [];
  const sessionTracks = new Map();
  if (request.event_kind === 'complex') {
    let cursor;
    for (;;) {
      let query = db.from('complex_event_session').select('id,title')
        .eq('tenant_id', member.tenant_id).eq('complex_event_id', event.id);
      if (cursor) query = query.gt('id',cursor);
      const result = await query.order('id').limit(200);
      if (result.error) throw result.error;
      sessions.push(...(result.data || []));
      if (!result.data || result.data.length < 200) break;
      cursor = result.data.at(-1).id;
      if (sessions.length >= 10000) throw new Error('Unable to load complete session selection');
    }
    for (let i=0;i<sessions.length;i+=100) {
      let cursor;
      for (;;) {
        let query = db.from('complex_event_session_track').select('id,complex_event_session_id,complex_event_track_id')
          .eq('tenant_id',member.tenant_id).in('complex_event_session_id',sessions.slice(i,i+100).map(s=>s.id));
        if (cursor) query=query.gt('id',cursor);
        const {data,error} = await query.order('id').limit(200);
        if(error) throw error;
        for(const row of data || []) {
          const tracks=sessionTracks.get(row.complex_event_session_id) || [];
          tracks.push(row.complex_event_track_id); sessionTracks.set(row.complex_event_session_id,tracks);
        }
        if(!data || data.length<200) break;
        cursor=data.at(-1).id;
      }
    }
  }
  await enforceAttendeeJobTitles(db, member.tenant_id, request.attendees, request.attendees.length);
  const { data: optionSetting, error: optionError } = await db.from('system_settings').select('setting_value')
    .eq('tenant_id', member.tenant_id).eq('setting_key', 'collect_attendee_options').maybeSingle();
  if (optionError) throw optionError;
  return request.attendees.map(attendee => {
    const isSelf = attendee.email === ownEmail;
    if (isSelf && isResourceExcluded(excluded, 'element_SelfRegistration')) fail('Self registration is not permitted', 403);
    if (!isSelf && isResourceExcluded(excluded, 'element_AddColleaguesToEvents')) fail('Colleague registration is not permitted', 403);
    const ticket = tickets.find(t => String(t.id) === attendee.ticket_class_id);
    if (tickets.length && !ticket) fail('Select a valid ticket');
    if (ticket && (!isTicketVisibleToUser(ticket, true) || !isTicketAccessibleToMember({
      ticketClass: ticket, memberRoleId: member.role_id, memberGroupIds: groups,
      memberId: member.id, tenantId: member.tenant_id, ticketTenantId: member.tenant_id,
    }))) fail('You do not have access to this ticket', 403);
    const allowedSessions = sessions.filter(session => !ticket || ticket.all_tracks ||
      (ticket.linked_track_ids || []).some(id => (sessionTracks.get(session.id) || []).includes(id)));
    const selection = attendee.session_ids.length ? attendee.session_ids : allowedSessions.map(s=>s.id);
    for (const id of selection) {
      if (!allowedSessions.some(s=>s.id===id)) fail('Selected session is not available for this ticket');
    }
    const config = parsePricingConfig(event.pricing_config);
    const price = ticket ? resolveTicketPrice(tickets, ticket.id) : {
      price: Number(config?.ticket_price ?? 0), name: 'Standard ticket', currency: config?.currency || 'gbp',
    };
    if (!Number.isFinite(price.price) || price.price < 0) fail('Advertised price is unavailable', 409);
    const matched = members?.filter(m => String(m.email).trim().toLowerCase() === attendee.email) || [];
    if (!isSelf && !matched.length && isResourceExcluded(excluded, 'element_RegisterExternalAttendees')) fail('External attendee registration is not permitted', 403);
    return { ...attendee, member_id: isSelf ? member.id : matched.length === 1 ? matched[0].id : null,
      ticket_class_id: ticket?.id || null, ticket_name: price.name, advertised_price: price.price,
      currency: price.currency, session_ids: selection, attendee_details: {
        ...(optionSetting?.setting_value === 'false' ? EMPTY_OPTION_SELECTIONS : sanitizeOptionSelections(attendee,event)),
        sessions: allowedSessions.filter(s=>selection.includes(s.id)),
        third_party_consent: config?.collectThirdPartyConsent === true ? request.third_party_consent === true : null,
      } };
  });
}

export async function listWaitingEntries(db, tenantId, { memberId, eventId, eventKind, registrationId } = {}) {
  const entries = [];
  // Stable, bounded pages avoid silently dropping entries at the REST row cap.
  for (let offset = 0; ; offset += 500) {
    let query = db.from('event_waiting_entry').select(WAITING_ENTRY_FIELDS).eq('tenant_id', tenantId).eq('status','active');
    if (memberId) query = query.or(`booker_member_id.eq.${memberId},member_id.eq.${memberId}`);
    if (eventId) query = query.eq('event_id', eventId).eq('event_kind', eventKind);
    if (registrationId) query = query.eq('registration_id', registrationId);
    const { data, error } = await query.order('created_at', { ascending: false }).order('id').range(offset, offset+499);
    if (error) throw error;
    entries.push(...(data || []).map(row => ({ ...row, can_manage_registration: row.booker_member_id === memberId })));
    if (!data || data.length < 500) break;
    if (offset >= 49500) throw new Error('Waiting list is too large to load in one request');
  }
  // Dates/location can be announced after joining a TBC waiting list. Keep
  // ticket-price evidence immutable but show current event details when present.
  for (const kind of ['simple','complex']) {
    const ids = [...new Set(entries.filter(e=>e.event_kind===kind).map(e=>e.event_id))];
    for (let i=0;i<ids.length;i+=100) {
      const {data,error} = await db.from(kind==='simple'?'event':'complex_event')
        .select('id,title,start_date,end_date,location').eq('tenant_id',tenantId).in('id',ids.slice(i,i+100)).limit(101);
      if(error) throw error;
      const current=new Map((data || []).map(e=>[e.id,e]));
      for(const entry of entries) {
        const event=entry.event_kind===kind && current.get(entry.event_id);
        if(event) Object.assign(entry,{event_title:event.title,event_start_date:event.start_date,
          event_end_date:event.end_date,event_location:event.location});
      }
    }
  }
  return entries;
}
