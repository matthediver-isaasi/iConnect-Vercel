import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildEventTimeRows, parseEventDisplayTimezones } from '../shared/eventDisplayTimezones.js';
import { familiarTimezoneName, timezoneDiscoveryKey, timezoneSearchText, uniqueDiscoveryTimezones } from '../shared/timezoneDiscovery.js';

const settings = (zones, use24 = true) => [
  { setting_key: 'event_display_timezones', setting_value: JSON.stringify(zones) },
  { setting_key: 'event_time_format_24h', setting_value: String(use24) },
];
const zones = [{ timezone: 'Europe/London', label: 'UK' }, { timezone: 'Africa/Nairobi', label: 'EAT' }, { timezone: 'Asia/Kolkata', label: 'IST' }, { timezone: 'America/New_York' }];
const rows = (start, end, use24) => buildEventTimeRows({ start, end, timezone: 'Europe/London', settings: settings(zones, use24) });

test('familiar discovery is independent of Intl abbreviations and India spelling', () => {
  for (const zone of ['Asia/Kolkata', 'Asia/Calcutta']) {
    const text = timezoneSearchText(zone, zone.split('/')[1], 'GMT+5:30', 'GMT+5:30');
    for (const query of ['IST', 'India Standard Time', 'Kolkata', 'Calcutta', 'Asia/Kolkata', 'Asia/Calcutta', 'GMT+5:30']) {
      assert.ok(text.includes(query.toLowerCase().replace(/\s+/g, '')), query);
    }
    assert.match(familiarTimezoneName(zone), /India Standard Time \(IST\)/);
    assert.equal(timezoneDiscoveryKey(zone), 'Asia/Kolkata');
  }
  const text = timezoneSearchText('Africa/Nairobi', 'Nairobi', 'GMT+3', 'GMT+3');
  for (const query of ['EAT', 'East Africa Time', 'Nairobi', 'Africa/Nairobi', 'GMT+3']) {
    assert.ok(text.includes(query.toLowerCase().replace(/\s+/g, '')), query);
  }
  assert.equal(familiarTimezoneName('Europe/London'), '');
  assert.equal(timezoneSearchText('America/New_York', 'New York', 'EST', 'GMT-5'), 'america/newyorknewyorkestgmt-5');
  for (const list of [['Asia/Kolkata'], ['Asia/Calcutta'], ['Asia/Kolkata', 'Asia/Calcutta'], ['Asia/Calcutta', 'Asia/Kolkata']]) {
    assert.deepEqual(uniqueDiscoveryTimezones(['Africa/Nairobi', ...list, 'Europe/London']), ['Africa/Nairobi', list[0], 'Europe/London']);
  }
});

test('both saved India spellings retain their value, labels and order across round trips', () => {
  for (const timezone of ['Asia/Kolkata', 'Asia/Calcutta']) {
    const saved = [{ timezone, label: 'IST' }, { timezone: 'Africa/Nairobi', label: 'EAT' }];
    assert.deepEqual(parseEventDisplayTimezones(JSON.stringify(saved)), saved);
    const result = buildEventTimeRows({ start: '2026-01-15T23:00:00Z', timezone: 'UTC', settings: settings(saved) });
    assert.deepEqual(result.slice(1).map(({ label, time, date }) => ({ label, time, date })), [
      { label: 'IST', time: '04:30', date: '16 Jan 2026' },
      { label: 'EAT', time: '02:00', date: '16 Jan 2026' },
    ]);
    const primary = buildEventTimeRows({ start: '2026-01-15T23:00:00Z', timezone: timezone === 'Asia/Kolkata' ? 'Asia/Calcutta' : 'Asia/Kolkata', settings: settings(saved) });
    assert.equal(primary.length, 2);
    assert.equal(primary[0].label, 'IST');
  }
});

test('ordered parsing tolerates malformed data and deduplicates aliases', () => {
  for (const bad of ['', '{', '{}', null, 42]) assert.deepEqual(parseEventDisplayTimezones(bad), []);
  assert.deepEqual(parseEventDisplayTimezones([{ timezone: 'invalid' }, null, { timezone: 'Asia/Kolkata', label: 'x'.repeat(30) }, { timezone: 'Asia/Calcutta' }]), [{ timezone: 'Asia/Kolkata', label: 'x'.repeat(16) }]);
});
test('winter and summer offsets, primary label, New York DST and half hours', () => {
  const winter = rows('2026-01-15T10:00:00Z');
  assert.deepEqual(winter.map(r => r.time), ['10:00', '13:00', '15:30', '05:00']);
  assert.equal(winter[0].label, 'UK');
  assert.equal(winter[3].label, 'EST');
  const summer = rows('2026-07-15T10:00:00Z');
  assert.deepEqual(summer.map(r => r.time), ['11:00', '13:00', '15:30', '06:00']);
  assert.equal(summer[3].label, 'EDT');
});
test('midnight rollover and endpoint DST labels are explicit', () => {
  assert.equal(rows('2026-01-15T23:00:00Z')[2].date, '16 Jan 2026');
  const crossing = rows('2026-03-29T00:30:00Z', '2026-03-29T02:30:00Z')[0];
  assert.equal(crossing.time, '00:30 GMT – 03:30 BST');
  assert.equal(rows('2026-01-15T23:00:00Z', '2026-01-16T01:00:00Z')[0].date, '15 Jan 2026 – 16 Jan 2026');
});
test('12-hour display, missing config, invalid zones and date-only values', () => {
  assert.match(rows('2026-07-15T10:00:00Z', undefined, false)[0].time, /11:00 AM/);
  for (const start of ['2026-01-15', '2026-01-15T10:00:00', 'bad', null]) assert.deepEqual(rows(start), []);
  assert.deepEqual(buildEventTimeRows({ start: '2026-01-15T10:00:00Z', settings: [] }), []);
  assert.deepEqual(buildEventTimeRows({ start: '2026-01-15T10:00:00Z', timezone: 'bad', settings: settings(zones) }), []);
});
test('display model never mutates event data or settings', () => {
  const input = { start: '2026-01-15T10:00:00Z', end: '2026-01-15T11:00:00Z', timezone: 'Europe/London', settings: settings(zones) };
  const before = structuredClone(input);
  buildEventTimeRows(input);
  assert.deepEqual(input, before);
});
test('public whitelist remains explicit and tenant scoped; save invalidates discovery', () => {
  const api = readFileSync('api/public/system-settings.js', 'utf8');
  assert.match(api, /'event_display_timezones'/);
  assert.match(api, /\.eq\('tenant_id', tenant.id\)/);
  const page = readFileSync('client/src/pages/EventSettings.jsx', 'utf8');
  assert.match(page, /JSON.stringify\(parseEventDisplayTimezones\(eventDisplayTimezones\)\)/);
  assert.match(page, /queryKey: \['event-display-settings'\]/);
});
