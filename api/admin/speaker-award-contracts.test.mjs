import test from 'node:test';
import assert from 'node:assert/strict';
import { createSpeakerAwardEligibilityHandler } from './speaker-award-eligibility.js';
import { createSpeakerAwardGrantsHandler } from './speaker-award-grants.js';

function response() {
  return { code: 200, body: null, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
}

function rowsDb(rowsByTable, log = []) {
  return {
    from(table) {
      const filters = {};
      const chain = {
        select() { return chain; },
        in(col, val) { filters[col] = val; return chain; },
        eq(col, val) { filters[col] = val; return chain; },
        order() { return chain; },
        then(resolve) {
          log.push({ table, filters });
          resolve({ data: rowsByTable[table] || [], error: null });
        },
      };
      return chain;
    },
  };
}

test('eligibility endpoint enforces method, authentication, authorization and input cap', async () => {
  const base = { db: rowsDb({}), tenantContext: async () => null, adminAccess: async () => false };
  for (const [req, expected] of [
    [{ method: 'GET' }, 405],
    [{ method: 'POST', body: {} }, 401],
  ]) {
    const res = response();
    await createSpeakerAwardEligibilityHandler(base)(req, res);
    assert.equal(res.code, expected);
  }
  const forbidden = response();
  await createSpeakerAwardEligibilityHandler({ ...base, tenantContext: async () => ({ tenantId: 't1' }) })({ method: 'POST', body: {} }, forbidden);
  assert.equal(forbidden.code, 403);
  const tooMany = response();
  await createSpeakerAwardEligibilityHandler({ ...base, tenantContext: async () => ({ tenantId: 't1' }), adminAccess: async () => true })(
    { method: 'POST', body: { speaker_ids: Array.from({ length: 201 }, (_, i) => `s${i}`) } }, tooMany);
  assert.equal(tooMany.code, 400);
  const malformed = response();
  await createSpeakerAwardEligibilityHandler({ ...base, tenantContext: async () => ({ tenantId: 't1' }), adminAccess: async () => true })(
    { method: 'POST', body: { speaker_ids: 's1' } }, malformed);
  assert.equal(malformed.code, 400);
});

test('eligibility endpoint scopes speakers to tenant and returns only found speakers', async () => {
  const log = [];
  const db = rowsDb({ speaker: [{ id: 's1', member_id: 'm1' }] }, log);
  const res = response();
  await createSpeakerAwardEligibilityHandler({
    db, tenantContext: async () => ({ tenantId: 't1' }), adminAccess: async () => true,
    match: async () => ({ s1: { member_id: 'm1', organization_id: 'o1', organization_name: 'Org' } }),
  })({ method: 'POST', body: { speaker_ids: ['s1', 'foreign', 's1', 42] } }, res);
  assert.equal(res.code, 200);
  assert.deepEqual(Object.keys(res.body.eligibility), ['s1']);
  assert.equal(log[0].filters.tenant_id, 't1');
  assert.deepEqual(log[0].filters.id, ['s1', 'foreign']);
});

test('grants endpoint validates scope and tenant-filters grants and badge names', async () => {
  const log = [];
  const db = rowsDb({
    speaker_award_grant: [{ id: 'g1', badge_id: 'b1' }],
    badge: [{ id: 'b1', name: 'Speaker' }],
  }, log);
  const handler = createSpeakerAwardGrantsHandler({
    db, tenantContext: async () => ({ tenantId: 't1' }), adminAccess: async () => true,
  });
  const bad = response();
  await handler({ method: 'GET', query: { event_id: 'e1', event_type: 'other' } }, bad);
  assert.equal(bad.code, 400);
  const res = response();
  await handler({ method: 'GET', query: { event_id: 'e1', event_type: 'event' } }, res);
  assert.equal(res.body.grants[0].badge_name, 'Speaker');
  assert.equal(log[0].filters.tenant_id, 't1');
  assert.equal(log[0].filters.event_id, 'e1');
  assert.equal(log[1].filters.tenant_id, 't1');
});