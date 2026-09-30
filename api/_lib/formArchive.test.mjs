import test from 'node:test';
import assert from 'node:assert/strict';
import { updateFormArchive } from './formArchive.js';
import { isFormScheduleAvailable } from './formAvailability.js';

function fixture(overrides = {}) {
  const calls = [];
  const db = { from(table) {
    calls.push(['from', table]);
    const q = {
      update(value) { calls.push(['update', value]); return q; },
      eq(key, value) { calls.push(['eq', key, value]); return q; },
      select() { return q; },
      async maybeSingle() { return { data: { id: 'form', is_active: false }, error: null, ...overrides }; },
    };
    return q;
  } };
  return { db, calls };
}
const context = { tenantId: 'tenant', isAuthenticated: true };
const admin = async () => true;
test('archive preserves the form and never accesses submissions; tenant scoped and inactive', async () => {
  const { db, calls } = fixture();
  const result = await updateFormArchive({ db, context, id: 'form', body: { archived_at: '2026-09-29T00:00:00Z' }, hasAdminAccess: admin });
  assert.equal(result.status, 200);
  assert.deepEqual(calls.filter(c => c[0] === 'from'), [['from', 'form']]);
  assert.ok(calls.some(c => c[0] === 'eq' && c[1] === 'tenant_id' && c[2] === 'tenant'));
  assert.equal(calls.find(c => c[0] === 'update')[1].is_active, false);
  assert.ok(calls.find(c => c[0] === 'update')[1].archived_at);
});
test('restore keeps form inactive', async () => {
  const { db, calls } = fixture();
  assert.equal((await updateFormArchive({ db, context, id: 'form', body: { archived_at: null }, hasAdminAccess: admin })).status, 200);
  assert.deepEqual(calls.find(c => c[0] === 'update')[1], { archived_at: null, is_active: false });
});
test('authentication, admin and tenant required before touching DB', async () => {
  for (const [ctx, access, expected] of [
    [{}, admin, 401], [context, async () => false, 403], [{ isAuthenticated: true }, admin, 403],
  ]) {
    const { db, calls } = fixture();
    assert.equal((await updateFormArchive({ db, context: ctx, id: 'form', body: { archived_at: null }, hasAdminAccess: access })).status, expected);
    assert.deepEqual(calls, []);
  }
});
test('invalid payload, missing tenant record and storage failure are explicit', async () => {
  const base = { context, id: 'form', hasAdminAccess: admin };
  assert.equal((await updateFormArchive({ ...base, ...fixture(), body: { archived_at: 'bad' } })).status, 400);
  assert.equal((await updateFormArchive({ ...base, ...fixture(), body: { archived_at: null, is_active: true } })).status, 400);
  assert.equal((await updateFormArchive({ ...base, ...fixture({ data: null }), body: { archived_at: null } })).status, 404);
  assert.equal((await updateFormArchive({ ...base, ...fixture({ error: { message: 'write failed' } }), body: { archived_at: null } })).status, 500);
});
test('archive overrides scheduled availability', () => {
  assert.equal(isFormScheduleAvailable({ archived_at: '2026-09-29', deactivate_at: '2099-01-01' }), false);
  assert.equal(isFormScheduleAvailable({ archived_at: null }), true);
});