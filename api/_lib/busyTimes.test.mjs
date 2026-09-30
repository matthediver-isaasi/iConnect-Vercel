import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBusyTimeToUTC, slotConflictsWithBusyTimes } from './busyTimes.js';
import { getBusyTimes } from '../outlook/calendar.js';

// ---------------------------------------------------------------------------
// parseBusyTimeToUTC — timezone detection & conversion
// ---------------------------------------------------------------------------

test('explicit Z suffix is treated as UTC', () => {
  const d = parseBusyTimeToUTC('2026-02-10T10:00:00Z', 'Europe/London');
  assert.equal(d.toISOString(), '2026-02-10T10:00:00.000Z');
});

test('explicit +01:00 offset is respected', () => {
  const d = parseBusyTimeToUTC('2026-07-15T10:00:00+01:00', 'America/New_York');
  assert.equal(d.toISOString(), '2026-07-15T09:00:00.000Z');
});

test('explicit -05:00 offset is respected', () => {
  const d = parseBusyTimeToUTC('2026-02-10T10:00:00-05:00', 'Europe/London');
  assert.equal(d.toISOString(), '2026-02-10T15:00:00.000Z');
});

test('naive string with hyphens is NOT mistaken for offset-carrying (the original bug)', () => {
  // "2026-07-15T10:00:00" contains hyphens; old includes('-') check parsed it
  // as absolute. In BST 10:00 London == 09:00 UTC.
  const d = parseBusyTimeToUTC('2026-07-15T10:00:00', 'Europe/London');
  assert.equal(d.toISOString(), '2026-07-15T09:00:00.000Z');
});

test('naive string in London during GMT (winter) equals UTC', () => {
  const d = parseBusyTimeToUTC('2026-01-15T10:00:00', 'Europe/London');
  assert.equal(d.toISOString(), '2026-01-15T10:00:00.000Z');
});

test('naive string with fractional seconds (Graph format) in New York', () => {
  const d = parseBusyTimeToUTC('2026-07-15T10:00:00.0000000', 'America/New_York');
  assert.equal(d.toISOString(), '2026-07-15T14:00:00.000Z');
});

test('naive string in UTC timezone', () => {
  const d = parseBusyTimeToUTC('2026-07-15T10:00:00', 'UTC');
  assert.equal(d.toISOString(), '2026-07-15T10:00:00.000Z');
});

test('invalid (Windows-style) timezone falls back to the agent timezone', () => {
  const d = parseBusyTimeToUTC('2026-07-15T10:00:00', 'GMT Standard Time', 'Europe/London');
  assert.equal(d.toISOString(), '2026-07-15T09:00:00.000Z');
});

test('invalid timezone with no usable fallback resolves as UTC (still blocks slot)', () => {
  const d = parseBusyTimeToUTC('2026-07-15T10:00:00', 'Bogus/Zone', 'Bogus/Zone');
  assert.equal(d.toISOString(), '2026-07-15T10:00:00.000Z');
});

// ---------------------------------------------------------------------------
// slotConflictsWithBusyTimes
// ---------------------------------------------------------------------------

test('slot overlapping a BST busy event conflicts', () => {
  // Busy 10:00-11:00 London (BST) = 09:00-10:00 UTC
  const busy = [{ start: '2026-07-15T10:00:00.0000000', end: '2026-07-15T11:00:00.0000000', timeZone: 'Europe/London' }];
  const conflict = slotConflictsWithBusyTimes(
    new Date('2026-07-15T09:30:00Z'),
    new Date('2026-07-15T10:00:00Z'),
    busy,
    'Europe/London'
  );
  assert.equal(conflict, true);
});

test('slot adjacent to a busy event does not conflict', () => {
  const busy = [{ start: '2026-07-15T10:00:00', end: '2026-07-15T11:00:00', timeZone: 'Europe/London' }];
  // Busy = 09:00-10:00 UTC; slot 10:00-10:30 UTC touches but does not overlap
  const conflict = slotConflictsWithBusyTimes(
    new Date('2026-07-15T10:00:00Z'),
    new Date('2026-07-15T10:30:00Z'),
    busy,
    'Europe/London'
  );
  assert.equal(conflict, false);
});

test('missing busy timeZone falls back to agent timezone', () => {
  const busy = [{ start: '2026-07-15T14:00:00', end: '2026-07-15T15:00:00' }];
  // Agent in New York: 14:00-15:00 NY = 18:00-19:00 UTC
  const conflict = slotConflictsWithBusyTimes(
    new Date('2026-07-15T18:30:00Z'),
    new Date('2026-07-15T19:00:00Z'),
    busy,
    'America/New_York'
  );
  assert.equal(conflict, true);
});

test('empty/undefined busy list never conflicts', () => {
  assert.equal(slotConflictsWithBusyTimes(new Date(), new Date(), [], 'UTC'), false);
  assert.equal(slotConflictsWithBusyTimes(new Date(), new Date(), undefined, 'UTC'), false);
});

// ---------------------------------------------------------------------------
// getBusyTimes — @odata.nextLink pagination
// ---------------------------------------------------------------------------

function makeEvent(i, showAs = 'busy') {
  return {
    subject: `Event ${i}`,
    showAs,
    isCancelled: false,
    start: { dateTime: `2026-07-15T0${i % 10}:00:00.0000000`, timeZone: 'Europe/London' },
    end: { dateTime: `2026-07-15T0${i % 10}:30:00.0000000`, timeZone: 'Europe/London' }
  };
}

const FUTURE_TOKEN_CONNECTION = {
  id: 'conn-1',
  identity_id: 'id-1',
  access_token: 'token',
  token_expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString()
};

test('getBusyTimes follows @odata.nextLink across pages', async (t) => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  globalThis.fetch = async (url) => {
    calls.push(String(url));
    const page = calls.length;
    const body = page === 1
      ? { value: Array.from({ length: 3 }, (_, i) => makeEvent(i)), '@odata.nextLink': 'https://graph.microsoft.com/v1.0/next-page-2' }
      : { value: [makeEvent(5), makeEvent(6, 'free')] };
    return { ok: true, json: async () => body };
  };

  const busy = await getBusyTimes(FUTURE_TOKEN_CONNECTION, '2026-07-15T00:00:00Z', '2026-07-16T00:00:00Z', 'Europe/London');

  assert.equal(calls.length, 2);
  assert.ok(calls[1].includes('next-page-2'));
  // 3 busy from page 1 + 1 busy from page 2 (the 'free' one is filtered out)
  assert.equal(busy.length, 4);
  assert.equal(busy[3].timeZone, 'Europe/London');
});

test('getBusyTimes stops at the page cap rather than looping forever', async (t) => {
  let calls = 0;
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  globalThis.fetch = async () => {
    calls += 1;
    return { ok: true, json: async () => ({ value: [makeEvent(1)], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/again' }) };
  };

  const busy = await getBusyTimes(FUTURE_TOKEN_CONNECTION, '2026-07-15T00:00:00Z', '2026-07-16T00:00:00Z', 'UTC');
  assert.equal(calls, 20);
  assert.equal(busy.length, 20);
});

test('getBusyTimes throws on a failed page', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  globalThis.fetch = async () => ({ ok: false, text: async () => 'boom' });

  await assert.rejects(
    () => getBusyTimes(FUTURE_TOKEN_CONNECTION, '2026-07-15T00:00:00Z', '2026-07-16T00:00:00Z', 'UTC'),
    /Failed to get calendar events/
  );
});
