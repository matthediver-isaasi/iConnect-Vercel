import test from 'node:test';
import assert from 'node:assert/strict';
import { resourceReleaseLocalValue, resourceReleaseInstant } from './resourceReleaseTime.mjs';

for (const [zone, instant, local] of [
  ['UTC', '2026-07-15T12:34:56.789Z', '2026-07-15T12:34'],
  ['Europe/London', '2026-07-15T12:34:56.789Z', '2026-07-15T13:34'],
  ['America/New_York', '2026-07-15T12:34:56.789Z', '2026-07-15T08:34'],
  ['Asia/Kolkata', '2026-07-15T12:34:56.789Z', '2026-07-15T18:04'],
  ['America/New_York', '2026-11-01T06:30:56.789Z', '2026-11-01T01:30'],
]) {
  test(`${zone}: local display and unchanged instant preservation (${instant})`, () => {
    const previous = process.env.TZ;
    process.env.TZ = zone;
    try {
      assert.equal(resourceReleaseLocalValue(instant), local);
      assert.equal(resourceReleaseInstant(local, instant), instant);
      assert.equal(resourceReleaseLocalValue(resourceReleaseInstant(local)), local);
    } finally {
      if (previous === undefined) delete process.env.TZ;
      else process.env.TZ = previous;
    }
  });
}

test('cleared and invalid input never silently schedules now', () => {
  assert.equal(resourceReleaseLocalValue(null), '');
  assert.equal(resourceReleaseLocalValue('bad'), '');
  assert.equal(resourceReleaseInstant(''), null);
  assert.throws(() => resourceReleaseInstant('bad'), /valid local/);
});

test('reject a nonexistent local time in the spring DST gap', () => {
  const previous = process.env.TZ;
  process.env.TZ = 'America/New_York';
  try {
    assert.throws(() => resourceReleaseInstant('2026-03-08T02:30'), /valid local/);
    assert.equal(resourceReleaseInstant('2026-03-08T03:30'), '2026-03-08T07:30:00.000Z');
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});