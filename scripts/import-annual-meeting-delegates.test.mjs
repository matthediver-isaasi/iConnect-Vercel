import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { matchMember, matchTicket, parseWorkbook, SOURCE, TENANT, main, preflight, applyManifest, revalidate } from './import-annual-meeting-delegates.mjs';
import { EVENT } from './annual-meeting-destination.mjs';
import { plannedBooking } from './import-annual-meeting-delegates.mjs';

test('independent source registrations never share a purchase/report group', () => {
  const make = (source_row, id) => plannedBooking({
    source_id: `Both Days:${source_row}`, source_row, sheet: 'Both Days',
    member: { id, email: `${id}@example.org` }, ticket: { id: 'ticket', name: 'Full meeting' },
  }, [], '2026-09-28T19:16:33.310Z');
  const first = make(2, 'member-one'), second = make(3, 'member-two');
  assert.notEqual(first.booking_group_reference, second.booking_group_reference);
  assert.equal(first.booking_group_reference, first.booking_reference);
  assert.equal(second.booking_group_reference, second.booking_reference);
});

const member = { id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', tenant_id: TENANT, email: 'Person@example.org', role_id: 'full' };
const row = { member_uuid: member.id, email: 'person@example.org', sheet: 'Both Days', eligible: true };
test('pinned authentic workbook reconciles 179 rows and 123 eligible rows', { skip: !fs.existsSync(SOURCE) && 'Private operator workbook is not distributed in Git' }, () => {
  const source = parseWorkbook(fs.readFileSync(SOURCE));
  assert.equal(source.rows.length, 179);
  assert.equal(source.rows.filter(r => r.eligible).length, 123);
  assert.ok(source.rows.every(r => r.source_row >= 2 && r.original.Email));
  assert.throws(() => parseWorkbook(Buffer.from('different')));
});
test('UUID requires scoped ownership and independent unique email corroboration', () => {
  assert.equal(matchMember(row, [member]).member, member);
  assert.equal(matchMember(row, [{ ...member, tenant_id: 'other' }]).reason, 'uuid_missing_or_cross_tenant');
  assert.equal(matchMember(row, [{ ...member, email: 'other@example.org' }]).reason, 'uuid_email_conflict');
  assert.equal(matchMember(row, [member, { ...member, id: 'other' }]).reason, 'ambiguous_email');
  assert.equal(matchMember({ ...row, member_uuid: 'missing' }, [member]).reason, 'uuid_missing_or_cross_tenant');
});
test('missing UUID permits exact email only; missing records never created', () => {
  assert.equal(matchMember({ ...row, member_uuid: null }, [member]).member, member);
  assert.equal(matchMember({ ...row, member_uuid: null }, []).reason, 'member_missing_no_creation');
});
test('day + primary role ticket matching is exact and conservative', () => {
  const tickets = [{ id: 'full', name: 'Full meeting - Full member', role_ids: ['full'] }, { id: 'fri', name: 'Friday only', role_ids: [] }];
  assert.equal(matchTicket(row, member, tickets).ticket.id, 'full');
  assert.equal(matchTicket(row, { ...member, role_id: 'CPD Guest' }, tickets).reason, 'role_has_no_ticket');
  assert.equal(matchTicket(row, member, [...tickets, tickets[0]]).reason, 'ambiguous_ticket');
  assert.equal(matchTicket({ ...row, sheet: 'Friday Only' }, member, tickets).ticket.id, 'fri');
  assert.equal(matchTicket({ ...row, sheet: 'Thursday Only' }, member, tickets).reason, 'role_has_no_ticket');
});
test('preflight excludes ineligible; holds existing records from either table; never changes rows', () => {
  const state = { event: { id: EVENT, tenant_id: TENANT, is_complex: false, pricing_config: { ticket_classes: [] } }, members: [member], bookings: [{ attendee_email: row.email, table: 'complex_event_booking' }], rules: [], templates: [] };
  const report = preflight({ workbook_sha256: 'test', rows: [row, { ...row, eligible: false }] }, state);
  assert.deepEqual(report.summary, { ready: 0, already_registered: 0, duplicate_source_row: 0, held: 1, excluded: 1 });
  assert.ok(report.rows[0].reasons.includes('existing_booking_review_required'));
  assert.deepEqual(report.rows[1].reasons, ['source_not_cpd_eligible']);
});
test('apply fails before any database access', async () => {
  await assert.rejects(main(['--apply']), /Apply requires/);
});
function fixture() {
  const source = { workbook_sha256: 'test', rows: [{ ...row, source_id: 'Both Days:2', source_row: 2 }] };
  const state = {
    event: { id: EVENT, tenant_id: TENANT, is_complex: false, start_date: '2026-09-24', pricing_config: { ticket_classes: [{ id: 'ticket', name: 'Full meeting - Full member', role_ids: ['full'] }] } },
    members: [member], bookings: [], rules: [{ id: 'rule', active: true, ticket_id: null, trigger_type: 'registration', points_value: '8' }],
    certificate: { config: { eventRule: { template_id: 'template', date_mode: 'event', start_date: null, end_date: null }, ticketRules: {} } },
    templates: [{ id: 'template', status: 'active' }],
    columns: [{ column_name: 'created_at', data_type: 'timestamp with time zone' },
      { column_name: 'updated_at', data_type: 'timestamp with time zone' }],
    prepared_at: '2026-09-28T21:00:00.000Z',
  };
  const report = preflight(source, state);
  assert.equal(report.summary.ready, 1);
  return { source, manifest: { state, report } };
}
function fakeClient(live, failInsert = false) {
  const calls = [];
  const client = { calls, async query(sql, args) {
    calls.push(sql);
    if (sql.startsWith('INSERT')) {
      if (failInsert) throw new Error('injected');
      const value = JSON.parse(args[0]);
      live.bookings.push({ ...value, table: 'booking' });
      return { rows: [{ value }] };
    }
    return { rows: [] };
  } };
  return client;
}
test('apply locks, inserts exact manifest, and replay has zero inserts', async () => {
  const { source, manifest } = fixture();
  const live = structuredClone(manifest.state);
  const client = fakeClient(live);
  const options = { read: async () => live };
  const result = await applyManifest(client, source, manifest, manifest.report.manifest_sha256, options);
  assert.equal(result.inserted, 1);
  assert.equal(live.bookings[0].created_at, manifest.state.prepared_at);
  assert.equal(live.bookings[0].updated_at, manifest.state.prepared_at);
  assert.ok(client.calls.find(q => q.startsWith('LOCK TABLE booking')));
  assert.equal(client.calls.at(-1), 'COMMIT');
  const replayClient = fakeClient(live);
  const replay = await applyManifest(replayClient, source, manifest, manifest.report.manifest_sha256, options);
  assert.equal(replay.inserted, 0);
  assert.equal(replay.results[0].outcome, 'replayed');
  assert.ok(!replayClient.calls.some(q => q.startsWith('INSERT')));
});
test('apply failure rolls back and never commits; manifest tampering fails before BEGIN', async () => {
  const { source, manifest } = fixture();
  const live = structuredClone(manifest.state);
  const client = fakeClient(live, true);
  await assert.rejects(applyManifest(client, source, manifest, manifest.report.manifest_sha256, { read: async () => live }), /injected/);
  assert.equal(client.calls.at(-1), 'ROLLBACK');
  assert.ok(!client.calls.includes('COMMIT'));
  const untouched = fakeClient(live);
  await assert.rejects(applyManifest(untouched, source, manifest, '0'.repeat(64)), /Manifest/);
  assert.equal(untouched.calls.length, 0);
});
test('changed full replay record, unexpected registrations and policy drift fail closed', () => {
  const { manifest } = fixture();
  const live = structuredClone(manifest.state);
  live.bookings.push({ ...manifest.report.rows[0].planned_booking, table: 'booking', checked_in_at: '2026-09-24' });
  assert.throws(() => revalidate(manifest, live), /conflicting/);
  live.bookings = [{ id: 'unexpected' }];
  assert.throws(() => revalidate(manifest, live), /conflicting/);
  live.bookings = [];
  live.members[0].role_id = 'other';
  assert.throws(() => revalidate(manifest, live), /drift/);
});
test('existing exact attendee ticket confirmed booking reused, cancellation held', () => {
  const { source, manifest } = fixture();
  const state = structuredClone(manifest.state);
  state.bookings.push({ ...manifest.report.rows[0].planned_booking, table: 'booking' });
  assert.equal(preflight(source, state).rows[0].disposition, 'already_registered');
  state.bookings[0].status = 'cancelled';
  assert.equal(preflight(source, state).rows[0].disposition, 'held');
});
test('identical day rows share canonical booking; material or cross-day conflicts held', () => {
  const { source, manifest } = fixture();
  source.rows[0].original = { First_Name: 'Test', Last_Name: 'Person' };
  source.rows.push({ ...source.rows[0], source_id: 'Both Days:3', source_row: 3 });
  let report = preflight(source, manifest.state);
  assert.equal(report.rows[0].disposition, 'ready');
  assert.equal(report.rows[1].disposition, 'duplicate_source_row');
  assert.equal(report.rows[1].covered_booking_id, report.rows[0].planned_booking.id);
  source.rows[1].original = { First_Name: 'Different', Last_Name: 'Person' };
  report = preflight(source, manifest.state);
  assert.ok(report.rows.every(r => r.disposition === 'held'));
  source.rows[1].original = source.rows[0].original;
  source.rows[1].sheet = 'Friday Only';
  assert.ok(preflight(source, manifest.state).rows.every(r => r.disposition === 'held'));
});
test('PostgreSQL JSONB timestamp lexical forms compare by instant on insert and replay', async () => {
  const { source, manifest } = fixture();
  const live = structuredClone(manifest.state);
  const client = fakeClient(live);
  const query = client.query.bind(client);
  client.query = async (sql, args) => {
    const result = await query(sql, args);
    if (sql.startsWith('INSERT')) {
      result.rows[0].value.created_at = '2026-09-28T21:00:00+00:00';
      result.rows[0].value.updated_at = '2026-09-28T22:00:00+01:00';
      Object.assign(live.bookings[0], result.rows[0].value);
    }
    return result;
  };
  const options = { read: async () => live };
  assert.equal((await applyManifest(client, source, manifest, manifest.report.manifest_sha256, options)).inserted, 1);
  assert.equal((await applyManifest(client, source, manifest, manifest.report.manifest_sha256, options)).inserted, 0);
  live.bookings[0].created_at = '2026-09-28T21:00:00.001+00:00';
  assert.throws(() => revalidate(manifest, live), /conflicting/);
});
test('unrelated new members allowed only on complete replay; matching identities rejected', () => {
  const { manifest } = fixture();
  const live = structuredClone(manifest.state);
  live.members.push({ id: 'new', tenant_id: TENANT, email: 'unrelated@example.org' });
  assert.throws(() => revalidate(manifest, live), /drift/);
  live.bookings.push({ ...manifest.report.rows[0].planned_booking, table: 'booking' });
  assert.doesNotThrow(() => revalidate(manifest, live));
  live.members[1].email = live.bookings[0].attendee_email;
  assert.throws(() => revalidate(manifest, live), /conflicts/);
  live.members[1].email = 'unrelated@example.org';
  live.members[0].role_id = 'changed';
  assert.throws(() => revalidate(manifest, live), /drift/);
});