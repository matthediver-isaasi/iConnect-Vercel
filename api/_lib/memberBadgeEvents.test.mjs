import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveMemberBadgeEvents } from './memberBadgeEvents.js';
import { loadActiveSelfBadges } from './selfMemberBadges.js';
import { badgeDatabase } from './memberBadgeEvents.fixtures.mjs';

const scope = { tenant_id: 't1', member_id: 'm1' };
const award = { ...scope, id: 'credential', badge_id: 'speaker', source: 'manual', awarded_at: '2026-01-02T12:00:00Z', revoked_at: null, badge: { id: 'speaker', name: 'Speaker', is_active: true } };
const evidence = (id, event_type, event_id, extra = {}) => ({
  ...scope, id, event_type, event_id, member_badge_id: award.id, badge_id: award.badge_id, ...extra,
});
const context = { tenantId: 't1', memberId: 'm1', awards: [award] };

test('simple, complex and training entitlements share one credential, not event or award dates', async () => {
  const db = badgeDatabase({
    member_badge: [award],
    speaker_recognition: [
      evidence('r1', 'event', 'simple', { event_title: 'Simple snapshot', event_start_date: '2026-04-01T23:30:00Z', event_timezone: 'Europe/London' }),
      evidence('r2', 'event', 'training', { agenda_start_date: '2026-05-20', event_title: 'Training', event_start_date: '2026-05-01' }),
      evidence('r3', 'event', 'training', { agenda_start_date: '2026-05-21' }),
    ],
    speaker_award_grant: [
      evidence('g1', 'event', 'simple'),
      evidence('g2', 'complex_event', 'complex'),
      evidence('g3', 'event', 'training', { start_date: '2026-05-20' }),
    ],
    event: [
      { id: 'simple', tenant_id: 't1', title: 'Simple live', start_date: '2026-04-01T23:30:00Z' },
      { id: 'training', tenant_id: 't1', title: 'Training live', start_date: '2026-05-01' },
    ],
    complex_event: [{ id: 'complex', tenant_id: 't1', title: 'Complex', start_date: '2026-06-01', timezone: 'UTC' }],
  });
  const result = await loadActiveSelfBadges(db, { isAuthenticated: true, ...context });
  assert.equal(result.badges.length, 1);
  const badge = result.badges[0];
  assert.equal(badge.awarded_at, award.awarded_at);
  assert.deepEqual(badge.speaker_events.map(e => [e.event_name, e.event_start_date]), [
    ['Simple snapshot', '2026-04-01T23:30:00Z'], ['Training', '2026-05-01'], ['Complex', '2026-06-01'],
  ]);
  assert.deepEqual(Object.keys(badge).sort(), ['id', 'name', 'is_active', 'awarded_at', 'speaker_events'].sort());
  assert.equal(db.calls.filter(c => c.table === 'event').length, 1);
  assert.equal(db.calls.filter(c => c.table === 'complex_event').length, 1);
  for (const call of db.calls) assert.ok(call.filters.some(([key, value]) => key === 'tenant_id' && value === 't1'));
});

test('missing events retain snapshots without inventing a parent date from an agenda or award', async () => {
  const db = badgeDatabase({
    speaker_recognition: [evidence('r', 'event', 'removed', { event_title: 'Recorded title', event_start_date: '2026-03-01' })],
    speaker_award_grant: [evidence('g', 'event', 'missing', { event_title: 'Agenda title', start_date: '2026-04-10', agenda_start_date: '2026-04-10' })],
  });
  const events = (await resolveMemberBadgeEvents(db, context)).get(award.id);
  assert.equal(events[0].event_start_date, '2026-03-01');
  assert.equal(events[1].event_name, 'Agenda title');
  assert.equal(events[1].event_start_date, null);
});

test('exact credential identity and tenant/member boundaries exclude unrelated evidence and events', async () => {
  const db = badgeDatabase({
    speaker_recognition: [
      evidence('other-tenant', 'event', 'secret', { tenant_id: 't2', event_title: 'Secret' }),
      evidence('other-member', 'event', 'secret', { member_id: 'm2', event_title: 'Secret' }),
      evidence('other-credential', 'event', 'secret', { member_badge_id: 'other' }),
      evidence('other-badge', 'event', 'secret', { badge_id: 'other' }),
      evidence('valid', 'event', 'foreign-event'),
    ],
    event: [{ tenant_id: 't2', id: 'foreign-event', title: 'Secret event', start_date: '2026-01-01' }],
  });
  const events = (await resolveMemberBadgeEvents(db, context)).get(award.id);
  assert.deepEqual(events, [{ event_type: 'event', event_id: 'foreign-event', event_name: null, event_start_date: null, event_timezone: null }]);
});

test('source references resolve legacy revoked history but do not attribute events to a re-awarded credential', async () => {
  const id = '11111111-1111-1111-1111-111111111111';
  const old = { ...award, id: 'old', source: 'speaker_award', source_ref: `event:${id}`, revoked_at: '2026-03-01' };
  const db = badgeDatabase({ event: [{ id, tenant_id: 't1', title: 'Legacy', start_date: '2026-02-01' }] });
  const resolved = await resolveMemberBadgeEvents(db, { ...context, awards: [old, award] });
  assert.equal(resolved.get('old')[0].event_name, 'Legacy');
  assert.deepEqual(resolved.get(award.id), []);
});

test('database failures are not treated as missing event data', async () => {
  for (const table of ['speaker_recognition', 'speaker_award_grant', 'event']) {
    const db = badgeDatabase({ speaker_recognition: [evidence('r', 'event', 'e')] }, { [table]: new Error(`failed ${table}`) });
    await assert.rejects(resolveMemberBadgeEvents(db, context), new RegExp(`failed ${table}`));
  }
});

test('evidence is paginated rather than silently truncated at a PostgREST row cap', async () => {
  const db = badgeDatabase({ speaker_award_grant: Array.from({ length: 501 }, (_, i) => evidence(`g${i}`, 'event', 'e')) });
  const resolved = await resolveMemberBadgeEvents(db, context);
  assert.equal(resolved.get(award.id).length, 1);
  assert.equal(db.calls.filter(c => c.table === 'speaker_award_grant').length, 2);
});
