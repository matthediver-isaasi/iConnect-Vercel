import test from 'node:test';
import assert from 'node:assert/strict';
import { originalReport, correctedReport, replaceAffectedReport, responderConditions } from './lib/bnms-responder-report.mjs';

test('repair changes only matching conditions and saved revision; unrelated concurrent settings survive', () => {
  const before = structuredClone(originalReport);
  const fixed = correctedReport(before);
  assert.deepEqual(before, originalReport);
  const expected = structuredClone(before);
  expected.version++;
  expected.config.columns.slice(4, 7).forEach((column) => { column.conditions = responderConditions; });
  assert.deepEqual(fixed, expected);
  const unrelated = { id: 'other', config: { concurrentlyChanged: true } };
  const settings = { arbitrary: 'retained', reports: [unrelated, before] };
  const next = replaceAffectedReport(settings, before, fixed);
  assert.equal(next.reports[0], unrelated);
  assert.equal(next.arbitrary, 'retained');
  assert.deepEqual(replaceAffectedReport(next, fixed, before), settings, 'recovery is exact');
  assert.throws(() => replaceAffectedReport(next, before, fixed), /Concurrent/);
  assert.throws(() => replaceAffectedReport({ reports: [before, before] }, before, fixed), /ambiguous/);
  const edited = structuredClone(before);
  edited.config.columns[0].label = 'Concurrent rename';
  assert.throws(() => correctedReport(edited), /changed since inspection/);
});
