import test from 'node:test';
import assert from 'node:assert/strict';
import { withSpeakerRolloutOperation as run } from './speakerRolloutControl.js';

const id = '11111111-1111-4111-8111-111111111111';
const options = { enabled: true, deployment: 'fixture', revision: 'fixture' };
function fixture() {
  const calls = [];
  return { calls, async rpc(name, input) {
    calls.push([name, input]);
    return { data: name.startsWith('begin') ? id : true };
  } };
}
test('disabled bootstrap does not call the database', async () => {
  assert.equal(await run(null, 'test', async () => 42, { enabled: false }), 42);
});
test('admission and completion surround nested work only once', async () => {
  const db = fixture();
  assert.equal(await run(db, 'outer', () => run(db, 'inner', async () => {
    assert.equal(db.calls.length, 1);
    return 42;
  }, options), options), 42);
  assert.equal(db.calls.length, 2);
  assert.equal(db.calls[1][1].p_failed, false);
});
test('paused, unavailable and malformed admissions never execute work', async () => {
  for (const response of [{ error: { code: 'PT503' } }, { error: { code: 'PGRST202' } }, { data: null }]) {
    let executed = false;
    await assert.rejects(run({ rpc: async () => response }, 'test', async () => { executed = true; }, options), { status: 503 });
    assert.equal(executed, false);
  }
});
test('worker failure is recorded without hiding the original error', async () => {
  const db = fixture();
  await assert.rejects(run(db, 'test', async () => { throw new Error('fixture failure'); }, options), /fixture failure/);
  assert.equal(db.calls[1][1].p_failed, true);
});
test('failed completion is not treated as a successful drain', async () => {
  const db = { rpc: async name => name.startsWith('begin') ? { data: id } : { error: { code: 'offline' } } };
  await assert.rejects(run(db, 'test', async () => 42, options), { code: 'SPEAKER_ROLLOUT_UNAVAILABLE' });
});
test('concurrent independent operations do not share admission', async () => {
  const db = fixture();
  await Promise.all([run(db, 'one', async () => {}, options), run(db, 'two', async () => {}, options)]);
  assert.equal(db.calls.filter(([name]) => name.startsWith('begin')).length, 2);
});
