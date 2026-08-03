// Task #3287: speaker award notification emails — send leases vs delivery
// stamps, partial-failure retry, concurrent-worker interleavings, and the
// stamp-independent sweep.
import test from 'node:test';
import assert from 'node:assert/strict';
import { sendPendingSpeakerAwardNotifications, LEASE_TTL_MS } from './speakerAwardEmails.js';

// Minimal chainable fake supabase. `tables` maps table name to handler(s):
// { select: (filters) => rows, update: (values, filters) => rows }
function makeFakeDb(tables, log = []) {
  return {
    from(table) {
      const filters = {};
      let mode = 'select';
      let updateValues = null;
      const chain = {
        select() { if (mode !== 'update') mode = 'select'; return chain; },
        update(values) { mode = 'update'; updateValues = values; return chain; },
        eq(col, val) { filters[col] = val; return chain; },
        is(col, val) { filters[`${col} is`] = val; return chain; },
        limit() { return chain; },
        async maybeSingle() {
          const rows = await run();
          return { data: rows[0] ?? null, error: null };
        },
        then(resolve, reject) {
          return run().then(rows => resolve({ data: rows, error: null }), reject);
        },
      };
      async function run() {
        log.push({ table, mode, filters, updateValues });
        const h = tables[table] || {};
        if (mode === 'update') return (h.update ? h.update(updateValues, filters) : []) || [];
        return (h.select ? h.select(filters) : []) || [];
      }
      return chain;
    },
  };
}

function baseGrant(overrides = {}) {
  return {
    id: 'g1', tenant_id: 't1', event_type: 'event', event_id: 'ev1',
    speaker_id: 'sp1', speaker_name: 'Ada Lovelace',
    member_id: 'm1', organization_id: 'o1', status: 'granted',
    voucher_id: 'v1', voucher_value: 100, badge_id: 'b1', member_badge_id: 'mb1',
    notified_at: null,
    member_notified_at: null, org_notified_at: null,
    member_notify_lease_at: null, org_notify_lease_at: null,
    ...overrides,
  };
}

// Stateful grant table: compare-and-set updates mutate the row like the real
// DB — `.is(col, null)` and `.eq(col, value)` filters must match to update.
function grantTable(row) {
  return {
    select: (filters) => {
      if (filters.id) return row.id === filters.id ? [{ ...row }] : [];
      return row.status === 'granted' && !row.notified_at ? [{ ...row }] : [];
    },
    update: (values, filters) => {
      for (const [key, val] of Object.entries(filters)) {
        if (key.endsWith(' is')) {
          if (row[key.slice(0, -3)] !== val) return [];
        } else if (key === 'id') {
          if (row.id !== val) return [];
        } else if (row[key] !== val) {
          return [];
        }
      }
      Object.assign(row, values);
      return [{ id: row.id }];
    },
  };
}

function standardTables(grantRow) {
  return {
    speaker_award_grant: grantTable(grantRow),
    event: { select: () => [{ id: 'ev1', tenant_id: 't1', title: 'Annual Summit & Expo' }] },
    tenant: { select: () => [{ slug: 'acme' }] },
    voucher: { select: () => [{ id: 'v1', value: 100, expires_at: '2027-01-31', code: 'SPK-X' }] },
    badge: { select: () => [{ id: 'b1', name: 'Speaker 2026' }] },
    member: {
      select: (filters) => {
        if (filters.is_primary_contact) return [{ email: 'billing@org.example' }];
        return [{ id: 'm1', email: 'ada@example.com', first_name: 'Ada' }];
      },
    },
    organization: { select: () => [{ id: 'o1', name: 'Acme Ltd', invoicing_email: 'invoices@acme.example' }] },
  };
}

test('sends member + org billing emails, stamps deliveries and notified_at, clears leases', async () => {
  const sent = [];
  const row = baseGrant();
  const db = makeFakeDb(standardTables(row));
  const summary = await sendPendingSpeakerAwardNotifications({
    db, send: async (msg) => { sent.push(msg); return { success: true }; },
  });
  assert.equal(summary.notified, 1);
  assert.equal(summary.failed, 0);
  assert.equal(sent.length, 2);
  assert.equal(sent[0].to, 'ada@example.com');
  assert.equal(sent[1].to, 'invoices@acme.example');
  assert.match(sent[0].subject, /Annual Summit & Expo/);
  assert.match(sent[0].html, /Annual Summit &amp; Expo/); // escaped in body
  assert.match(sent[0].html, /£100\.00/);
  assert.match(sent[0].html, /31 January 2027/);
  assert.match(sent[0].html, /Speaker 2026/);
  assert.match(sent[0].html, /Balances/);
  assert.match(sent[1].html, /Ada Lovelace/);
  assert.ok(row.member_notified_at && row.org_notified_at && row.notified_at);
  assert.equal(row.member_notify_lease_at, null);
  assert.equal(row.org_notify_lease_at, null);
});

test('partial failure keeps delivered recipient, retries only the failed one', async () => {
  const row = baseGrant();
  const db = makeFakeDb(standardTables(row));
  const summary = await sendPendingSpeakerAwardNotifications({
    db,
    send: async (msg) => (msg.to === 'ada@example.com' ? { success: true } : { success: false, error: 'mailgun down' }),
  });
  assert.equal(summary.notified, 0);
  assert.equal(summary.failed, 1);
  assert.ok(row.member_notified_at, 'member delivery persisted');
  assert.equal(row.org_notified_at, null);
  assert.equal(row.org_notify_lease_at, null, 'failed lease released for retry');
  assert.equal(row.notified_at, null, 'overall not stamped while a recipient is owed');

  // Retry: only the org email is resent.
  const resent = [];
  const summary2 = await sendPendingSpeakerAwardNotifications({
    db, send: async (msg) => { resent.push(msg); return { success: true }; },
  });
  assert.equal(resent.length, 1);
  assert.equal(resent[0].to, 'invoices@acme.example');
  assert.equal(summary2.notified, 1);
  assert.ok(row.notified_at);
});

test('all sends failing releases every lease and leaves grant retryable', async () => {
  const row = baseGrant();
  const db = makeFakeDb(standardTables(row));
  const summary = await sendPendingSpeakerAwardNotifications({
    db, send: async () => ({ success: false, error: 'mailgun down' }),
  });
  assert.equal(summary.notified, 0);
  assert.equal(summary.failed, 1);
  assert.equal(row.member_notified_at, null);
  assert.equal(row.org_notified_at, null);
  assert.equal(row.member_notify_lease_at, null);
  assert.equal(row.org_notify_lease_at, null);
  assert.equal(row.notified_at, null);
});

test('a live lease held by another worker is skipped and NOT treated as delivered', async () => {
  const sent = [];
  // Worker A holds a fresh (unexpired) lease on the org email and has not
  // sent yet; worker B (this run) delivers the member email.
  const row = baseGrant({ org_notify_lease_at: new Date().toISOString() });
  const db = makeFakeDb(standardTables(row));
  const summary = await sendPendingSpeakerAwardNotifications({
    db, send: async (msg) => { sent.push(msg); return { success: true }; },
  });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'ada@example.com');
  assert.ok(row.member_notified_at);
  assert.equal(row.org_notified_at, null);
  assert.equal(row.notified_at, null, 'must not stamp overall done off another worker\'s lease');
  assert.equal(summary.failed, 0, 'not a failure — the other worker owns the send');

  // Worker A then crashes without sending: after the lease expires the sweep
  // recovers the abandoned claim and delivers the org email.
  row.org_notify_lease_at = new Date(Date.now() - LEASE_TTL_MS - 60_000).toISOString();
  const recovered = [];
  const summary2 = await sendPendingSpeakerAwardNotifications({
    db, send: async (msg) => { recovered.push(msg); return { success: true }; },
  });
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].to, 'invoices@acme.example');
  assert.equal(summary2.notified, 1);
  assert.ok(row.org_notified_at && row.notified_at);
});

test('stale (abandoned) lease is stolen via CAS on its exact value', async () => {
  const staleLease = new Date(Date.now() - LEASE_TTL_MS - 60_000).toISOString();
  const row = baseGrant({
    member_notified_at: '2026-08-01T00:00:00Z',
    org_notify_lease_at: staleLease,
  });
  const sent = [];
  const log = [];
  const db = makeFakeDb(standardTables(row), log);
  const summary = await sendPendingSpeakerAwardNotifications({
    db, send: async (msg) => { sent.push(msg); return { success: true }; },
  });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'invoices@acme.example');
  assert.equal(summary.notified, 1);
  assert.ok(row.notified_at);
  const steal = log.find(l => l.table === 'speaker_award_grant' && l.mode === 'update' && l.filters.org_notify_lease_at === staleLease);
  assert.ok(steal, 'steal must CAS against the exact stale lease value');
});

test('lease theft while original send is in flight: original stamp never clobbers thief lease, thief skips delivered recipient', async () => {
  // Single-recipient (badge-only) grant. The THIEF (this sweep) steals a
  // stale lease. Mid-send (inside the send callback) we simulate the
  // ORIGINAL worker's slow send finally completing: it stamps delivery
  // (CAS on IS NULL) and CAS-releases ITS old lease value.
  const staleLease = new Date(Date.now() - LEASE_TTL_MS - 60_000).toISOString();
  const row = baseGrant({
    voucher_id: null, voucher_value: null, organization_id: null,
    member_notify_lease_at: staleLease,
  });
  const tables = standardTables(row);
  const grants = tables.speaker_award_grant;
  const db = makeFakeDb(tables);
  let leaseDuringOriginalFinish = null;
  const summary = await sendPendingSpeakerAwardNotifications({
    db,
    send: async () => {
      // Original worker finishes now, using the FIXED semantics:
      grants.update({ member_notified_at: '2026-08-03T10:00:00Z' }, { id: row.id, 'member_notified_at is': null });
      grants.update({ member_notify_lease_at: null }, { id: row.id, member_notify_lease_at: staleLease }); // CAS on its OWN old value
      leaseDuringOriginalFinish = row.member_notify_lease_at;
      return { success: true }; // thief's duplicate send also lands (at-least-once)
    },
  });
  // The original's CAS release must NOT have cleared the thief's newer lease.
  assert.ok(leaseDuringOriginalFinish, 'thief lease survives the original worker completion');
  // Thief's stamp is a no-op (IS NULL CAS), original's stamp stands.
  assert.equal(row.member_notified_at, '2026-08-03T10:00:00Z');
  // Thief released its own lease afterwards; grant fully settled.
  assert.equal(row.member_notify_lease_at, null);
  assert.ok(row.notified_at);
  assert.equal(summary.failed, 0);
});

test('post-acquire recheck: never sends when delivery was stamped after the sweep read', async () => {
  const row = baseGrant({ voucher_id: null, voucher_value: null, organization_id: null });
  const tables = standardTables(row);
  const snapshot = { ...row }; // stale sweep read: delivered still null
  const realSelect = tables.speaker_award_grant.select;
  tables.speaker_award_grant.select = (filters) => (filters.id ? realSelect(filters) : [snapshot]);
  // Another worker delivers between the sweep read and our lease acquisition.
  row.member_notified_at = '2026-08-03T09:00:00Z';
  const sent = [];
  const db = makeFakeDb(tables);
  const summary = await sendPendingSpeakerAwardNotifications({
    db, send: async (msg) => { sent.push(msg); return { success: true }; },
  });
  assert.equal(sent.length, 0, 'recheck must prevent a duplicate send');
  assert.equal(row.member_notify_lease_at, null, 'our lease released');
  assert.ok(row.notified_at, 'grant settled off the existing delivery stamp');
  assert.equal(summary.failed, 0);
});

test('crash after send but before delivery stamp resends after lease expiry (at-least-once)', async () => {
  // Simulated aftermath: email went out, worker died before stamping
  // member_notified_at — all that remains is a now-stale lease.
  const row = baseGrant({
    voucher_id: null, voucher_value: null, organization_id: null, // badge-only, single recipient
    member_notify_lease_at: new Date(Date.now() - LEASE_TTL_MS - 1000).toISOString(),
  });
  const sent = [];
  const db = makeFakeDb(standardTables(row));
  const summary = await sendPendingSpeakerAwardNotifications({
    db, send: async (msg) => { sent.push(msg); return { success: true }; },
  });
  assert.equal(sent.length, 1, 'owed email is resent, never lost');
  assert.equal(summary.notified, 1);
  assert.ok(row.member_notified_at && row.notified_at);
});

test('sweep works for complex_event grants (event fetched from complex_event table)', async () => {
  const sent = [];
  const row = baseGrant({ event_type: 'complex_event', event_id: 'ce1' });
  const tables = standardTables(row);
  delete tables.event;
  tables.complex_event = { select: () => [{ id: 'ce1', tenant_id: 't1', title: 'Big Conference' }] };
  const db = makeFakeDb(tables);
  const summary = await sendPendingSpeakerAwardNotifications({
    db, send: async (msg) => { sent.push(msg); return { success: true }; },
  });
  assert.equal(summary.notified, 1);
  assert.match(sent[0].subject, /Big Conference/);
});

test('badge-only grant emails only the member, no voucher wording', async () => {
  const sent = [];
  const row = baseGrant({ voucher_id: null, voucher_value: null, organization_id: null });
  const db = makeFakeDb(standardTables(row));
  const summary = await sendPendingSpeakerAwardNotifications({
    db, send: async (msg) => { sent.push(msg); return { success: true }; },
  });
  assert.equal(summary.notified, 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'ada@example.com');
  assert.match(sent[0].html, /Speaker 2026/);
  assert.doesNotMatch(sent[0].html, /voucher/i);
  assert.ok(row.notified_at && !row.org_notified_at);
});

test('billing contact falls back to primary contact when invoicing_email missing', async () => {
  const sent = [];
  const row = baseGrant();
  const tables = standardTables(row);
  tables.organization = { select: () => [{ id: 'o1', name: 'Acme Ltd', invoicing_email: null }] };
  const db = makeFakeDb(tables);
  await sendPendingSpeakerAwardNotifications({
    db, send: async (msg) => { sent.push(msg); return { success: true }; },
  });
  assert.equal(sent.length, 2);
  assert.equal(sent[1].to, 'billing@org.example');
});

test('voucher lookup error fails the attempt and leaves grant retryable (never falsely notified)', async () => {
  const row = baseGrant({ badge_id: null, member_badge_id: null }); // voucher-only
  const tables = standardTables(row);
  let failOnce = true;
  const realVoucher = tables.voucher.select;
  tables.voucher.select = (filters) => {
    if (failOnce) { failOnce = false; throw new Error('transient read outage'); }
    return realVoucher(filters);
  };
  const db = makeFakeDb(tables);
  const summary = await sendPendingSpeakerAwardNotifications({
    db, send: async () => { throw new Error('should not send during outage'); },
  });
  assert.equal(summary.notified, 0);
  assert.equal(summary.failed, 1);
  assert.equal(row.notified_at, null, 'must stay unnotified so the sweep retries');

  // Outage over: next sweep delivers.
  const sent = [];
  const summary2 = await sendPendingSpeakerAwardNotifications({
    db, send: async (msg) => { sent.push(msg); return { success: true }; },
  });
  assert.equal(summary2.notified, 1);
  assert.equal(sent.length, 2); // member + org billing
  assert.ok(row.notified_at);
});

test('badge lookup error fails the attempt and leaves grant retryable', async () => {
  const row = baseGrant({ voucher_id: null, voucher_value: null, organization_id: null }); // badge-only
  const tables = standardTables(row);
  let failOnce = true;
  const realBadge = tables.badge.select;
  tables.badge.select = (filters) => {
    if (failOnce) { failOnce = false; throw new Error('transient read outage'); }
    return realBadge(filters);
  };
  const db = makeFakeDb(tables);
  const summary = await sendPendingSpeakerAwardNotifications({
    db, send: async () => { throw new Error('should not send during outage'); },
  });
  assert.equal(summary.failed, 1);
  assert.equal(row.notified_at, null);

  const sent = [];
  const summary2 = await sendPendingSpeakerAwardNotifications({
    db, send: async (msg) => { sent.push(msg); return { success: true }; },
  });
  assert.equal(summary2.notified, 1);
  assert.equal(sent.length, 1);
  assert.ok(row.notified_at);
});

test('member lookup error on a badge-only grant is retryable, not "no recipients"', async () => {
  const row = baseGrant({ voucher_id: null, voucher_value: null, organization_id: null });
  const tables = standardTables(row);
  tables.member = { select: () => { throw new Error('transient read outage'); } };
  const db = makeFakeDb(tables);
  const summary = await sendPendingSpeakerAwardNotifications({
    db, send: async () => { throw new Error('should not send'); },
  });
  assert.equal(summary.failed, 1);
  assert.equal(row.notified_at, null);
});

test('no resolvable recipients stamps notified_at (no infinite retries)', async () => {
  const row = baseGrant({ member_id: null });
  const tables = standardTables(row);
  tables.member = { select: () => [] };
  tables.organization = { select: () => [{ id: 'o1', name: 'Acme Ltd', invoicing_email: null }] };
  const db = makeFakeDb(tables);
  const summary = await sendPendingSpeakerAwardNotifications({
    db, send: async () => { throw new Error('should not send'); },
  });
  assert.equal(summary.notified, 0);
  assert.equal(summary.failed, 0);
  assert.ok(row.notified_at, 'stamped so it never re-enters the sweep');
});
