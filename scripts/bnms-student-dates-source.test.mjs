import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import XLSX from 'xlsx';
import { FILE, HASH, FIELD, TENANT, HEADERS, excelDate, parseSource, reconcile } from './bnms-student-dates-source.mjs';

const id = i => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
function fixture(change = () => {}) {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([HEADERS,
    ...Array.from({ length: 30 }, (_, i) => [id(i + 1), 47014])]), 'Sheet1');
  change(book);
  return XLSX.write(book, { type: 'buffer', bookType: 'xlsx' });
}
const parse = bytes => parseSource(bytes, { verifyFingerprint: false });
test('Excel serial conversion uses UTC and rejects ambiguous values', () => {
  assert.equal(excelDate(47014), '2028-09-18');
  for (const value of [60, 1, 47014.5, '47014', null, NaN, Infinity]) assert.throws(() => excelDate(value));
});
test('pins hash, headers, sheet, dimensions, date system and formula policy', () => {
  assert.throws(() => parseSource(fixture()), /fingerprint/);
  for (const change of [
    b => { b.Sheets.Sheet1.A1.v = 'wrong'; },
    b => { b.SheetNames = ['Wrong']; },
    b => { b.Sheets.Sheet1['!ref'] = 'A1:B32'; },
    b => { b.Workbook = { WBProps: { date1904: true } }; },
    b => { b.Sheets.Sheet1.B2.f = '1+1'; },
  ]) assert.throws(() => parse(fixture(change)));
});
test('invalid and duplicate source rows are held, never guessed', () => {
  const source = parse(fixture(b => {
    b.Sheets.Sheet1.A2.v = 'invalid';
    b.Sheets.Sheet1.B3.v = 60;
    b.Sheets.Sheet1.A5.v = b.Sheets.Sheet1.A4.v;
  }));
  assert.ok(source.rows.slice(0, 4).every(r => r.reasons.length));
  assert.ok(source.rows.slice(4).every(r => !r.reasons.length));
});
test('exact tenant matching, duplicate preferences, no-ops and overwrite classification', () => {
  const rows = parse(fixture()).rows;
  const members = rows.map(r => ({ id: r.member_id, tenant_id: TENANT }));
  members[0].tenant_id = id(99);
  members.splice(1, 1);
  const pref = i => ({ id: id(i + 100), member_id: rows[i].member_id, field_id: FIELD, value: rows[i].value });
  const preferences = [pref(2), pref(2), pref(3), { ...pref(4), value: '2020-01-01' }];
  const result = reconcile(rows, members, preferences);
  assert.deepEqual(result.slice(0, 5).map(r => r.outcome), ['held', 'held', 'held', 'unchanged', 'update']);
  assert.equal(result[4].before[0].value, '2020-01-01');
  assert.ok(reconcile(rows, rows.map(r => ({ id: r.member_id, tenant_id: TENANT })),
    rows.map((r, i) => pref(i))).every(r => r.outcome === 'unchanged'));
});
test('actual private source matches the approved fingerprint', { skip: !existsSync(FILE) }, () => {
  const result = parseSource(readFileSync(FILE));
  assert.equal(result.fingerprint, HASH);
  assert.equal(result.rows.length, 30);
  assert.ok(result.rows.every(r => !r.reasons.length));
});
