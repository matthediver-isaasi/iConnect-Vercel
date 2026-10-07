import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { deriveTrainingAgendaBounds as derive } from './trainingAgendaBounds.js';

const line = (date, start = '09:15', end = '16:15') => ({ start_date: date, start_time: start, end_time: end });
for (const runtime of ['UTC', 'America/Los_Angeles', 'Asia/Kathmandu']) {
  test(`independent of runtime ${runtime}`, () => {
    process.env.TZ = runtime;
    for (const [date, zone, start, end] of [
      ['2027-06-10', 'Europe/London', '08:15', '15:15'],
      ['2027-01-10', 'Europe/London', '09:15', '16:15'],
      ['2027-06-10', 'UTC', '09:15', '16:15'],
      ['2027-06-10', 'Asia/Kathmandu', '03:30', '10:30'],
    ]) assert.deepEqual(derive([line(date)], zone), { start: `${date}T${start}:00.000Z`, end: `${date}T${end}:00.000Z`, errors: [] });
  });
}
test('cross-DST, date-only defaults and timezone changes', () => {
  assert.deepEqual(derive([{ start_date: '2027-03-27', end_date: '2027-03-29' }], 'Europe/London'),
    { start: '2027-03-27T00:00:00.000Z', end: '2027-03-29T22:59:00.000Z', errors: [] });
  const rows = [line('2027-06-10')], before = JSON.stringify(rows);
  assert.notEqual(derive(rows, 'UTC').start, derive(rows, 'Europe/London').start);
  assert.equal(JSON.stringify(rows), before);
});
test('reject gaps, overlaps, invalid dates, clocks and timezone, including interior rows', () => {
  for (const row of [line('2027-03-28', '01:30'), line('2027-10-31', '01:30'), line('2027-02-30'), line('2027-06-10', '25:00'), line('2027-06-10', 'garbage')]) {
    const result = derive([line('2027-01-01'), row, line('2027-12-31')], 'Europe/London');
    assert.ok(result.errors.length); assert.equal(result.start, null);
  }
  assert.ok(derive([line('2027-01-01')], 'invalid').errors.length);
});
test('five-line public fixture and save/reopen idempotency', () => {
  const rows = [line('2027-06-10','09:15:00','11:15:00'),line('2027-06-28'),line('2027-06-29','09:30'),line('2027-07-01','09:30'),line('2027-07-02','09:30')];
  const snapshot = JSON.stringify(rows);
  const bounds = derive(rows, 'Europe/London');
  assert.deepEqual(bounds, { start: '2027-06-10T08:15:00.000Z', end: '2027-07-02T15:15:00.000Z', errors: [] });
  assert.deepEqual(derive(JSON.parse(snapshot), 'Europe/London'), bounds);
  assert.equal(JSON.stringify(rows), snapshot);
});
test('both editor previews and submitted payloads use the same timezone-aware result', () => {
  for (const page of ['CreateEvent','EditEvent']) {
    const source = readFileSync(`client/src/pages/${page}.jsx`, 'utf8');
    assert.match(source, /return deriveTrainingAgendaBounds\(agendaLines, (effectiveTimezone|eventTimezone)\)/);
    assert.match(source, /trainingStart = trainingDerivedDates\?\.start/);
    assert.match(source, /trainingEnd = trainingDerivedDates\?\.end/);
    assert.match(source, /value=\{isTraining \? \(trainingDerivedDates\?\.start/);
    assert.match(source, /trainingDerivedDates\?\.errors/);
    assert.doesNotMatch(source, /agendaLines\.map\(agendaLine(Start|End)DateTime\)/);
    // Execute the actual memo body and save assignments, not a duplicate test implementation.
    const memo = source.match(/const trainingDerivedDates = useMemo\(\(\) => \{([\s\S]*?)\}, \[isTraining, agendaLines,/)[1];
    const save = source.match(/let trainingStart = null;([\s\S]*?)\n    }\n/)[0];
    for (const zone of ['Europe/London', 'Asia/Kathmandu', 'UTC']) {
      const rows = [line('2027-06-10'), line('2027-07-02')];
      const preview = new Function('isTraining','agendaLines','effectiveTimezone','eventTimezone','deriveTrainingAgendaBounds', memo)(true, rows, zone, zone, derive);
      const submitted = new Function('isTraining','agendaLines','trainingDerivedDates', `${save}; return {start:trainingStart,end:trainingEnd};`)(true, rows, preview);
      assert.deepEqual(submitted, { start: preview.start, end: preview.end });
      assert.deepEqual(preview, derive(JSON.parse(JSON.stringify(rows)), zone));
    }
  }
});
