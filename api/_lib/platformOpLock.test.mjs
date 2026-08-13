import test from 'node:test';
import assert from 'node:assert/strict';
import { acquirePlatformOpLock } from './platformOpLock.js';

function stubSupabase(rpcImpl) {
  return { rpc: rpcImpl };
}

test('acquire returns ok with a working release on success', async () => {
  const calls = [];
  const sb = stubSupabase(async (fn, args) => {
    calls.push([fn, args]);
    if (fn === 'acquire_platform_op_lock') return { data: { acquired: true }, error: null };
    if (fn === 'release_platform_op_lock') return { data: true, error: null };
    throw new Error('unexpected rpc ' + fn);
  });
  const lock = await acquirePlatformOpLock(sb, 'demo-tenant:aesp', { action: 'seed' }, 600);
  assert.equal(lock.ok, true);
  assert.ok(lock.token && lock.token.length === 32, 'random hex token');
  assert.equal(await lock.release(), true);
  const [acqFn, acqArgs] = calls[0];
  assert.equal(acqFn, 'acquire_platform_op_lock');
  assert.equal(acqArgs.p_key, 'demo-tenant:aesp');
  assert.equal(acqArgs.p_ttl_seconds, 600);
  const [relFn, relArgs] = calls[1];
  assert.equal(relFn, 'release_platform_op_lock');
  assert.equal(relArgs.p_token, acqArgs.p_token, 'release uses the same owned token');
});

test('acquire reports current holder when the lease is taken', async () => {
  const sb = stubSupabase(async () => ({
    data: { acquired: false, holder_info: { action: 'reset', ownerEmail: 'a@b.c' }, expires_at: '2026-01-01T00:00:00Z' },
    error: null,
  }));
  const lock = await acquirePlatformOpLock(sb, 'demo-tenant:aesp', {}, 600);
  assert.equal(lock.ok, false);
  assert.equal(lock.error, undefined, 'a held lease is not an error');
  assert.deepEqual(lock.holder, { action: 'reset', ownerEmail: 'a@b.c' });
  assert.equal(lock.expiresAt, '2026-01-01T00:00:00Z');
});

test('acquire fails CLOSED when the RPC errors', async () => {
  const sb = stubSupabase(async () => ({ data: null, error: { message: 'function does not exist' } }));
  const lock = await acquirePlatformOpLock(sb, 'demo-tenant:aesp', {}, 600);
  assert.equal(lock.ok, false);
  assert.match(lock.error, /Lock acquisition failed/);
});

test('release failure is reported (TTL still bounds the lease)', async () => {
  const sb = stubSupabase(async (fn) => {
    if (fn === 'acquire_platform_op_lock') return { data: { acquired: true }, error: null };
    return { data: null, error: { message: 'network' } };
  });
  const lock = await acquirePlatformOpLock(sb, 'k', {}, 600);
  assert.equal(await lock.release(), false);
});

test('two racing acquirers get distinct tokens; only the winner proceeds', async () => {
  // Simulate the DB's atomicity: first token in wins, second observes holder.
  let holderToken = null;
  const sb = stubSupabase(async (fn, args) => {
    if (fn === 'acquire_platform_op_lock') {
      if (holderToken === null || holderToken === args.p_token) {
        holderToken = args.p_token;
        return { data: { acquired: true }, error: null };
      }
      return { data: { acquired: false, holder_info: args.p_info }, error: null };
    }
    if (fn === 'release_platform_op_lock') {
      if (holderToken === args.p_token) { holderToken = null; return { data: true, error: null }; }
      return { data: false, error: null }; // wrong token releases nothing
    }
  });
  const [a, b] = await Promise.all([
    acquirePlatformOpLock(sb, 'k', { n: 1 }, 600),
    acquirePlatformOpLock(sb, 'k', { n: 2 }, 600),
  ]);
  assert.equal(a.ok !== b.ok, true, 'exactly one wins');
  const winner = a.ok ? a : b;
  const loser = a.ok ? b : a;
  assert.notEqual(winner.token, undefined);
  assert.equal(loser.token, undefined);
  await winner.release();
  assert.equal(holderToken, null, 'winner release clears the lease');
});
