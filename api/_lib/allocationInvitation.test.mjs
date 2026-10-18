import assert from 'node:assert/strict';
import test from 'node:test';
import {
  claimAllocationInvitation,
  createAllocationInviteToken,
  hashAllocationInviteToken,
  getPublicAllocationInvitationContext,
  reserveAllocationInvitation,
} from './allocationInvitation.js';
process.env.SESSION_SECRET = 'test-only-session-secret-at-least-32-bytes';

const tenantId = '00000000-0000-4000-8000-000000000001';
const allocationId = '10000000-0000-4000-8000-000000000001';
const actorId = '20000000-0000-4000-8000-000000000001';

test('allocation invite tokens have sufficient entropy and only hashes reach RPCs', async () => {
  const token = createAllocationInviteToken();
  assert.ok(token.length >= 43);
  assert.equal(hashAllocationInviteToken(token).length, 64);
  assert.notEqual(hashAllocationInviteToken(token), token);

  const calls = [];
  const db = {
    async rpc(name, args) {
      calls.push([name, args]);
      return { data: { invitationId: 'invite-1' }, error: null };
    },
  };
  const result = await reserveAllocationInvitation(
    db,
    tenantId,
    allocationId,
    { actorType: 'member', actorId },
    {
      email: ' Delegate@Example.com ',
      firstName: 'Del',
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
      idempotencyKey: 'invite-once',
    },
  );
  assert.ok(result.token);
  assert.equal(calls[0][0], 'reserve_sales_allocation_invitation');
  assert.equal(calls[0][1].p_delegate_email, 'delegate@example.com');
  assert.equal(calls[0][1].p_token_hash, hashAllocationInviteToken(result.token));
  assert.equal(JSON.stringify(calls[0][1]).includes(result.token), false);
});

test('reservation retries return the same usable token without cross-actor replay', async () => {
  const calls = [];
  const db = { rpc: async (name, args) => {
    calls.push(args);
    return { data: { invitationId: 'same-invite', replayed: calls.length > 1 }, error: null };
  } };
  const input = {
    email: 'delegate@example.com',
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
    idempotencyKey: 'same-request',
  };
  const actor = { actorType: 'tenant_user', actorId };
  const first = await reserveAllocationInvitation(db, tenantId, allocationId, actor, input);
  const retry = await reserveAllocationInvitation(db, tenantId, allocationId, actor, input);
  const otherActor = await reserveAllocationInvitation(
    db, tenantId, allocationId, { ...actor, actorId: '30000000-0000-4000-8000-000000000001' }, input,
  );
  assert.equal(first.token, retry.token);
  assert.notEqual(first.token, otherActor.token);
  assert.equal(calls[0].p_token_hash, calls[1].p_token_hash);
  assert.notEqual(calls[0].p_token_hash, calls[2].p_token_hash);
});

test('claim hashes opaque token and fixes booking kind and id in RPC boundary', async () => {
  const calls = [];
  const db = {
    async rpc(name, args) {
      calls.push([name, args]);
      return { data: { claimed: true }, error: null };
    },
  };
  const token = createAllocationInviteToken();
  const result = await claimAllocationInvitation(db, token, 'complex', 'booking-1');
  assert.equal(result.claimed, true);
  assert.deepEqual(calls[0], ['claim_sales_allocation_invitation', {
    p_token_hash: hashAllocationInviteToken(token),
    p_booking_kind: 'complex',
    p_booking_id: 'booking-1',
  }]);
});

test('short or oversized invite tokens fail before database access', () => {
  assert.throws(() => hashAllocationInviteToken('short'), /Invalid allocation invitation token/);
  assert.throws(() => hashAllocationInviteToken('x'.repeat(513)), /Invalid allocation invitation token/);
});

function contextDatabase({ eventKind = 'complex', missing = false, malformed = false, invalidToken = false, stringPricing = false } = {}) {
  const context = {
    tenantId, allocationId, eventKind, eventId: 'event-1', ticketTypeId: 'purchased-ticket',
    organizationId: 'org-1', delegateEmail: 'delegate@example.test',
  };
  const ticket = {
    id: context.ticketTypeId, tenant_id: tenantId, complex_event_id: context.eventId,
    name: 'Private purchased ticket', audience_mode: 'selected_members',
    selected_member_ids: [actorId], private_ticket_eligible: true,
    price: 75, currency: 'gbp', is_group_ticket: true, group_size: 4,
    all_tracks: false, linked_track_ids: ['track-1'], release_at: '2099-01-01T00:00:00Z',
    release_timezone: 'UTC', internal_note: 'never disclose', role_ids: ['role-private'],
    member_group_ids: ['group-private'], new_member_role_id: 'role-private',
  };
  let pricing = { ticket_classes: missing ? [] : [ticket, {
    ...ticket, id: 'another-ticket', name: 'Another private ticket', selected_member_ids: ['other-member-secret'],
  }] };
  if (stringPricing) pricing = JSON.stringify(pricing);
  if (malformed) pricing = '{invalid';
  const rows = {
    sales_commercial_allocation_totals: [{ tenant_id: tenantId, allocation_id: allocationId, allocated: 4, named: 1, reserved: 1, remaining: 4 }],
    organization: [{ tenant_id: tenantId, id: 'org-1', name: 'Organisation' }],
    event: [{ id: 'event-1', tenant_id: tenantId, title: 'Event', slug: 'event', pricing_config: pricing }],
    complex_event: [{ id: 'event-1', tenant_id: tenantId, title: 'Event', slug: 'event' }],
    complex_event_ticket_class: missing ? [] : [ticket, { ...ticket, id: 'another-ticket' },
      { ...ticket, id: 'wrong-event', complex_event_id: 'other-event' }],
  };
  const calls = [];
  return { ticket, context, calls,
    async rpc(name, args) {
      calls.push({ rpc: name, args });
      return invalidToken ? { error: { code: 'P0002', message: 'Invitation not found' }, data: null }
        : { data: context, error: null };
    },
    from(table) {
      const filters = [];
      const call = { table, filters: [] }; calls.push(call);
      return { select(fields) { call.select = fields; return this; },
        eq(key, value) { call.filters.push([key, value]); filters.push(row => row[key] === value); return this; },
        async maybeSingle() { return { data: (rows[table] || []).find(row => filters.every(filter => filter(row))) || null, error: null }; },
      };
    },
  };
}

for (const eventKind of ['simple', 'complex']) {
  test(`${eventKind} invitation exposes only its exact purchased redacted ticket, never private member eligibility`, async () => {
    const db = contextDatabase({ eventKind, stringPricing: eventKind === 'simple' });
    const token = 'opaque-invitation-token-at-least-32-characters';
    const result = await getPublicAllocationInvitationContext(db, token);
    assert.equal(result.ticketTypeId, 'purchased-ticket');
    assert.equal(result.ticketName, 'Private purchased ticket');
    assert.equal(result.ticket_class.id, result.ticketTypeId);
    assert.equal(result.ticket_class.audience_mode, 'selected_members');
    assert.equal(result.ticket_class.allocation_ticket_eligible, true);
    assert.equal(result.ticket_class.private_ticket_eligible, undefined);
    assert.equal(result.ticket_class.price, 75);
    assert.equal(result.ticket_class.group_size, 4);
    assert.deepEqual(result.ticket_class.linked_track_ids, ['track-1']);
    assert.equal(result.ticket_class.release_at, '2099-01-01T00:00:00Z');
    for (const secret of ['selected_member_ids', actorId, 'another-ticket', 'other-member-secret',
      'internal_note', 'role_ids', 'member_group_ids', 'new_member_role_id', token]) {
      assert.equal(JSON.stringify(result).includes(secret), false, secret);
    }
    for (const call of db.calls.filter(call => call.table)) {
      assert.ok(call.filters.some(([key, value]) => key === 'tenant_id' && value === tenantId), call.table);
    }
    if (eventKind === 'complex') {
      const query = db.calls.find(call => call.table === 'complex_event_ticket_class');
      assert.ok(query.filters.some(([key, value]) => key === 'complex_event_id' && value === 'event-1'));
      assert.ok(query.filters.some(([key, value]) => key === 'id' && value === 'purchased-ticket'));
    }
    assert.equal(result.totals.available_places, 2);
  });
  test(`${eventKind} missing purchased ticket fails closed instead of substituting another ticket`, async () => {
    await assert.rejects(getPublicAllocationInvitationContext(contextDatabase({ eventKind, missing: true }), 'x'.repeat(40)),
      /purchased allocation ticket is unavailable/);
  });
}

test('invalid allocation token cannot reach ticket reads and malformed simple pricing fails explicitly', async () => {
  const db = contextDatabase({ invalidToken: true });
  await assert.rejects(getPublicAllocationInvitationContext(db, 'x'.repeat(40)), /Invitation not found/);
  assert.equal(db.calls.filter(call => call.table).length, 0);
  await assert.rejects(getPublicAllocationInvitationContext(contextDatabase({ eventKind: 'simple', malformed: true }), 'x'.repeat(40)),
    /Unable to verify allocation ticket/);
});