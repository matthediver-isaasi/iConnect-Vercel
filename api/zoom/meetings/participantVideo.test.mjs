import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { fromZonedTime } from 'date-fns-tz';

const source = readFileSync(new URL('./index.js', import.meta.url), 'utf8')
  .replace(/^import .*;\n/gm, '')
  .replace('export default async function handler', 'async function handler');

async function create(extra) {
  const calls = [];
  const inserts = [];
  let tokenCalls = 0;
  const context = vm.createContext({
    console: { log() {}, error() {} }, Date, fromZonedTime,
    getTenantIdFromSession: async () => 'fixture-tenant',
    getZoomAccessToken: async () => { tokenCalls++; return 'fixture-token'; },
    supabase: { from: () => ({
      insert(row) {
        inserts.push(row);
        return { select: () => ({ single: async () => ({ data: { id: 'fixture-meeting' } }) }) };
      },
    }) },
    fetch: async (url, options) => {
      calls.push({ url, payload: JSON.parse(options.body) });
      return { ok: true, json: async () => ({ id: 123, host_id: 'fixture-host' }) };
    },
  });
  vm.runInContext(source, context);
  const res = { code: 200, setHeader() {}, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
  await context.handler({ method: 'POST', body: {
    topic: 'Fixture meeting', start_time: '2030-01-02T12:00:00', ...extra,
  } }, res);
  return { calls, inserts, tokenCalls, res };
}

for (const registration_required of [false, true]) {
  for (const [name, extra, expected] of [
    ['On', { participant_video: true }, true],
    ['Off', { participant_video: false }, false],
    ['omitted', {}, true],
  ]) {
    test(`${name}, registration ${registration_required}: provider settings and insert remain correct`, async () => {
      const result = await create({ ...extra, registration_required });
      assert.equal(result.res.code, 200);
      assert.equal(result.calls.length, 1);
      assert.deepEqual(result.calls[0].payload.settings, {
        host_video: true, participant_video: expected, join_before_host: false,
        mute_upon_entry: true, waiting_room: true, audio: 'both', auto_recording: 'cloud',
        approval_type: registration_required ? 0 : 2,
        ...(registration_required ? { registration_type: 1 } : {}),
      });
      assert.equal(Object.hasOwn(result.inserts[0], 'participant_video'), false);
      assert.equal(result.inserts[0].registration_required, registration_required);
    });
  }
}

for (const value of [null, 'false', 'true', '', 0, 1, [], {}]) {
  test(`rejects invalid registration_required ${JSON.stringify(value)} without side effects`, async()=>{
    const result=await create({registration_required:value});
    assert.equal(result.res.code,400);
    assert.equal(result.res.body.error,'registration_required must be a boolean');
    assert.equal(result.tokenCalls,0);
    assert.equal(result.calls.length,0);
    assert.equal(result.inserts.length,0);
  });
  test(`rejects invalid participant_video ${JSON.stringify(value)} before provider or database writes`, async () => {
    const result = await create({ participant_video: value });
    assert.equal(result.res.code, 400);
    assert.equal(result.res.body.error, 'participant_video must be a boolean');
    assert.equal(result.tokenCalls, 0);
    assert.equal(result.calls.length, 0);
    assert.equal(result.inserts.length, 0);
  });
}
