import test from 'node:test';
import assert from 'node:assert/strict';
import { validateRows, excelDate, assertMapping, norm } from './import-q4-publications-briefs.mjs';

function fixture() {
  return Array.from({ length: 75 }, (_, i) => ({
    Title: `Synthetic brief ${i}`, Category: i < 13 ? 'WCID' : 'Job profiles',
    SLA: '2026-2028', Contract: 'Prospects',
    'Submission Deadline': 46388, 'Writer Deadline': 46388, 'Editor Deadline': 46388,
    Status: 'In progress', 'Case Study': 'No', 'Member Copyright agreement': '',
    'External Writer': i < 55 ? 'No' : 'Yes', Writer: 'Synthetic Writer',
    Editor: 'Synthetic Editor', 'External Writer email': 'writer@example.invalid',
    'Contributor Type': i < 55 ? 'GFI team' : 'Paid',
    'External Writer NDA': i < 55 ? '' : 'Yes',
  }));
}
test('approved counts and exact deadline', () => {
  assert.equal(excelDate(46388), '2027-01-01');
  assert.deepEqual(validateRows(fixture()), { WCID: 13, 'Job profiles': 62, internal: 55, external: 20, ndaNotImported: 20 });
});
test('title comparison trims and folds case', () => {
  const rows = fixture();
  rows[1].Title = ' SYNTHETIC BRIEF 0 ';
  assert.throws(() => validateRows(rows), /duplicate title/);
  assert.equal(norm(' Title '), 'title');
});
test('all deadline columns reject drift', () => {
  for (const key of ['Submission Deadline', 'Writer Deadline', 'Editor Deadline']) {
    const rows = fixture();
    rows[0][key] = 46389;
    assert.throws(() => validateRows(rows), /deadline/);
  }
  assert.throws(() => excelDate('46388'), /Excel serial/);
});
test('batch, flags and assignment metadata fail closed', () => {
  assert.throws(() => validateRows(fixture().slice(1)), /75/);
  for (const [key, value] of Object.entries({
    Category: 'Other', SLA: '2025-2027', Contract: 'Other', Status: 'Submitted',
    'External Writer': 'Maybe', 'Case Study': 'Yes',
    'Member Copyright agreement': 'Yes', 'Contributor Type': 'Paid',
    'External Writer NDA': 'Yes', Editor: '', Writer: '',
  })) {
    const rows = fixture(); rows[0][key] = value;
    assert.throws(() => validateRows(rows));
  }
});
test('verification compares all approved fields, including null and false', () => {
  const expected = { assigned_writer_id: null, copyright_required: false, deadline: '2027-01-01' };
  assert.doesNotThrow(() => assertMapping({ ...expected, id: 'synthetic' }, expected, 2));
  assert.doesNotThrow(() => assertMapping({ ...expected, deadline: '2027-01-01T00:00:00+00:00' }, expected, 2));
  assert.throws(() => assertMapping({ ...expected, deadline: '2027-01-01T01:00:00+00:00' }, expected, 2), /differs/);
  for (const key of Object.keys(expected))
    assert.throws(() => assertMapping({ ...expected, [key]: 'wrong' }, expected, 2), /differs/);
});
