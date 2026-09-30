import test from 'node:test';
import assert from 'node:assert/strict';
import { createPublicResourcesHandler } from '../resources.js';

test('public list scans past a full scheduled batch without leaking it or caching results', async () => {
  const instant = Date.parse('2026-09-22T12:00:00Z');
  let now = instant;
  const rows = Array.from({ length: 1000 }, (_, n) => ({
    id: `scheduled-${n}`, release_date: new Date(instant + 1).toISOString(),
    title: 'Scheduled secret', target_url: 'scheduled-target', is_public: true,
  }));
  rows.push(...[null, '', new Date(instant).toISOString(), '2020-01-01T00:00:00Z', 'malformed']
    .map((release_date, i) => ({ id: `legacy-${i}`, release_date, is_public: true })));
  const db = { from(table) {
    const query = {
      select() { return query; }, eq() { return query; }, is() { return query; },
      order() { return table === 'resource' ? query : Promise.resolve({ data: [] }); },
      range(start, end) { return Promise.resolve({ data: rows.slice(start, end + 1) }); },
    };
    return query;
  } };
  const handler = createPublicResourcesHandler({
    db, clock: () => now, resolveTenant: async () => ({ id: 'tenant', slug: 'tenant' }),
  });
  async function request() {
    const res = { headers: {}, setHeader(k, v) { this.headers[k] = v; },
      status(code) { this.code = code; return this; }, json(body) { this.body = body; } };
    await handler({ method: 'GET' }, res);
    assert.equal(res.headers['Cache-Control'], 'private, no-store');
    return res.body;
  }
  assert.deepEqual((await request()).map(r => r.id), ['legacy-0', 'legacy-1', 'legacy-2', 'legacy-3']);
  now += 1;
  assert.equal((await request()).length, 1004);
  rows[0].release_date = new Date(now + 1000).toISOString();
  assert.equal((await request()).some(r => r.id === 'scheduled-0'), false);
});