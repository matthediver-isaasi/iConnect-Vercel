import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TENANT, SOURCE_SHA256, expectedImportIdentity, validateInput, evaluateBooking,
  inspect as inspectBookings, claimSelected, processSelected, savePrivate,
} from './verify-annual-meeting-cpd.mjs';
import { EVENT } from './annual-meeting-destination.mjs';

const member = '9c97d7d3-bd17-4fc4-96b1-8a9a6fb675a1';
const ticket = 'ticket-full';
const source_id = 'Both Days:2';
const identity = expectedImportIdentity(source_id);
const item = {
  ...identity, source_id, booking_source: 'standard', expected_points: '8',
  member_id: member, ticket_class_id: ticket,
};
const booking = {
  id: item.booking_id, tenant_id: TENANT, event_id: EVENT, status: 'confirmed',
  payment_method: 'admin_import', is_guest_booking: false, member_id: member,
  attendee_email: 'person@example.org', ticket_class_id: ticket,
  booking_reference: item.booking_reference,
};
const matched = { id: member, tenant_id: TENANT, email: 'Person@Example.org' };
const rule = {
  id: '1b7c01db-b798-4617-b0d1-9b60a63b48d0', ticket_id: ticket, active: true,
  trigger_type: 'registration', is_no_award: false, points_value: '8.000000',
};
const outbox = {
  id: '77f04f09-cd76-4c8c-bd2b-449d29b22171',
  status: 'complete', trigger_type: 'registration', evidence_type: 'confirmed_booking',
  evidence_id: item.booking_id, idempotency_key: `registration:booking:${item.booking_id}:2026-09-24T08:00:00Z`, attempts: 1,
};
const ledger = {
  id: '209281c2-03a3-490d-b98a-07e61b8e26fd', entry_kind: 'event_award',
  award_trigger: 'registration', member_id: member, ticket_id: ticket,
  rule_id: rule.id, evidence_type: 'confirmed_booking', points_value: '8',
  event_id: EVENT, booking_id: item.booking_id, booking_type: 'booking',
};
const certificate = {
  available: true, certificate_points_source: 'member_ledger',
  provenance: { attendee_member_id: member },
  placeholders: [{ placeholder_key: 'cpd.cpd_points' }],
  values: { 'cpd.cpd_points': 8 }, fingerprint: 'fingerprint',
};
const inspect = (i = item, b = booking, m = matched, r = [rule], o = [outbox], l = [ledger], c = certificate) =>
  evaluateBooking(i, b, m, r, o, l, c);

test('exact workbook identity and target scoping are mandatory for selected processing', () => {
  assert.deepEqual(validateInput({ tenant_id: TENANT, source_sha256: SOURCE_SHA256, bookings: [item] }, true).bookings[0], item);
  for (const edit of [
    x => { x.tenant_id = 'wrong'; },
    x => { x.source_sha256 = 'wrong'; },
    x => { x.bookings[0].booking_id = 'deb4e015-b47a-4005-9cea-b6971bd383dd'; },
    x => { x.bookings[0].booking_reference = 'IMPORTED-OTHER'; },
    x => { x.bookings[0].source_id = 'Friday Only:2'; },
    x => { x.bookings[0].booking_source = 'complex'; },
    x => { x.bookings[0].member_id = null; },
    x => { x.bookings[0].ticket_class_id = null; },
    x => { x.bookings[0].expected_points = '10'; },
  ]) {
    const changed = structuredClone({ tenant_id: TENANT, source_sha256: SOURCE_SHA256, bookings: [item] });
    edit(changed);
    assert.throws(() => validateInput(changed, true));
  }
  const duplicate = { tenant_id: TENANT, bookings: [item, item] };
  assert.throws(() => validateInput(duplicate), /Repeated/);
  assert.throws(() => validateInput({ tenant_id: TENANT, bookings: Array.from({ length: 101 }, () => item) }));
  assert.match(expectedImportIdentity('Friday Only:9').booking_reference, /-F-9$/);
});

test('read-only reconciliation requires one positive attendee booking award and same certificate points', () => {
  assert.deepEqual(inspect().issues, []);
  assert.equal(inspect().certificate_status, 'available');
  assert.ok(inspect(item, null).issues.includes('booking_not_in_target_event'));
  assert.ok(inspect(item, { ...booking, member_id: null }).issues.includes('booking_not_confirmed_member_import'));
  assert.ok(inspect(item, booking, { ...matched, email: 'other@example.org' }).issues.includes('attendee_member_identity_mismatch'));
  assert.ok(inspect(item, booking, matched, [{ ...rule, points_value: '5' }]).issues.includes('registration_rule_mismatch'));
  assert.ok(inspect(item, booking, matched, [{ ...rule, active: false }]).issues.includes('registration_rule_mismatch'));
  assert.ok(inspect(item, booking, matched, [rule], [outbox], [ledger, ledger]).issues.includes('duplicate_positive_award'));
  assert.ok(inspect(item, booking, matched, [rule], [outbox], [{ ...ledger, member_id: 'other' }]).issues.includes('ledger_award_mismatch'));
  assert.ok(inspect(item, booking, matched, [rule], [outbox], [ledger, { entry_kind: 'reversal' }]).issues.includes('award_reversed'));
  assert.ok(inspect(item, booking, matched, [rule], [outbox], [ledger],
    { ...certificate, certificate_points_source: 'guest_rule' }).issues.includes('certificate_points_mismatch'));
  assert.ok(inspect(item, booking, matched, [rule], [outbox], [ledger],
    { ...certificate, values: { 'cpd.cpd_points': '5' } }).issues.includes('certificate_points_mismatch'));
  assert.ok(inspect(item, booking, matched, [rule], [outbox], [], {
    available: false, reason: 'Required certificate data is unavailable: cpd.cpd_points.',
  }).issues.includes('certificate_pending_points'));
});

test('inspection bounds concurrent certificate reads to five and reports counts without IDs', async () => {
  const client = { query: async sql => {
    if (sql.includes('from public.event where')) return { rows: [{ id: EVENT, tenant_id: TENANT }] };
    if (sql.includes('from public.event_cpd_points_rule')) return { rows: [rule] };
    if (sql.includes('from public.booking')) return { rows: [booking] };
    if (sql.includes('from public.member where')) return { rows: [matched] };
    if (sql.includes('from public.event_cpd_points_outbox')) return { rows: [outbox] };
    if (sql.includes('from public.member_cpd_points_ledger')) return { rows: [ledger] };
    throw Error('Unexpected inspection query');
  } };
  let active = 0;
  let peak = 0;
  const progress = [];
  const rows = await inspectBookings(client, {}, { bookings: Array.from({ length: 12 }, () => item) },
    async () => {
      active++;
      peak = Math.max(active, peak);
      await new Promise(resolve => setTimeout(resolve, 1));
      active--;
      return certificate;
    }, (completed, requested) => progress.push([completed, requested]));
  assert.equal(rows.length, 12);
  assert.ok(rows.every(row => row.issues.length === 0));
  assert.equal(peak, 5);
  assert.deepEqual(progress, [[10, 12]]);
});

test('scoped SQL claim only touches one ready, matching, confirmed registration row', async () => {
  const calls = [];
  const db = { query: async (sql, args) => {
    calls.push({ sql, args });
    return { rows: /^UPDATE/.test(sql) ? [{ id: outbox.id, lock_token: 'token' }] : [] };
  } };
  const row = await claimSelected(db, item);
  assert.equal(row.id, outbox.id);
  const update = calls.find(call => /^UPDATE/.test(call.sql));
  assert.deepEqual(update.args, [TENANT, item.booking_id, EVENT, member, ticket, identity.booking_reference]);
  for (const condition of [
    "o.trigger_type='registration'", "o.evidence_type='confirmed_booking'",
    "o.evidence_id=o.booking_id::text", "o.idempotency_key LIKE ('registration:booking:' || o.booking_id::text || ':%')",
    "o.status IN ('pending','retry')", 'o.available_at<=now()', "b.payment_method='admin_import'",
    "b.is_guest_booking=false", "b.status='confirmed'", 'm.tenant_id=b.tenant_id',
  ]) assert.ok(update.sql.includes(condition), condition);
  assert.equal(calls.at(-1).sql, 'COMMIT');
  const failed = { query: async sql => {
    calls.push({ sql });
    if (/^UPDATE/.test(sql)) throw new Error('blocked');
    return { rows: [] };
  } };
  await assert.rejects(claimSelected(failed, item), /blocked/);
  assert.equal(calls.at(-1).sql, 'ROLLBACK');
});

test('selected award uses original idempotency key, explicit db, lock token and no global claim', async () => {
  const sql = {
    query: async query => ({ rows: /^UPDATE/.test(query)
      ? [{ ...outbox, idempotency_key: 'original-idempotency-key', tenant_id: TENANT,
        booking_id: item.booking_id, lock_token: 'unique-token',
        evidence_type: 'confirmed_booking', evidence_snapshot: {} }] : [] }),
  };
  const calls = [];
  const db = { rpc: async (name, args) => {
    calls.push([name, args]);
    return { data: true };
  } };
  const result = await processSelected(sql, db, { bookings: [item] },
    async (input, opts) => {
      assert.equal(opts.db, db);
      assert.equal(input.idempotencyKey, 'original-idempotency-key');
      assert.equal(input.evidence.type, 'confirmed_booking');
      return { status: 'awarded' };
    });
  assert.equal(result[0].status, 'awarded');
  assert.deepEqual(calls, [['complete_event_cpd_points_outbox', {
    p_id: outbox.id, p_lock_token: 'unique-token',
  }]]);
});

test('private output refuses any public path', () => {
  assert.throws(() => savePrivate('public/report.json', {}), /private/);
});