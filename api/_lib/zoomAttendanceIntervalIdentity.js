import { createHash } from 'node:crypto';

// An email-free attendee is not identified by their join timestamp. When Zoom
// supplies no stable ID, retain every occurrence: equal-looking anonymous rows
// can be different people. Sorting/replaying the report retains the same keys.
export function zoomAttendanceIntervalIdentities(participants) {
  const occurrences = new Map();
  return participants.map(p => {
    const email = String(p.user_email || p.email || '').trim().toLowerCase();
    const providerId = p.id || p.user_id || null;
    const identity = p.registrant_id ? ['registrant', p.registrant_id]
      : providerId ? ['participant', providerId] : email ? ['email', email] : null;
    const stable = identity && p.join_time;
    const facts = stable ? [identity, p.join_time] : [
      identity, p.name || p.user_name || null, p.join_time || null,
      p.leave_time || null, p.duration ?? null,
    ];
    const digest = createHash('sha256').update(JSON.stringify(facts)).digest('hex');
    const occurrence = occurrences.get(digest) || 0;
    occurrences.set(digest, occurrence + 1);
    return {
      intervalKey: `zoom:${digest}${stable ? '' : `:${occurrence}`}`,
      providerParticipantId: providerId ? `participant:${providerId}` : null,
    };
  });
}
