import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { SOURCE, SOURCE_HASH, parseWorkbook, parseSourceRow, matchIdentity, preflight, revalidate, validateManifest, applyManifest, plannedHold, EFFECT_TABLES, assertGuardMetadata } from './outstanding-registration-import.mjs';
import { TENANT } from './import-annual-meeting-delegates.mjs';
import { EVENT } from './annual-meeting-destination.mjs';
import { normalizeGroupPricePaid, normalizeGroupPayment } from '../api/reports/_pricePaid.js';

const id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const other = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const cells = (note = '') => ['Both Days', 3, 'Test Person', 'source@example.org', id, 'Both Days', 'Payment held', 'Review', note];
const member = { id, tenant_id: TENANT, email: 'source@example.org', first_name: 'Test', last_name: 'Person', role_id: 'role' };
function fixture() {
  const source = { workbook_sha256: SOURCE_HASH, rows: [parseSourceRow(cells(), 2)] };
  const state = {
    event: { id: EVENT, tenant_id: TENANT, is_complex: false, pricing_config: { ticket_classes: [
      { id: 'ticket', name: 'Full meeting - Full member', role_ids: ['role'] },
      { id: 'thursday', name: 'Thursday only - Full member', role_ids: ['role'] },
    ] } },
    members: [member], bookings: [], rules: [], badgeRules: [], certificate: null, templates: [], triggers: [],
    columns: ['ticket_price', 'total_cost', 'payment_status', 'stripe_payment_intent_id', 'xero_invoice_id', 'checked_in_at', 'created_at', 'updated_at'].map(column_name => ({ column_name, data_type: column_name.endsWith('_at') ? 'timestamp with time zone' : 'text' })),
    prepared_at: '2026-09-29T12:00:00.000Z',
  };
  return { source, state };
}
test('authentic workbook pins all nine columns and 74 dispositions', { skip: !fs.existsSync(SOURCE) }, () => {
  const source = parseWorkbook(fs.readFileSync(SOURCE));
  assert.equal(source.rows.length, 74);
  assert.ok(source.rows.every(r => r.original.length === 9));
  assert.equal(source.rows.filter(r => r.excluded).length, 5);
  assert.equal(source.rows.filter(r => r.day === 'Friday Only').length, 0);
  assert.throws(() => parseWorkbook(Buffer.from('altered')), /fingerprint/);
});
test('explicit correction handling never discards unnamed column', () => {
  assert.equal(parseSourceRow(cells(other), 2).member_uuid, other);
  assert.equal(parseSourceRow(cells(other), 2).uuid_authoritative, true);
  for (const note of ['Remove duplicate', 'Do not send']) assert.equal(parseSourceRow(cells(note), 2).excluded, true);
  const dayCells = cells('Both days'); dayCells[0] = dayCells[5] = 'Thursday Only';
  assert.equal(parseSourceRow(dayCells, 2).day, 'Both Days');
  assert.throws(() => parseSourceRow(cells('guess'), 2), /Unknown/);
  assert.throws(() => parseSourceRow(cells().slice(0, 8), 2), /nine/);
});
test('UUID exceptions require tenant ownership and unique current recipient', () => {
  const changed = { ...member, email: 'current@example.org' };
  assert.equal(matchIdentity(parseSourceRow(cells(), 2), [changed]).reason, 'uuid_email_conflict');
  const row = parseSourceRow(cells('aware of different email, import using UUID'), 2);
  assert.equal(matchIdentity(row, [changed]).recipient, changed.email);
  assert.equal(matchIdentity(row, [{ ...changed, tenant_id: 'other' }]).reason, 'uuid_missing_or_cross_tenant');
  assert.equal(matchIdentity(row, [changed, { ...changed, id: other }]).reason, 'ambiguous_current_recipient');
  assert.equal(matchIdentity(row, []).reason, 'uuid_missing_or_cross_tenant');
});
test('registration only does not require CPD or certificate eligibility and reports financials unavailable', () => {
  const { source, state } = fixture();
  const report = preflight(source, state), booking = report.rows[0].planned_booking;
  assert.equal(report.summary.ready, 1);
  assert.equal(booking.payment_status, null);
  assert.equal(booking.checked_in_at, null);
  assert.equal(booking.stripe_payment_intent_id, null);
  assert.equal(booking.xero_invoice_id, null);
  assert.deepEqual(normalizeGroupPricePaid([booking]), [{ price_paid: null, price_paid_status: 'unavailable' }]);
  assert.equal(normalizeGroupPayment([booking]).totalsStatus, 'unavailable_import_financials');
  assert.equal(booking.booking_group_reference, booking.booking_reference);
});
test('corrected same member/day merged; different member with same source email never merged', () => {
  const { source, state } = fixture();
  source.rows.push(parseSourceRow(cells('Both days'), 3));
  let report = preflight(source, state);
  assert.equal(report.summary.merged_source_duplicate, 1);
  assert.equal(report.rows[1].covered_booking_id, report.rows[0].planned_booking.id);
  source.rows[1] = parseSourceRow(cells(other), 3);
  state.members.push({ ...member, id: other, email: 'other@example.org' });
  report = preflight(source, state);
  assert.equal(report.summary.ready, 2);
  assert.notEqual(report.rows[0].planned_booking.booking_group_reference, report.rows[1].planned_booking.booking_group_reference);
});
test('conflicting days and existing rows in either booking table are fail closed', () => {
  const { source, state } = fixture();
  const day = cells(); day[0] = day[5] = 'Thursday Only';
  source.rows.push(parseSourceRow(day, 3));
  assert.equal(preflight(source, state).summary.held, 2);
  source.rows.pop();
  const booking = preflight(source, state).rows[0].planned_booking;
  state.bookings = [{ ...booking, table: 'complex_event_booking' }];
  assert.equal(preflight(source, state).summary.already_present, 1);
  state.bookings[0].status = 'cancelled';
  assert.equal(preflight(source, state).summary.held, 1);
  state.bookings[0].status = 'confirmed';
  state.bookings.push({ ...booking, table: 'booking' });
  assert.equal(preflight(source, state).summary.held, 1);
});
test('exclusions never acquire bookings and fresh replay proposes zero inserts', () => {
  const { source, state } = fixture();
  source.rows.push(parseSourceRow(cells('Remove duplicate'), 3), parseSourceRow(cells('Do not send'), 4));
  const report = preflight(source, state);
  assert.equal(report.summary.excluded, 2);
  const manifest = { report, state };
  validateManifest(source, manifest, report.manifest_sha256);
  const live = structuredClone(state);
  live.bookings.push({ ...report.rows[0].planned_booking, table: 'booking' });
  assert.doesNotThrow(() => revalidate(manifest, live));
  assert.equal(preflight(source, live).summary.ready, 0);
  live.bookings[0].payment_status = 'paid';
  assert.throws(() => revalidate(manifest, live), /conflicting/);
  assert.throws(() => validateManifest(source, manifest, '0'.repeat(64)), /mismatch/);
});
test('live config and pre-existing booking drift rejected', () => {
  const { source, state } = fixture();
  state.bookings.push({ id: 'old', table: 'booking', attendee_email: 'unrelated@example.org' });
  const manifest = { report: preflight(source, state), state };
  const live = structuredClone(state);
  live.members[0].email = 'new@example.org';
  assert.throws(() => revalidate(manifest, live), /drift/);
  live.members = state.members;
  live.bookings[0].status = 'cancelled';
  assert.throws(() => revalidate(manifest, live), /changed/);
});
function transactionFixture() {
  const { source, state } = fixture();
  const manifest = { state: structuredClone(state), report: preflight(source, state) };
  let snapshot;
  const holds = [], calls = [];
  const client = { async query(sql, args = []) {
    calls.push(sql);
    if (sql === 'BEGIN') snapshot = { bookings: structuredClone(state.bookings), holds: structuredClone(holds) };
    if (sql === 'ROLLBACK') { state.bookings = snapshot.bookings; holds.splice(0, holds.length, ...snapshot.holds); }
    if (sql.startsWith('INSERT INTO public.outstanding_registration_award_hold')) {
      holds.push(Object.fromEntries(['booking_id', 'tenant_id', 'event_id', 'source_sha256', 'booking_reference'].map((k, i) => [k, args[i]])));
    }
    if (sql.startsWith('INSERT INTO booking')) {
      const value = JSON.parse(args[0]);
      assert.ok(holds.some(h => h.booking_id === value.id), 'hold inserted first');
      state.bookings.push({ ...value, table: 'booking' });
      return { rows: [{ value }] };
    }
    if (sql.startsWith('SELECT booking_id')) return { rows: holds.filter(h => args[0].includes(h.booking_id)).sort((a, b) => a.booking_id.localeCompare(b.booking_id)) };
    if (sql.startsWith('SELECT count')) return { rows: [{ count: client.prohibited ? 1 : 0 }] };
    return { rows: [] };
  } };
  return { source, state, manifest, client, holds, calls, options: { read: async () => state, assertGuards: () => {} } };
}
test('guarded apply inserts hold first, verifies all effect tables, then restart inserts zero', async () => {
  const f = transactionFixture();
  assert.equal((await applyManifest(f.client, f.source, f.manifest, f.manifest.report.manifest_sha256, f.options)).inserted, 1);
  assert.deepEqual(f.holds[0], plannedHold(f.manifest.report.rows[0].planned_booking));
  for (const table of EFFECT_TABLES) assert.ok(f.calls.some(sql => sql.includes(`FROM public.${table} WHERE`)));
  assert.equal(f.calls.at(-1), 'COMMIT');
  const before = f.calls.filter(sql => sql.startsWith('INSERT')).length;
  assert.equal((await applyManifest(f.client, f.source, f.manifest, f.manifest.report.manifest_sha256, f.options)).inserted, 0);
  assert.equal(f.calls.filter(sql => sql.startsWith('INSERT')).length, before);
});
test('award suppression failure rolls back every hold and booking', async () => {
  const f = transactionFixture();
  const query = f.client.query.bind(f.client);
  f.client.query = async (sql, args) => {
    const result = await query(sql, args);
    if (sql.startsWith('INSERT INTO booking')) f.client.prohibited = true;
    return result;
  };
  await assert.rejects(applyManifest(f.client, f.source, f.manifest, f.manifest.report.manifest_sha256, f.options), /Prohibited/);
  assert.equal(f.state.bookings.length, 0);
  assert.equal(f.holds.length, 0);
  assert.equal(f.calls.at(-1), 'ROLLBACK');
  assert.ok(!f.calls.includes('COMMIT'));
});
test('missing replay hold rejects restart and modified manifest fails before database access', async () => {
  const f = transactionFixture();
  f.state.bookings.push({ ...f.manifest.report.rows[0].planned_booking, table: 'booking' });
  await assert.rejects(applyManifest(f.client, f.source, f.manifest, f.manifest.report.manifest_sha256, f.options), /hold missing/);
  f.calls.length = 0;
  f.manifest.report.rows[0].planned_booking.payment_method = 'free';
  await assert.rejects(applyManifest(f.client, f.source, f.manifest, f.manifest.report.manifest_sha256, f.options), /mismatch/);
  assert.equal(f.calls.length, 0);
});
test('missing migration fails apply before BEGIN; immutable guard metadata drift rejected', async () => {
  const f = transactionFixture();
  await assert.rejects(applyManifest(f.client, f.source, f.manifest, f.manifest.report.manifest_sha256), /migration required/);
  assert.equal(f.calls.length, 0);
  assert.throws(() => assertGuardMetadata({ tables: [] }), /migration required/);
  f.manifest.state.award_guard = { functions: [{ prosrc: 'original' }] };
  const live = structuredClone(f.manifest.state);
  live.award_guard.functions[0].prosrc = 'disabled';
  assert.throws(() => revalidate(f.manifest, live), /drift/);
});
test('preflight initializes pinned invitation revision and rejects unknown required fields', () => {
  const { source, state } = fixture();
  state.columns.push({ column_name: 'survey_invitation_revision', data_type: 'bigint', is_nullable: 'NO', column_default: '0' });
  const report = preflight(source, state);
  assert.equal(report.rows[0].planned_booking.survey_invitation_revision, 0);
  assert.equal(report.rows[0].planned_booking.payment_status, null);
  state.columns.at(-1).column_default = '1';
  assert.throws(() => preflight(source, state), /revision schema/);
  state.columns.at(-1).column_default = '0';
  state.columns.push({ column_name: 'future_required_metadata', is_nullable: 'NO', column_default: '42' });
  assert.throws(() => preflight(source, state), /Uninitialized required booking column/);
});