// Display-only context. A credential can fulfil several speaker entitlements:
// match the exact assignment, not merely the badge definition or speaker.
const PAGE_SIZE = 500;
const EVENT_TYPES = ['event', 'complex_event'];

async function readPages(makeQuery) {
  const rows = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const { data, error } = await makeQuery().order('id').range(offset, offset + PAGE_SIZE - 1);
    if (error) throw error;
    rows.push(...(data || []));
    if ((data || []).length < PAGE_SIZE) return rows;
  }
}

export async function resolveMemberBadgeEvents(db, { tenantId, memberId, awards }) {
  const associations = new Map(awards.map(award => [award.id, new Map()]));
  if (!awards.length) return associations;
  const byId = new Map(awards.map(award => [award.id, award]));
  const [recognitions, grants] = await Promise.all([
    readPages(() => db.from('speaker_recognition')
      .select('id, member_badge_id, badge_id, event_type, event_id, event_title:snapshot->>event_title, event_start_date:snapshot->>event_start_date, event_timezone:snapshot->>event_timezone')
      .eq('tenant_id', tenantId).eq('member_id', memberId)),
    readPages(() => db.from('speaker_award_grant')
      .select('id, member_badge_id, badge_id, event_type, event_id, event_title:agenda_snapshot->>event_title')
      .eq('tenant_id', tenantId).eq('member_id', memberId)),
  ]);
  const candidates = [];
  for (const row of [...recognitions, ...grants]) {
    const award = byId.get(row.member_badge_id);
    if (award && award.badge_id === row.badge_id && EVENT_TYPES.includes(row.event_type) && row.event_id) {
      candidates.push({ ...row, assignmentId: award.id });
    }
  }
  for (const award of awards) {
    if (award.source !== 'speaker_award') continue;
    const [event_type, event_id, extra] = (award.source_ref || '').split(':');
    if (EVENT_TYPES.includes(event_type) && /^[0-9a-f-]{36}$/i.test(event_id || '') && !extra) {
      candidates.push({ assignmentId: award.id, event_type, event_id });
    }
  }
  const events = new Map();
  await Promise.all(EVENT_TYPES.map(async type => {
    const ids = [...new Set(candidates.filter(row => row.event_type === type).map(row => row.event_id))];
    for (let offset = 0; offset < ids.length; offset += 100) {
      const rows = await readPages(() => db.from(type).select('id, title, start_date, timezone')
        .eq('tenant_id', tenantId).in('id', ids.slice(offset, offset + 100)));
      rows.forEach(row => events.set(`${type}:${row.id}`, row));
    }
  }));
  for (const row of candidates) {
    const key = `${row.event_type}:${row.event_id}`;
    const event = events.get(key);
    const target = associations.get(row.assignmentId);
    const previous = target.get(key);
    target.set(key, {
      event_type: row.event_type,
      event_id: row.event_id,
      event_name: previous?.event_name || row.event_title || event?.title || null,
      // Recognition snapshots explicitly store the PARENT event start. Grant
      // agenda snapshots store appearance dates and must never supply this.
      event_start_date: previous?.event_start_date || row.event_start_date || event?.start_date || null,
      event_timezone: previous?.event_timezone || row.event_timezone || event?.timezone || null,
    });
  }
  return new Map([...associations].map(([id, events]) => [id, [...events.values()]]));
}
