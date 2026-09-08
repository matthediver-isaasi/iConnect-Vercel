import test from 'node:test';
import assert from 'node:assert/strict';
import { grantSpeakerAwardsForEvent } from './speakerAwards.js';

function makeGrantDb(seed = {}) {
  const tables = {
    member: [...(seed.member || [])],
    organization: [...(seed.organization || [])],
    speaker_award_grant: [...(seed.speaker_award_grant || [])],
    voucher: [...(seed.voucher || [])],
    member_badge: [...(seed.member_badge || [])],
    badge: [...(seed.badge || [])],
  };
  let nextId = 1;
  const failures = seed.failures || {};

  function matches(row, filters) {
    return Object.entries(filters).every(([key, value]) => {
      if (key.endsWith(' is')) return row[key.slice(0, -3)] === value;
      if (key.endsWith(' in')) return value.includes(row[key.slice(0, -3)]);
      return row[key] === value;
    });
  }

  return {
    tables,
    from(table) {
      const filters = {};
      let mode = 'select';
      let values = null;
      const chain = {
        select() { return chain; },
        eq(col, value) { filters[col] = value; return chain; },
        is(col, value) { filters[`${col} is`] = value; return chain; },
        in(col, value) { filters[`${col} in`] = value; return chain; },
        or() { return chain; },
        insert(input) { mode = 'insert'; values = input; return chain; },
        update(input) { mode = 'update'; values = input; return chain; },
        async single() { return run(true); },
        async maybeSingle() { return run(true, true); },
        then(resolve, reject) { return Promise.resolve(run()).then(resolve, reject); },
      };

      function run(single = false, maybe = false) {
        const rows = tables[table] || [];
        if (mode === 'select') {
          const found = rows.filter(row => matches(row, filters)).map(row => ({ ...row }));
          if (single && found.length === 0 && !maybe) return { data: null, error: { message: 'not found' } };
          return { data: single ? (found[0] || null) : found, error: null };
        }
        if (mode === 'insert') {
          if (failures[`${table}.insert`]) return { data: null, error: failures[`${table}.insert`] };
          if (table === 'speaker_award_grant') {
            const duplicate = rows.find(row =>
              row.event_type === values.event_type && row.event_id === values.event_id && row.speaker_id === values.speaker_id
            );
            if (duplicate) return { data: null, error: { code: '23505', message: 'duplicate' } };
          }
          if (table === 'member_badge') {
            const duplicate = rows.find(row => row.badge_id === values.badge_id && row.member_id === values.member_id);
            if (duplicate) return { data: null, error: { code: '23505', message: 'duplicate' } };
          }
          const row = { id: `${table}-${nextId++}`, ...values };
          rows.push(row);
          return { data: single ? { ...row } : [{ ...row }], error: null };
        }
        if (failures[`${table}.update`]) return { data: null, error: failures[`${table}.update`] };
        const changed = rows.filter(row => matches(row, filters));
        changed.forEach(row => Object.assign(row, values));
        return { data: single ? (changed[0] || null) : changed.map(row => ({ ...row })), error: null };
      }
      return chain;
    },
  };
}

const event = {
  id: 'e1',
  tenant_id: 't1',
  title: 'Annual Summit',
  speaker_award_config: {
    enabled: true,
    default: { voucher_value: 100, voucher_expiry: '2027-01-31', badge_id: 'b1' },
    overrides: {},
  },
};

test('grant path creates the configured voucher and badge then records a deterministic result', async () => {
  const db = makeGrantDb({
    member: [{ id: 'm1', tenant_id: 't1', email: 'speaker@example.com', organization_id: 'o1' }],
    organization: [{ id: 'o1', name: 'Org' }],
    badge: [{ id: 'b1', tenant_id: 't1' }],
  });
  const results = await grantSpeakerAwardsForEvent(db, {
    eventType: 'event',
    event,
    speakers: [{ id: 's1', full_name: 'Speaker One', email: null, member_id: 'm1' }],
    now: new Date('2026-09-08T10:00:00Z'),
  });
  assert.equal(results[0].status, 'granted');
  assert.equal(db.tables.voucher.length, 1);
  assert.equal(db.tables.voucher[0].organization_id, 'o1');
  assert.equal(db.tables.voucher[0].value, 100);
  assert.equal(db.tables.voucher[0].expires_at, '2027-01-31');
  assert.match(db.tables.voucher[0].code, /^SPK-/);
  assert.equal(db.tables.member_badge.length, 1);
  assert.equal(db.tables.speaker_award_grant[0].status, 'granted');
  assert.ok(db.tables.speaker_award_grant[0].voucher_id);
  assert.ok(db.tables.speaker_award_grant[0].member_badge_id);
});

test('unresolved and excluded speakers record final skipped outcomes without side effects', async () => {
  const db = makeGrantDb({ badge: [{ id: 'b1', tenant_id: 't1' }] });
  const configured = {
    ...event,
    speaker_award_config: {
      ...event.speaker_award_config,
      overrides: { excluded: { excluded: true } },
    },
  };
  const results = await grantSpeakerAwardsForEvent(db, {
    eventType: 'complex_event',
    event: configured,
    speakers: [
      { id: 'missing', full_name: 'Missing Member', email: 'missing@example.com' },
      { id: 'excluded', full_name: 'Excluded Speaker', email: 'excluded@example.com' },
    ],
  });
  assert.deepEqual(results.map(row => row.status), ['skipped_no_member', 'skipped_excluded']);
  assert.equal(db.tables.voucher.length, 0);
  assert.equal(db.tables.member_badge.length, 0);
});

test('a foreign-tenant badge is never assigned to the member', async () => {
  const db = makeGrantDb({
    member: [{ id: 'm1', tenant_id: 't1', organization_id: null }],
    badge: [{ id: 'b1', tenant_id: 'foreign' }],
  });
  const results = await grantSpeakerAwardsForEvent(db, {
    eventType: 'event',
    event: {
      ...event,
      speaker_award_config: { enabled: true, default: { badge_id: 'b1' }, overrides: {} },
    },
    speakers: [{ id: 's1', member_id: 'm1' }],
  });
  assert.equal(results[0].status, 'skipped_no_award');
  assert.equal(db.tables.member_badge.length, 0);
  assert.equal(db.tables.speaker_award_grant[0].badge_id, null);
  assert.match(db.tables.speaker_award_grant[0].detail, /badge not found for tenant/i);
});

test('a failed voucher creation leaves the grant pending for a later run', async () => {
  const db = makeGrantDb({
    member: [{ id: 'm1', tenant_id: 't1', organization_id: 'o1' }],
    organization: [{ id: 'o1', name: 'Org' }],
    failures: { 'voucher.insert': { message: 'temporary outage' } },
  });
  const results = await grantSpeakerAwardsForEvent(db, {
    eventType: 'event',
    event: { ...event, speaker_award_config: { enabled: true, default: { voucher_value: 100, voucher_expiry: '2027-01-31' } } },
    speakers: [{ id: 's1', member_id: 'm1' }],
  });
  assert.equal(results[0].status, 'pending');
  assert.equal(db.tables.speaker_award_grant[0].status, 'pending');
  assert.match(db.tables.speaker_award_grant[0].detail, /will retry/);
});

test('a duplicate claim retries the existing pending grant without creating a second award row', async () => {
  const db = makeGrantDb({
    member: [{ id: 'm1', tenant_id: 't1', organization_id: 'o1' }],
    organization: [{ id: 'o1', name: 'Org' }],
    speaker_award_grant: [{
      id: 'grant-existing', tenant_id: 't1', event_type: 'event', event_id: 'e1',
      speaker_id: 's1', status: 'pending', voucher_value: 100, organization_id: 'o1',
      voucher_id: null, badge_id: null, member_badge_id: null, member_id: 'm1', detail: null,
    }],
  });
  const results = await grantSpeakerAwardsForEvent(db, {
    eventType: 'event',
    event: { ...event, speaker_award_config: { enabled: true, default: { voucher_value: 100, voucher_expiry: '2027-01-31' } } },
    speakers: [{ id: 's1', member_id: 'm1' }],
  });
  assert.equal(results[0].status, 'granted');
  assert.equal(db.tables.speaker_award_grant.length, 1);
  assert.equal(db.tables.voucher.length, 1);
});

test('a duplicate pending claim cannot fulfil a foreign-tenant badge', async () => {
  const db = makeGrantDb({
    member: [{ id: 'm1', tenant_id: 't1' }],
    badge: [{ id: 'foreign-badge', tenant_id: 'foreign' }],
    speaker_award_grant: [{
      id: 'grant-existing', tenant_id: 't1', event_type: 'event', event_id: 'e1',
      speaker_id: 's1', status: 'pending', voucher_value: null, organization_id: null,
      voucher_id: null, badge_id: 'foreign-badge', member_badge_id: null,
      member_id: 'm1', detail: null,
    }],
  });
  const results = await grantSpeakerAwardsForEvent(db, {
    eventType: 'event',
    event: {
      ...event,
      speaker_award_config: { enabled: true, default: { badge_id: 'foreign-badge' } },
    },
    speakers: [{ id: 's1', member_id: 'm1' }],
  });
  assert.equal(results[0].status, 'skipped_no_award');
  assert.equal(db.tables.member_badge.length, 0);
  assert.equal(db.tables.speaker_award_grant[0].badge_id, null);
});

test('the stale pending sweep cannot fulfil a foreign-tenant badge', async () => {
  const db = makeGrantDb({
    badge: [{ id: 'foreign-badge', tenant_id: 'foreign' }],
    speaker_award_grant: [{
      id: 'grant-stale', tenant_id: 't1', event_type: 'event', event_id: 'e1',
      speaker_id: 'removed-speaker', speaker_name: 'Removed', status: 'pending',
      voucher_value: null, organization_id: null, voucher_id: null,
      badge_id: 'foreign-badge', member_badge_id: null, member_id: 'm1', detail: null,
    }],
  });
  const results = await grantSpeakerAwardsForEvent(db, {
    eventType: 'event',
    event: {
      ...event,
      speaker_award_config: { enabled: true, default: { badge_id: 'foreign-badge' } },
    },
    speakers: [],
  });
  assert.equal(results[0].status, 'skipped_no_award');
  assert.equal(db.tables.member_badge.length, 0);
  assert.equal(db.tables.speaker_award_grant[0].badge_id, null);
});