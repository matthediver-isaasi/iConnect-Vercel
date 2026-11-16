import test from 'node:test';
import assert from 'node:assert/strict';
import { processZoomJob } from './zoomRegistrationJobProcessor.js';

function fixture(options = {}) {
  const stored = { id: 'job', cursor: 0, booking_ids: ['a', 'b'], totals: {}, attempts: 0, status: 'running', ...options };
  const registered = new Set();
  let emails = 0, calls = 0, match = true, interrupt = false;
  const io = {
    targetMatches: async () => match,
    booking: async (_, id) => ({ id, status: 'confirmed', attendee_email: `${id}@example.invalid` }),
    register: async (_, b) => {
      calls++;
      const existing = registered.has(b.id);
      registered.add(b.id);
      return { outcome: existing ? 'existing' : 'new', join_url: 'https://zoom.us/j/123' };
    },
    email: async () => { emails++; if (interrupt) throw new Error('Worker interrupted after send'); return true; },
    save: async (_, patch) => Object.assign(stored, structuredClone(patch)),
  };
  return {
    stored, io, registered, run: () => processZoomJob(structuredClone(stored), io),
    setMatch: value => { match = value; }, interrupt: () => { interrupt = true; },
    counts: () => ({ emails, calls }),
  };
}
test('page close and reload do not control durable cursor or worker progress', async () => {
  const f = fixture();
  await f.run();
  assert.equal(f.stored.cursor, 1);
  // New worker receives only persisted state, not a browser checkpoint.
  await f.run(); await f.run();
  assert.equal(f.stored.status, 'completed');
  assert.equal(f.registered.size, 2);
  assert.equal(f.counts().emails, 0);
});
test('lost registration checkpoint reconciles existing registrants without duplicate creation', async () => {
  const f = fixture();
  const save = f.io.save;
  let fail = true;
  f.io.save = async (job, patch) => {
    if (patch.cursor && fail) { fail = false; throw new Error('Interrupted checkpoint'); }
    return save(job, patch);
  };
  await f.run(); await f.run();
  assert.equal(f.stored.cursor, 1);
  assert.equal(f.registered.size, 1);
  assert.equal(f.stored.totals.existing, 1);
});
test('interruption after explicit email send never sends it again', async () => {
  const f = fixture({ email_requested: true });
  f.interrupt();
  await f.run();
  assert.equal(f.stored.email_claimed_for, 'a');
  await f.run();
  assert.equal(f.counts().emails, 1);
  assert.equal(f.stored.totals.uncertainEmails, 1);
  assert.equal(f.stored.cursor, 1);
});
test('changed target stops all registration and email effects', async () => {
  const f = fixture({ email_requested: true });
  f.setMatch(false); await f.run();
  assert.equal(f.stored.status, 'stopped');
  assert.deepEqual(f.counts(), { emails: 0, calls: 0 });
});
test('provider retries are bounded and cursor is retained', async () => {
  const f = fixture();
  f.io.register = async () => { throw new Error('HTTP 429'); };
  for (let i = 0; i < 4; i++) await f.run();
  assert.equal(f.stored.status, 'attention');
  assert.equal(f.stored.cursor, 0);
  assert.equal(f.stored.attempts, 4);
});
test('cancelled bookings and missing emails are skipped without provider calls', async () => {
  const f = fixture();
  f.io.booking = async (_, id) => id === 'a' ? null : { status: 'confirmed' };
  await f.run(); await f.run(); await f.run();
  assert.equal(f.stored.totals.skipped, 1);
  assert.equal(f.stored.totals.missingEmail, 1);
  assert.equal(f.counts().calls, 0);
});
