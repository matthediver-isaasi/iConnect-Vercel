import test from 'node:test';
import assert from 'node:assert/strict';
import create from './index.js';
import edit from './[id]/index.js';
import { isValidWebinarDuration, webinarDurationFromParts } from '../../../shared/zoomWebinarDuration.js';

function fixture() {
  const calls = { queries: [], provider: [], tokens: 0, writes: [] };
  const db = { from(table) {
    calls.queries.push(table);
    let write;
    const q = {
      select() { return q; }, eq() { return q; },
      insert(data) { write = data; calls.writes.push(data); return q; },
      update(data) { write = data; calls.writes.push(data); return q; },
      async single() { return { data: write ? { id: 'saved', ...write } :
        { zoom_webinar_id: 'provider-webinar', timezone: 'Europe/London' }, error: null }; },
    };
    return q;
  } };
  const deps = { db, tenantFor: async () => 'tenant', tokenFor: async () => { calls.tokens++; return 'fixture'; },
    fetchZoom: async (url, opts) => {
      calls.provider.push({ url, ...opts, body: JSON.parse(opts.body) });
      return { ok: true, status: opts.method === 'PATCH' ? 204 : 201,
        json: async () => ({ id: 'provider-webinar', host_id: 'host' }) };
    } };
  const res = { code: 200, setHeader() {}, status(code) { this.code = code; return this; },
    json(data) { this.data = data; return this; } };
  return { calls, deps, res };
}

test('hours/minutes conversion supports full days and preserves non-hour durations', () => {
  for (const [h, m, total] of [['7','30',450], ['8','0',480], ['0','45',45], ['24','0',1440]]) {
    assert.equal(webinarDurationFromParts(h, m), total);
    assert.equal(isValidWebinarDuration(total), true);
  }
  for (const parts of [['','0'], ['0','0'], ['-1','0'], ['1.5','0'], ['1','60'], ['1','-1'], ['1','2.5']]) {
    assert.equal(webinarDurationFromParts(...parts), null);
  }
});

for (const [method, handler] of [['POST', create], ['PATCH', edit]]) {
  test(`${method} rejects invalid durations before any Zoom call or database write`, async () => {
    for (const duration_minutes of [0, -1, 1.5, null, '', '480', NaN, Infinity, 2147483648]) {
      const { calls, deps, res } = fixture();
      await handler({ method, query: { id: 'local' }, body: {
        topic: 'Study day', start_time: '2027-01-01T09:00:00', duration_minutes,
      } }, res, deps);
      assert.equal(res.code, 400);
      assert.equal(calls.provider.length, 0);
      assert.equal(calls.tokens, 0);
      assert.equal(calls.writes.length, 0);
    }
  });
  test(`${method} sends and saves a 7-hour 30-minute webinar as 450 minutes`, async () => {
    const { calls, deps, res } = fixture();
    await handler({ method, query: { id: 'local' }, body: {
      topic: 'Study day', start_time: '2027-01-01T09:00:00', duration_minutes: 450,
    } }, res, deps);
    assert.ok(res.code < 300);
    assert.equal(calls.provider.length, 1);
    assert.equal(calls.provider[0].body.duration, 450);
    assert.equal(calls.writes[0].duration_minutes, 450);
  });
}

test('create still defaults omitted duration to 60 minutes', async () => {
  const { calls, deps, res } = fixture();
  await create({ method: 'POST', query: {}, body: {
    topic: 'Default duration', start_time: '2027-01-01T09:00:00',
  } }, res, deps);
  assert.ok(res.code < 300);
  assert.equal(calls.provider[0].body.duration, 60);
});
test('editing other fields does not overwrite an omitted duration', async () => {
  const { calls, deps, res } = fixture();
  await edit({ method: 'PATCH', query: { id: 'local' }, body: { topic: 'New title' } }, res, deps);
  assert.equal(res.code, 200);
  assert.equal(Object.hasOwn(calls.provider[0].body, 'duration'), false);
  assert.equal(Object.hasOwn(calls.writes[0], 'duration_minutes'), false);
});
