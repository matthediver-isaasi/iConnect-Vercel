import test from 'node:test';
import assert from 'node:assert/strict';
import {
  grantSpeakerAwardsForEvent,
  normalizeSpeakerAwardConfig,
  reconcileAssignmentSpeakerBadges,
} from './speakerAwards.js';

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
      if (key.endsWith(' is')) return value === null
        ? row[key.slice(0, -3)] == null
        : row[key.slice(0, -3)] === value;
      if (key.endsWith(' in')) return value.includes(row[key.slice(0, -3)]);
      return row[key] === value;
    });
  }

  return {
    tables,
    async rpc(name, args) {
      if (name !== 'reactivate_speaker_award_grant') return { data: null, error: { message: 'unexpected rpc' } };
      const grant = tables.speaker_award_grant.find(row => row.id === args.p_grant_id && row.tenant_id === args.p_tenant_id);
      if (!grant) return { data: null, error: { message: 'not found' } };
      const mayOpen = ['cancelled', 'skipped_no_member', 'skipped_no_award', 'skipped_excluded'].includes(grant.status)
        || (grant.status === 'granted' && !grant.voucher_id && args.p_voucher_value != null);
      if (!mayOpen) return { data: { ...grant }, error: null };
      const active = tables.member_badge.find(row => row.id === grant.member_badge_id
        && row.revoked_at == null && row.member_id === args.p_member_id && row.badge_id === args.p_badge_id);
      Object.assign(grant, {
        status: 'pending', member_id: args.p_member_id,
        organization_id: grant.voucher_id ? grant.organization_id : args.p_organization_id,
        badge_id: args.p_badge_id,
        voucher_value: grant.voucher_id ? grant.voucher_value : args.p_voucher_value,
        member_badge_id: active?.id || null,
        removal_reconciled_at: null, removal_revoke_requested: null,
      });
      return { data: { ...grant }, error: null };
    },
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
            const duplicate = rows.find(row => row.badge_id === values.badge_id
              && row.member_id === values.member_id && row.revoked_at == null);
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
  status: 'published',
  event_state: 'active',
  status: 'published',
  event_state: 'active',
  speaker_award_config: {
    enabled: true,
    default: { voucher_value: 100, voucher_expiry: '2027-01-31', badge_id: 'b1' },
    overrides: {},
  },
};

test('badge timing defaults to event_start and only accepts on_assignment', () => {
  assert.equal(normalizeSpeakerAwardConfig({ enabled: true }).badge_timing, 'event_start');
  assert.equal(normalizeSpeakerAwardConfig({ enabled: true, badge_timing: 'on_assignment' }).badge_timing, 'on_assignment');
  assert.equal(normalizeSpeakerAwardConfig({ enabled: true, badge_timing: 'tomorrow' }).badge_timing, 'event_start');
});

test('assignment reconciliation grants badges immediately but leaves vouchers pending', async () => {
  const db = makeGrantDb({
    member: [{ id: 'm1', tenant_id: 't1', organization_id: 'o1' }],
    organization: [{ id: 'o1', name: 'Org', tenant_id: 't1' }],
    badge: [{ id: 'b1', tenant_id: 't1' }],
  });
  const summary = await reconcileAssignmentSpeakerBadges(db, {
    eventType: 'event',
    event: { ...event, speaker_award_config: {
      ...event.speaker_award_config, badge_timing: 'on_assignment',
    } },
    // A duplicate reference is harmless: the grant ledger and active badge
    // constraint ensure there is one award.
    speakers: [{ id: 's1', member_id: 'm1' }, { id: 's1', member_id: 'm1' }],
  });
  assert.equal(summary.timing, 'on_assignment');
  assert.equal(db.tables.member_badge.length, 1);
  assert.equal(db.tables.voucher.length, 0);
  assert.equal(db.tables.speaker_award_grant.length, 1);
  assert.equal(db.tables.speaker_award_grant[0].status, 'pending');
});

test('assignment reconciliation never grants a badge for a draft event', async () => {
  const db = makeGrantDb({
    member: [{ id: 'm1', tenant_id: 't1', organization_id: null }],
    badge: [{ id: 'b1', tenant_id: 't1' }],
  });
  const summary = await reconcileAssignmentSpeakerBadges(db, {
    eventType: 'event',
    event: {
      ...event,
      event_state: 'draft',
      speaker_award_config: {
        ...event.speaker_award_config,
        badge_timing: 'on_assignment',
      },
    },
    speakers: [{ id: 's1', member_id: 'm1' }],
  });
  assert.deepEqual(summary.results, []);
  assert.equal(db.tables.speaker_award_grant.length, 0);
  assert.equal(db.tables.member_badge.length, 0);
});

test('event-start fulfilment later creates deferred voucher for an immediate badge grant', async () => {
  const db = makeGrantDb({
    member: [{ id: 'm1', tenant_id: 't1', organization_id: 'o1' }],
    organization: [{ id: 'o1', name: 'Org', tenant_id: 't1' }],
    badge: [{ id: 'b1', tenant_id: 't1' }],
  });
  const assignmentEvent = { ...event, speaker_award_config: {
    ...event.speaker_award_config, badge_timing: 'on_assignment',
  } };
  const speakers = [{ id: 's1', member_id: 'm1' }];
  await reconcileAssignmentSpeakerBadges(db, { eventType: 'event', event: assignmentEvent, speakers });
  const results = await grantSpeakerAwardsForEvent(db, {
    eventType: 'event', event: assignmentEvent, speakers,
  });
  assert.equal(results[0].status, 'granted');
  assert.equal(db.tables.voucher.length, 1);
  assert.equal(db.tables.member_badge.length, 1);
});

test('event start reopens a granted immediate badge row when member gains an organisation', async () => {
  const db = makeGrantDb({
    member: [{ id: 'm1', tenant_id: 't1', organization_id: null }],
    badge: [{ id: 'b1', tenant_id: 't1' }],
  });
  const assignmentEvent = { ...event, speaker_award_config: {
    ...event.speaker_award_config, badge_timing: 'on_assignment',
  } };
  await reconcileAssignmentSpeakerBadges(db, {
    eventType: 'event', event: assignmentEvent, speakers: [{ id: 's1', member_id: 'm1' }],
  });
  assert.equal(db.tables.speaker_award_grant[0].status, 'granted');
  db.tables.member[0].organization_id = 'o1';
  db.tables.organization.push({ id: 'o1', tenant_id: 't1', name: 'Org' });
  await grantSpeakerAwardsForEvent(db, {
    eventType: 'event', event: assignmentEvent, speakers: [{ id: 's1', member_id: 'm1' }],
  });
  assert.equal(db.tables.voucher.length, 1);
});

test('event start uses voucher config changed after an immediate badge-only grant', async () => {
  const db = makeGrantDb({
    member: [{ id: 'm1', tenant_id: 't1', organization_id: 'o1' }],
    organization: [{ id: 'o1', tenant_id: 't1', name: 'Org' }],
    badge: [{ id: 'b1', tenant_id: 't1' }],
  });
  const badgeOnly = { ...event, speaker_award_config: {
    enabled: true, badge_timing: 'on_assignment', default: { badge_id: 'b1' }, overrides: {},
  } };
  const speakers = [{ id: 's1', member_id: 'm1' }];
  await reconcileAssignmentSpeakerBadges(db, { eventType: 'event', event: badgeOnly, speakers });
  assert.equal(db.tables.speaker_award_grant[0].status, 'granted');
  const changed = { ...badgeOnly, speaker_award_config: {
    ...badgeOnly.speaker_award_config,
    default: { badge_id: 'b1', voucher_value: 75, voucher_expiry: '2027-01-31' },
  } };
  await grantSpeakerAwardsForEvent(db, { eventType: 'event', event: changed, speakers });
  assert.equal(db.tables.voucher[0].value, 75);
});

test('removed pending immediate grant is provenance-safely revoked once only', async () => {
  const db = makeGrantDb({
    member: [{ id: 'm1', tenant_id: 't1', organization_id: 'o1' }],
    badge: [{ id: 'b1', tenant_id: 't1' }],
    speaker_award_grant: [{
      id: 'g1', tenant_id: 't1', event_type: 'event', event_id: 'e1', speaker_id: 's1',
      member_id: 'm1', badge_id: 'b1', member_badge_id: 'mb1', voucher_value: 100,
      organization_id: 'o1', status: 'pending', detail: null,
    }],
    member_badge: [{
      id: 'mb1', tenant_id: 't1', member_id: 'm1', badge_id: 'b1',
      source: 'speaker_award', source_ref: 'event:e1', revoked_at: null,
    }],
  });
  const assignmentEvent = { ...event, speaker_award_config: {
    ...event.speaker_award_config, badge_timing: 'on_assignment',
  } };
  const removeGrant = async (_db, { grantId, revokeRemoved }) => {
    const grant = db.tables.speaker_award_grant.find(row => row.id === grantId);
    if (grant.removal_reconciled_at) return { status: 'already_processed', revoked: false };
    grant.status = 'cancelled';
    grant.removal_reconciled_at = '2026-01-01T00:00:00Z';
    grant.removal_revoke_requested = revokeRemoved;
    if (revokeRemoved) db.tables.member_badge[0].revoked_at = '2026-01-01T00:00:00Z';
    return { status: 'processed', revoked: revokeRemoved };
  };
  const kept = await reconcileAssignmentSpeakerBadges(db, {
    eventType: 'event', event: assignmentEvent, speakers: [], revokeRemoved: false, removeGrant,
  });
  assert.equal(kept.removed, 1);
  assert.equal(db.tables.member_badge[0].revoked_at, null);
  const retry = await reconcileAssignmentSpeakerBadges(db, {
    eventType: 'event', event: assignmentEvent, speakers: [], revokeRemoved: true, removeGrant,
  });
  assert.equal(retry.revoked, 0);
  assert.equal(db.tables.member_badge[0].revoked_at, null);
  await reconcileAssignmentSpeakerBadges(db, {
    eventType: 'event', event: assignmentEvent, speakers: [{ id: 's1', member_id: 'm1' }], removeGrant,
  });
  assert.equal(db.tables.speaker_award_grant[0].status, 'pending');
  assert.equal(db.tables.speaker_award_grant[0].member_badge_id, 'mb1');
});

test('voucher-issued revoked grant can re-add its badge without issuing another voucher', async () => {
  const db = makeGrantDb({
    member: [{ id: 'm1', tenant_id: 't1', organization_id: 'o1' }],
    organization: [{ id: 'o1', tenant_id: 't1', name: 'Org' }],
    badge: [{ id: 'b1', tenant_id: 't1' }],
    voucher: [{ id: 'v1', tenant_id: 't1', code: 'existing' }],
    member_badge: [{
      id: 'old-mb', tenant_id: 't1', member_id: 'm1', badge_id: 'b1',
      source: 'speaker_award', source_ref: 'event:e1', revoked_at: '2026-01-01T00:00:00Z',
    }],
    speaker_award_grant: [{
      id: 'g1', tenant_id: 't1', event_type: 'event', event_id: 'e1', speaker_id: 's1',
      member_id: 'm1', organization_id: 'o1', badge_id: 'b1', member_badge_id: 'old-mb',
      voucher_id: 'v1', voucher_value: 100, status: 'cancelled',
    }],
  });
  await reconcileAssignmentSpeakerBadges(db, {
    eventType: 'event',
    event: { ...event, speaker_award_config: { ...event.speaker_award_config, badge_timing: 'on_assignment' } },
    speakers: [{ id: 's1', member_id: 'm1' }],
  });
  assert.equal(db.tables.voucher.length, 1);
  assert.equal(db.tables.member_badge.filter(row => row.revoked_at == null).length, 1);
  assert.notEqual(db.tables.speaker_award_grant[0].member_badge_id, 'old-mb');
  assert.equal(db.tables.speaker_award_grant[0].status, 'granted');
});

for (const priorStatus of ['skipped_no_member', 'skipped_no_award', 'skipped_excluded']) {
  test(`${priorStatus} is reevaluated from current intent at event start`, async () => {
    const db = makeGrantDb({
      member: [{ id: 'm1', tenant_id: 't1', organization_id: 'o1' }],
      organization: [{ id: 'o1', tenant_id: 't1', name: 'Org' }],
      badge: [{ id: 'b1', tenant_id: 't1' }],
      speaker_award_grant: [{
        id: 'g1', tenant_id: 't1', event_type: 'event', event_id: 'e1', speaker_id: 's1',
        member_id: null, organization_id: null, badge_id: null, member_badge_id: null,
        voucher_id: null, voucher_value: null, status: priorStatus,
      }],
    });
    const results = await grantSpeakerAwardsForEvent(db, {
      eventType: 'event', event, speakers: [{ id: 's1', member_id: 'm1' }],
    });
    assert.equal(results[0].status, 'granted');
    assert.equal(db.tables.voucher.length, 1);
    assert.equal(db.tables.member_badge.length, 1);
  });
}

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

test('the stale pending sweep cancels a removed speaker without fulfilling a foreign-tenant badge', async () => {
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
  assert.equal(results[0].status, 'cancelled');
  assert.equal(db.tables.member_badge.length, 0);
  assert.equal(db.tables.speaker_award_grant[0].badge_id, 'foreign-badge');
});