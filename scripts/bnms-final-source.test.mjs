import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import XLSX from 'xlsx';
import {
  FILE, HEADERS, CUSTOM_MAPPINGS, TENANT_ID, parseSourceBytes,
} from './bnms-final-source.mjs';

const group = '00000000-0000-4000-8000-000000000001';
const organization = '00000000-0000-4000-8000-000000000002';

function fixture(change = () => {}, { date1904 = false } = {}) {
  const grid = [[...HEADERS]];
  for (let sourceRow = 2; sourceRow <= 80; sourceRow += 1) {
    const row = Array(21).fill('');
    row[0] = 90000000 + sourceRow;
    row[1] = 'Active';
    row[3] = 'Guest';
    row[4] = 'CPD Guest';
    row[5] = `First${sourceRow}`;
    row[6] = `Last${sourceRow}`;
    row[8] = `person${sourceRow}@example.invalid`;
    row[14] = 'False';
    if (sourceRow <= 29) row[11] = group;
    else if (sourceRow <= 57) row[12] = organization;
    grid.push(row);
  }
  grid[71 - 1][8] = 'reviewed@example.invalid';
  grid[71 - 1][0] = 82907369;
  grid[75 - 1][8] = 'reviewed@example.invalid';
  grid[75 - 1][0] = 82906861;
  grid[79 - 1][8] = 'reviewed@example.invalid';
  grid[79 - 1][0] = 82907468;
  // Move the two excluded records into the Group bucket, matching the source
  // and preserving the 28/28/23 source assignment contract.
  for (const sourceRow of [75, 79]) {
    grid[sourceRow - 1][11] = group;
    grid[sourceRow - 1][12] = '';
  }
  // The initial generated group rows total 28; remove two ordinary assignments
  // after adding the pinned exclusions.
  grid[2 - 1][11] = '';
  grid[3 - 1][11] = '';
  // Supply the pinned date cardinalities.
  for (let sourceRow = 2; sourceRow <= 34; sourceRow += 1) grid[sourceRow - 1][2] = '01/02/2028';
  grid[2 - 1][2] = 46754;
  grid[2 - 1][16] = 47014;
  change(grid);
  const workbook = XLSX.utils.book_new();
  if (date1904) workbook.Workbook = { WBProps: { date1904: true } };
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(grid), 'Replacement Import');
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
}

test('exports the dedicated pinned contract and established remapped fields', () => {
  assert.match(FILE, /BNMS_FINAL_79_INDIVIDUALS_TO_IMPORT_22\.09\.26_1790149675043\.xlsx$/);
  assert.equal(TENANT_ID, 'ff2df806-b321-4254-b651-3af11fccf1db');
  assert.equal(HEADERS.length, 21);
  assert.deepEqual(CUSTOM_MAPPINGS.map((mapping) => mapping.column), [0, 1, 2, 3, 4, 7, 9, 13, 14, 15, 16, 17, 18, 19]);
  assert.deepEqual(CUSTOM_MAPPINGS.find((mapping) => mapping.column === 16), {
    id: '462a3258-0808-4edc-bd01-45c7def87af2',
    column: 16,
    name: 'student_course_end_date',
    label: 'Student course end date',
    type: 'date',
    transform: 'student-date',
  });
});

test('parses raw dates, booleans, exclusions, duplicate audit, and assignment counts', () => {
  const source = parseSourceBytes(fixture(), { verifyFingerprint: false });
  assert.equal(source.rows.length, 79);
  assert.equal(source.eligible.length, 77);
  assert.deepEqual(source.excluded.map((row) => [row.sourceRow, row.legacyId]), [
    [75, '82906861'], [79, '82907468'],
  ]);
  assert.equal(source.rows.find((row) => row.sourceRow === 71).legacyId, '82907369');
  assert.deepEqual(source.counts, {
    source: { group: 28, organization: 28, none: 23 },
    eligible: { group: 26, organization: 28, none: 23 },
  });
  assert.deepEqual(source.dateCounts, {
    expiry: { serial: 1, text: 32, blank: 46 },
    studentEnd: { serial: 1, text: 0, blank: 78 },
  });
  assert.equal(source.rows[0].original[2], '46754');
  assert.equal(source.rows[0].values[2], '02/01/2028');
  assert.equal(source.rows[0].values[16], '2028-09-18');
  assert.equal(source.rows[0].values[14], 'false');
  assert.deepEqual(source.duplicates, [{
    key: 'email',
    value: 'reviewed@example.invalid',
    sourceRows: [71, 75, 79],
    eligibleRows: [71],
  }]);
});

test('rejects global fingerprint, sheet, range, header, and date-system drift', () => {
  assert.throws(() => parseSourceBytes(fixture()), /fingerprint mismatch/);
  assert.throws(() => parseSourceBytes(fixture((grid) => { grid[0][3] = 'wrong'; }), { verifyFingerprint: false }), /header contract/);
  assert.throws(() => parseSourceBytes(fixture(() => {}, { date1904: true }), { verifyFingerprint: false }), /1904 date system/);

  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([[...HEADERS]]), 'Wrong');
  const wrong = XLSX.write(book, { type: 'buffer', bookType: 'xlsx' });
  assert.throws(() => parseSourceBytes(wrong, { verifyFingerprint: false }), /Replacement Import/);
});

test('records row reasons and continues after invalid identities, cells, emails, phones, UUIDs, booleans and dates', () => {
  const rejected = [
    [(grid) => { grid[10][0] = 'not-an-id'; }, /Member ID/i],
    [(grid) => { grid[10][5] = ''; }, /required name/i],
    [(grid) => { grid[10][8] = 'bad email'; }, /invalid Email/i],
    [(grid) => { grid[10][9] = 'bad alternate'; }, /Alternative email/i],
    [(grid) => { grid[10][10] = 123456789; }, /unsafe Phone/i],
    [(grid) => { grid[10][10] = '=cmd'; }, /unsafe Phone/i],
    [(grid) => { grid[10][11] = 'not-a-uuid'; }, /invalid Group UUID/i],
    [(grid) => { grid[10][11] = group; grid[10][12] = organization; }, /multiple hierarchy/i],
    [(grid) => { grid[10][14] = 'TRUE'; }, /expected True or False/],
    [(grid) => { grid[10][2] = '02/31/2028'; }, /Invalid YM Date Membership Expires/],
    [(grid) => { grid[10][2] = '2/1/2028'; }, /Invalid YM Date Membership Expires/],
    [(grid) => { grid[1][16] = ''; grid[10][16] = 60; }, /Invalid Student End Date/],
    [(grid) => { grid[10][4] = { f: '1+1', v: 2 }; }, /Formula cell forbidden/],
    [(grid) => { grid[10][4] = { t: 'e', v: 0x0f }; }, /Error cell forbidden/],
  ];
  for (const [change, pattern] of rejected) {
    const source = parseSourceBytes(fixture(change), { verifyFingerprint: false });
    assert.match(source.rows.find((row) => row.sourceRow === 11).reasons.join('; '), pattern);
    assert.deepEqual(source.rows.find((row) => row.sourceRow === 12).reasons, []);
  }
});

test('normalizes email and preserves cleaned source strings without inventing blanks', () => {
  const source = parseSourceBytes(fixture((grid) => {
    grid[10][8] = '  Mixed.Case@Example.invalid ';
    grid[10][9] = '  Alternate.Case@Example.invalid ';
    grid[10][10] = '  00123 456789  ';
    grid[10][14] = 'True';
  }), { verifyFingerprint: false });
  const row = source.rows.find((candidate) => candidate.sourceRow === 11);
  assert.equal(row.email, 'mixed.case@example.invalid');
  assert.equal(row.values[8], 'mixed.case@example.invalid');
  assert.equal(row.values[9], 'alternate.case@example.invalid');
  assert.equal(row.values[10], '00123 456789');
  assert.equal(row.values[14], 'true');
  assert.equal(row.values[19], '');
  assert.equal(row.original.length, 21);
  assert.deepEqual(row.reasons, []);
  const blankBoolean = parseSourceBytes(fixture((grid) => {
    grid[10][14] = '';
  }), { verifyFingerprint: false }).rows.find((candidate) => candidate.sourceRow === 11);
  assert.equal(blankBoolean.values[14], '');
  assert.deepEqual(blankBoolean.reasons, []);
});

test('eligible duplicates mark every implicated row while excluded duplicates remain audit-only', () => {
  const emailDuplicate = parseSourceBytes(fixture((grid) => {
    grid[20][8] = grid[19][8];
  }), { verifyFingerprint: false });
  for (const sourceRow of [20, 21]) {
    assert.ok(emailDuplicate.rows.find((row) => row.sourceRow === sourceRow).reasons
      .some((reason) => reason.startsWith('Duplicate eligible email:')));
  }
  const legacyDuplicate = parseSourceBytes(fixture((grid) => {
    grid[20][0] = grid[19][0];
  }), { verifyFingerprint: false });
  for (const sourceRow of [20, 21]) {
    assert.ok(legacyDuplicate.rows.find((row) => row.sourceRow === sourceRow).reasons
      .some((reason) => reason.startsWith('Duplicate eligible legacyId:')));
  }
});

test('parses the actual pinned workbook when attached', { skip: !existsSync(FILE) }, () => {
  const source = parseSourceBytes(readFileSync(FILE));
  assert.equal(source.fingerprint, '560923bb2986a69245d192c35724e4a0f513f690cab5b39e591ce16bee008fc6');
  assert.equal(source.rows.length, 79);
  assert.equal(source.eligible.length, 77);
  assert.deepEqual(source.counts.eligible, { group: 26, organization: 28, none: 23 });
  assert.deepEqual(source.dateCounts, {
    expiry: { serial: 3, text: 30, blank: 46 },
    studentEnd: { serial: 1, text: 0, blank: 78 },
  });
});