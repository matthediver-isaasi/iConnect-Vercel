import assert from 'node:assert/strict';
import test from 'node:test';
import {
  claimAllocationInvitation,
  createAllocationInviteToken,
  hashAllocationInviteToken,
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