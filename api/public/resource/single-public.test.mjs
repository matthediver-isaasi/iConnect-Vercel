import test from 'node:test';
import assert from 'node:assert/strict';
import { createPublicResourceHandler } from './[identifier].js';

const id = '11111111-1111-4111-8111-111111111111';
const now = Date.parse('2026-09-22T12:00:00.000Z');
async function request(resource, identifier = id) {
  const selected = [];
  const db = { from(table) {
    let row = table === 'resource' ? { id, slug: 'resource', status: 'active',
      tenant_id: 'tenant', is_public: true, target_url: 'secret-target', ...resource } : null;
    const query = {
      select(columns) { selected.push(columns); return query; },
      eq(key, value) { if (row && row[key] !== value) row = null; return query; },
      order() { return Promise.resolve({ data: [], error: null }); },
      single() { return Promise.resolve({ data: row, error: null }); },
    };
    return query;
  } };
  const handler = createPublicResourceHandler({
    db, resolveTenant: async () => ({ id: 'tenant', slug: 'tenant' }),
    getContext: async () => ({ isAuthenticated: false }),
    clock: () => now,
  });
  const res = { code: 200, setHeader() {}, status(n) { this.code = n; return this; }, json(body) { this.body = body; } };
  await handler({ method: 'GET', query: { identifier } }, res);
  return { ...res, selected };
}
test('public group and event-linked resources are not exposed by UUID or slug', async () => {
  for (const identifier of [id, 'resource']) {
    for (const resource of [{ member_group_id: 'group' }, { linked_events: [{ event_id: 'event' }] }]) {
      const response = await request(resource, identifier);
      assert.equal(response.code, 404);
      assert.equal(JSON.stringify(response.body).includes('secret-target'), false);
      assert.match(response.selected[0], /member_group_id/);
      assert.match(response.selected[0], /linked_events/);
    }
  }
});
test('release boundaries apply to direct UUID and slug before metadata projection', async () => {
  for (const identifier of [id, 'resource']) {
    for (const release_date of ['2026-09-22T12:00:00.001Z', 'not-a-date']) {
      const response = await request({ release_date }, identifier);
      assert.equal(response.code, 404);
      assert.equal(JSON.stringify(response.body).includes('secret-target'), false);
      assert.equal(response.body.id, undefined);
    }
    for (const release_date of [null, '', '2026-09-22T12:00:00.000Z', '2026-09-21T12:00:00Z']) {
      const response = await request({ release_date }, identifier);
      assert.equal(response.code, 200);
      assert.equal(response.body.target_url, 'secret-target');
    }
  }
});
test('ordinary public targets and private login metadata retain their behavior', async () => {
  const response = await request({});
  assert.equal(response.code, 200);
  assert.equal(response.body.target_url, 'secret-target');
  const privateResponse = await request({ is_public: false });
  assert.equal(privateResponse.code, 200);
  assert.equal(privateResponse.body.target_url, undefined);
  assert.equal(privateResponse.body.is_locked, true);
  assert.match(privateResponse.body.login_redirect_url, /resourceId=11111111/);
});