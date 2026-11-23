import test from 'node:test';
import assert from 'node:assert/strict';
import { boundedSessionLookup, sessionDatabase } from './sessionAvailability.js';
import { createClient } from '@supabase/supabase-js';

test('a hung lookup fails closed within its budget', async () => {
  await assert.rejects(
    boundedSessionLookup(() => new Promise(() => {}), 5),
    error => error.status === 503 && error.code === 'SESSION_UNAVAILABLE',
  );
  assert.equal(await boundedSessionLookup(() => null), null);
});

function client(fetch) {
  return sessionDatabase(createClient('https://fixture.invalid', 'fixture-key', {
    global: { fetch }, auth: { persistSession: false, autoRefreshToken: false },
  }));
}
const response = () => new Response(JSON.stringify([{ id: 'fixture' }]), {
  status: 200, headers: { 'Content-Type': 'application/json' },
});

test('real Supabase queries receive cancellation and cannot start later queries or writes', async () => {
  const signals = [];
  let afterRead = false;
  const db = client(async (_url, init) => {
    signals.push(init.signal);
    await new Promise(resolve => init.signal.addEventListener('abort', resolve, { once: true }));
    // Simulate a transport returning late even after cancellation.
    return response();
  });
  await assert.rejects(boundedSessionLookup(async () => {
    try { await db.from('session').select('sess'); } catch {}
    // Even a caller that catches a timeout must not start subsequent work.
    await db.from('session').update({ sess: {} }).eq('sid', 'fixture');
    afterRead = true;
  }, 20), { code: 'SESSION_UNAVAILABLE' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(signals.length, 1);
  assert.equal(signals[0].aborted, true);
  assert.equal(afterRead, false);
});

test('nested verification shares the outer signal and deadline', async () => {
  let outerSignal, nestedSignal;
  await assert.rejects(boundedSessionLookup(async signal => {
    outerSignal = signal;
    await boundedSessionLookup(async nested => {
      nestedSignal = nested;
      await new Promise(resolve => nested.addEventListener('abort', resolve, { once: true }));
    }, 5000);
  }, 20), { code: 'SESSION_UNAVAILABLE' });
  assert.equal(outerSignal, nestedSignal);
  assert.equal(nestedSignal.aborted, true);
});

test('successful and concurrent lookups have isolated scopes; ordinary database work is unaffected', async () => {
  const signals = [];
  const db = client(async (_url, init) => { signals.push(init.signal); return response(); });
  await Promise.all([1, 2].map(() => boundedSessionLookup(() => db.from('member').select('id'), 1000)));
  assert.ok(signals[0]);
  assert.notEqual(signals[0], signals[1]);
  assert.equal(signals[0].aborted, false);
  const result = await db.from('member').select('id');
  assert.equal(result.data[0].id, 'fixture');
  assert.equal(signals[2], undefined);
});

test('query stage diagnostics omit filters, credentials and personal data', async () => {
  const logs = [];
  const original = console.warn;
  console.warn = (...args) => logs.push(args);
  try {
    const db = client(async (_url, init) => {
      await new Promise(resolve => init.signal.addEventListener('abort', resolve, { once: true }));
      return response();
    });
    await assert.rejects(boundedSessionLookup(() =>
      db.from('member').select('*').eq('email', 'private@example.invalid'), 20),
    { code: 'SESSION_UNAVAILABLE' });
    assert.equal(logs.length, 1);
    assert.equal(logs[0][1].stage, 'member:select');
    assert.ok(logs[0][1].elapsedMs >= 0);
    assert.equal(JSON.stringify(logs).includes('private@example.invalid'), false);
    assert.equal(JSON.stringify(logs).includes('fixture-key'), false);
  } finally { console.warn = original; }
});
