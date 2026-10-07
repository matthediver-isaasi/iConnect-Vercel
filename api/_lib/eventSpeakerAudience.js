// Shared by preview and durable preparation. Each call advances one bounded
// assignment slice; continuation never accumulates the historical audience.
const SIZE = 200;
const email = value => typeof value === 'string' ? value.trim().toLowerCase() : '';
const usable = value => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && !/^deleted_.*@deleted\.local$/i.test(value);

export function speakerEvents(segment) {
  if (!Array.isArray(segment?.events) || !segment.events.length ||
      segment.events.some(e => !e?.id || !['event', 'complex_event'].includes(e.source))) {
    throw Object.assign(new Error('Event Speakers requires selected events with their event kind'), { status: 400 });
  }
  return segment.events;
}

async function rows(query) {
  const { data, error } = await query;
  if (error) throw error;
  if (!Array.isArray(data)) throw new Error('Speaker audience source did not return rows');
  return data;
}

export async function validateSpeakerAudienceSegments(db, tenant, segments) {
  for (const segment of segments || []) {
    if (segment.type !== 'event_speakers') continue;
    for (const event of speakerEvents(segment)) {
      const found = await rows(db.from(event.source).select('id').eq('tenant_id', tenant).eq('id', event.id));
      if (!found.length) throw Object.assign(new Error('Selected speaker event is missing or inaccessible'), { status: 400 });
    }
  }
}

export async function speakerAudienceChunk(db, tenant, segment, cursor = {}) {
  const events = speakerEvents(segment);
  const index = cursor.eventIndex || 0;
  if (index >= events.length) return { candidates: [], done: true, cursor };
  const event = events[index];
  // Recheck ownership on every resumed transition, including child reads.
  const parents = await rows(db.from(event.source).select('id,speaker_ids')
    .eq('tenant_id', tenant).eq('id', event.id));
  if (!parents.length) throw new Error('Selected speaker event is missing or inaccessible');
  let assignment = parents[0];
  if (cursor.children) {
    let query = db.from(event.source === 'event' ? 'event_agenda_item' : 'complex_event_session')
      .select('id,speaker_ids').eq('tenant_id', tenant).eq(event.source === 'event' ? 'event_id' : 'complex_event_id', event.id);
    if (cursor.after) query = query.gt('id', cursor.after);
    const children = await rows(query.order('id').limit(1));
    if (!children.length) return { candidates: [], cursor: { eventIndex: index + 1 }, done: index + 1 >= events.length };
    assignment = children[0];
  }
  const offset = cursor.offset || 0;
  const ids = (assignment.speaker_ids || []).slice(offset, offset + SIZE);
  const speakers = ids.length ? await rows(db.from('speaker').select('id,member_id,email,full_name,is_active')
    .eq('tenant_id', tenant).in('id', ids).order('id')) : [];
  const memberIds = [...new Set(speakers.map(s => s.member_id).filter(Boolean))];
  const members = memberIds.length ? await rows(db.from('member')
    .select('id,email,first_name,last_name,communications_opted_out_all')
    .eq('tenant_id', tenant).in('id', memberIds)) : [];
  const byId = new Map(members.map(m => [m.id, m]));
  const candidates = speakers.flatMap(s => {
    if (s.is_active === false) return [];
    const member = byId.get(s.member_id);
    // A dangling/foreign link must not turn into an unsuppressed external contact.
    if (s.member_id && !member) return [];
    const address = email(member ? member.email : s.email);
    if (!usable(address)) return [];
    return [{
      email: address, id: member?.id, member_id: member?.id || null,
      first_name: member?.first_name || (s.full_name || '').split(' ')[0],
      last_name: member?.last_name || (s.full_name || '').split(' ').slice(1).join(' '),
      communications_opted_out_all: member?.communications_opted_out_all === true,
    }];
  });
  const more = offset + SIZE < (assignment.speaker_ids || []).length;
  return { candidates, done: false, cursor: more ? { ...cursor, offset: offset + SIZE }
    : { eventIndex: index, children: true, after: cursor.children ? assignment.id : null, offset: 0 } };
}

export async function resolveSpeakerAudience(db, tenant, segment) {
  let cursor = {}, result;
  const candidates = [];
  do {
    result = await speakerAudienceChunk(db, tenant, segment, cursor);
    candidates.push(...result.candidates);
    cursor = result.cursor;
  } while (!result.done);
  return candidates;
}
