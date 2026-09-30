import test from 'node:test';
import assert from 'node:assert/strict';
import { createSpeakerAwardReconcileHandler } from './speaker-award-reconcile.js';

function response() {
  return {
    code: null, body: null,
    status(code) { this.code = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

function eventDb(event) {
  return {
    from(table) {
      const filters = {};
      const chain = {
        select() { return chain; },
        eq(key, value) { filters[key] = value; return chain; },
        in() { return chain; },
        maybeSingle: async () => ({
          data: table === (event.type === 'complex_event' ? 'complex_event' : 'event')
            && filters.id === event.id && filters.tenant_id === event.tenant_id ? event : null,
          error: null,
        }),
        then(resolve) {
          if (table === 'speaker') return resolve({ data: [], error: null });
          return resolve({ data: [], error: null });
        },
      };
      return chain;
    },
  };
}

test('reconcile endpoint rejects unauthenticated and non-admin callers', async () => {
  const base = { method: 'POST', body: { event_id: 'e1', event_type: 'event' } };
  let res = response();
  await createSpeakerAwardReconcileHandler({ db: {}, tenantContext: async () => null })(base, res);
  assert.equal(res.code, 401);
  res = response();
  await createSpeakerAwardReconcileHandler({
    db: {}, tenantContext: async () => ({ tenantId: 't1' }), adminAccess: async () => false,
  })(base, res);
  assert.equal(res.code, 403);
});

test('reconcile endpoint validates the event type', async () => {
  const res = response();
  await createSpeakerAwardReconcileHandler({
    db: {}, tenantContext: async () => ({ tenantId: 't1' }), adminAccess: async () => true,
  })({ method: 'POST', body: { event_id: 'e1', event_type: 'wrong' } }, res);
  assert.equal(res.code, 400);
});

test('reconcile endpoint scopes event lookup to tenant and passes remove decision', async () => {
  const calls = [];
  const handler = createSpeakerAwardReconcileHandler({
    db: eventDb({ id: 'e1', type: 'complex_event', tenant_id: 't1', title: 'Event', speaker_award_config: {} }),
    tenantContext: async () => ({ tenantId: 't1', memberId: 'a1' }),
    adminAccess: async () => true,
    collectIds: async (_db, type) => { assert.equal(type, 'complex_event'); return []; },
    reconcile: async (_db, input) => { calls.push(input); return { timing: 'on_assignment', results: [], removed: 1, revoked: 1 }; },
  });
  const res = response();
  await handler({
    method: 'POST',
    body: { action: 'remove', event_id: 'e1', event_type: 'complex_event', speaker_ids: ['untrusted'], revoke_badge: true },
  }, res);
  assert.equal(res.code, 200);
  assert.equal(calls[0].revokeRemoved, true);
  assert.equal(calls[0].event.tenant_id, 't1');
  assert.equal(res.body.revoked, 1);
});

test('reconcile endpoint does not reveal an event from another tenant', async () => {
  const res = response();
  const handler = createSpeakerAwardReconcileHandler({
    db: eventDb({ id: 'e1', type: 'event', tenant_id: 'other', title: 'Other' }),
    tenantContext: async () => ({ tenantId: 't1' }),
    adminAccess: async () => true,
  });
  await handler({ method: 'POST', body: { event_id: 'e1', event_type: 'event' } }, res);
  assert.equal(res.code, 404);
});