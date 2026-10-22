import test from 'node:test';
import assert from 'node:assert/strict';
import XLSX from 'xlsx';
import { zipSync, strToU8 } from 'fflate';
import {
  PUBLICATION_HEADERS, createPublicationTemplate, parsePublicationWorkbook, resolvePublicationRows,
} from './publicationWorkbook.js';

const settings = { categories: ['Research'], stages: [{ key: 'draft', label: 'Draft' }] };
const members = [
  { id: 'member-1', first_name: 'Synthetic', last_name: 'Writer' },
  { id: 'member-2', first_name: 'Synthetic', last_name: 'Editor' },
];
const externalWriters = [{ id: 'external-1', email: 'writer@example.invalid', first_name: 'External', last_name: 'Writer' }];
const context = { settings, members, externalWriters, briefs: [], canAssign: true };
const record = (values = {}, row = 2) => ({
  row, values: { ...Object.fromEntries(PUBLICATION_HEADERS.map(h => [h, ''])), Title: 'Synthetic publication', ...values },
});
const resolve = (values = {}, options = {}) => resolvePublicationRows([record(values)], { ...context, ...options })[0];
function workbook(rows = [], { headers = PUBLICATION_HEADERS, extra, edit } = {}) {
  const wb = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([headers, ...rows]);
  edit?.(sheet, wb);
  XLSX.utils.book_append_sheet(wb, sheet, 'Publications');
  if (extra) XLSX.utils.book_append_sheet(wb, extra, 'Other');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx', compression: true });
}
const valuesRow = values => PUBLICATION_HEADERS.map(h => values[h] ?? '');

test('template has exactly 18 canonical headings, excludes NDA, and roundtrips empty', () => {
  assert.equal(PUBLICATION_HEADERS.length, 18);
  assert.ok(!PUBLICATION_HEADERS.includes('External Writer NDA'));
  const buffer = createPublicationTemplate(settings);
  assert.ok(Buffer.isBuffer(buffer));
  const parsed = parsePublicationWorkbook(buffer, { fileName: 'publications.xlsx' });
  assert.deepEqual(parsed, { sheets: ['Publications'], sheetName: 'Publications', records: [] });
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const guidance = XLSX.utils.sheet_to_json(wb.Sheets.Instructions, { header: 1 }).flat().join(' ');
  for (const header of PUBLICATION_HEADERS) assert.ok(guidance.includes(header), header);
  assert.match(guidance, /Requirement only, not evidence/);
  assert.ok(!guidance.includes('example.invalid'));
});

test('roundtrip preserves raw booleans, notes, row numbers, trimmed header matching and Excel dates', () => {
  const input = valuesRow({
    Title: ' Synthetic publication ', Notes: ' Keep text ', 'Case Study': true,
    'Submission Deadline': new Date('2028-02-29T00:00:00Z'),
  });
  const parsed = parsePublicationWorkbook(workbook([[], input], {
    headers: PUBLICATION_HEADERS.map(h => ` ${h.toUpperCase()} `),
  }));
  assert.equal(parsed.records[0].row, 3);
  assert.equal(parsed.records[0].values.Title, 'Synthetic publication');
  assert.equal(parsed.records[0].values['Case Study'], true);
  assert.equal(parsed.records[0].values['Submission Deadline'], '2028-02-29T00:00:00.000Z');
  assert.equal(resolvePublicationRows(parsed.records, context)[0].action, 'create');
});

test('multiple sheets require explicit selection, including ordinary Instructions sheet', () => {
  const buffer = workbook([], { extra: XLSX.utils.aoa_to_sheet([['Title']]) });
  assert.equal(parsePublicationWorkbook(buffer).needsSheetSelection, true);
  assert.equal(parsePublicationWorkbook(buffer, { sheetName: 'Other' }).sheetName, 'Other');
  assert.throws(() => parsePublicationWorkbook(buffer, { sheetName: 'Missing' }), /valid data worksheet/);
});

test('bad, duplicate and missing headers fail closed', () => {
  for (const headers of [
    ['Title', ' title '], ['Title', 'External Writer NDA'], ['Notes'], ['Title', 'Unknown'], ['Title', ''],
  ]) assert.throws(() => parsePublicationWorkbook(workbook([], { headers })), /header/i);
});

test('file format, compressed size, dimensions and row limits are enforced', () => {
  assert.throws(() => parsePublicationWorkbook(Buffer.alloc(1024 * 1024 + 1)), /1 MB/);
  assert.throws(() => parsePublicationWorkbook(Buffer.from('not a zip')), /XLSX/);
  assert.throws(() => parsePublicationWorkbook(workbook(), { fileName: 'book.xls' }), /\.xlsx/);
  assert.throws(() => parsePublicationWorkbook(workbook(Array.from({ length: 101 }, (_, i) => [`Title ${i}`]))), /100 rows/);
  assert.throws(() => parsePublicationWorkbook(workbook([], { edit: s => { s['!ref'] = 'A1:CV1001'; } })), /dimensions/);
});

test('actual ZIP expansion is checked before XLSX parsing', () => {
  const buffer = Buffer.from(zipSync({
    '[Content_Types].xml': strToU8('<Types/>'),
    'xl/workbook.xml': strToU8('<workbook/>'),
    'huge.xml': new Uint8Array(10 * 1024 * 1024 + 1),
  }));
  assert.ok(buffer.length < 1024 * 1024);
  assert.throws(() => parsePublicationWorkbook(buffer), /Expanded workbook exceeds 10 MB/);
  assert.throws(() => parsePublicationWorkbook(Buffer.from('PKbroken archive')), /ZIP|zip|data/i);
});

test('formulas are rejected workbook-wide, even unselected sheets', () => {
  const other = XLSX.utils.aoa_to_sheet([['Title'], ['Unsafe']]);
  other.B3 = { t: 'n', v: 2, f: '1+1' };
  other['!ref'] = 'A1:B3';
  assert.throws(() => parsePublicationWorkbook(workbook([], { extra: other }), { sheetName: 'Publications' }), /Formulas/);
  assert.throws(() => parsePublicationWorkbook(workbook([['Unsafe']], {
    edit: s => { s.A2 = { t: 'str', v: 'cached', f: 'CONCAT("a","b")' }; },
  })), /Formulas/);
});

test('proven mappings use configured labels, member full names, review owner, flags and UTC deadlines', () => {
  const result = resolve({
    Category: ' research ', Status: 'DRAFT', SLA: 'A', Contract: 'B',
    Writer: ' synthetic writer ', Editor: 'Synthetic Editor',
    'Contributor Type': 'GFI team', 'Submission Deadline': '2028-02-29',
    'Writer Deadline': '2028-02-29T13:30:00+02:00', 'Case Study': 'Yes',
    'Member Copyright agreement': 'No',
  });
  assert.equal(result.action, 'create');
  assert.equal(result.payload.category, 'Research');
  assert.equal(result.payload.status, 'draft');
  assert.equal(result.payload.assigned_writer_id, 'member-1');
  assert.equal(result.payload.review_owner_id, 'member-2');
  assert.equal(result.payload.external_writer_id, null);
  assert.equal(result.payload.contributor_type, 'gfi');
  assert.equal(result.payload.deadline, '2028-02-29T00:00:00.000Z');
  assert.equal(result.payload.writer_deadline, '2028-02-29T11:30:00.000Z');
  assert.equal(result.payload.case_study_required, true);
  assert.equal(result.payload.copyright_required, false);
  assert.equal(result.writer.id, 'member-1');
  assert.equal(result.editor.id, 'member-2');
  assert.ok(result.warnings.length);
});

test('optional fields have no hardcoded tenant defaults', () => {
  const result = resolve();
  assert.equal(result.action, 'create');
  for (const key of ['category', 'sla', 'contract', 'deadline', 'writer_deadline', 'editor_deadline', 'notes', 'contributor_type']) {
    assert.equal(result.payload[key], null, key);
  }
  assert.equal(result.payload.case_study_required, false);
  assert.equal(result.payload.status, 'draft');
  assert.equal(resolve({}, { settings: { categories: [], stages: [] } }).action, 'error');
});

test('text fields reject accidental objects, dates, booleans and unbounded values', () => {
  for (const value of [{}, [], new Date(), false, 42]) {
    assert.equal(resolve({ Notes: value }).action, 'error');
  }
  assert.equal(resolve({ Title: 'x'.repeat(501) }).action, 'error');
  assert.equal(resolve({ Notes: 'x'.repeat(10001) }).action, 'error');
  assert.equal(resolve({ SLA: 'x'.repeat(256) }).action, 'error');
  for (const value of ['internal', 'team', 'GFI team', 'gfi']) {
    assert.equal(resolve({ 'Contributor Type': value }).payload.contributor_type, 'gfi');
  }
});

test('strict flags accept only supported boolean representations', () => {
  for (const header of ['External Writer', 'Case Study', 'Member Copyright agreement']) {
    for (const value of ['maybe', 'y', 'n', 2, -1, 'enabled', {}, []]) {
      assert.equal(resolve({ [header]: value }).action, 'error', `${header}: ${String(value)}`);
    }
  }
  for (const value of [true, 1, '1', 'YES', 'true']) assert.equal(resolve({ 'Case Study': value }).payload.case_study_required, true);
  for (const value of [false, 0, '0', 'NO', 'false', '']) assert.equal(resolve({ 'Case Study': value }).payload.case_study_required, false);
});

test('ISO dates reject rollover, ambiguous local formats, timezone omission and numeric serial text', () => {
  for (const value of [
    '2027-02-29', '2028-02-30', '2028-04-31', '2028-00-01', '2028-13-01',
    '2028-01-00', '0000-01-01', '2028-01-01T24:00:00Z', '2028-01-01T00:60:00Z',
    '2028-01-01T00:00:60Z', '2028-01-01T00:00:00+24:00', '2028-01-01T00:00:00',
    '01/02/2028', '46388', 46388,
  ]) assert.equal(resolve({ 'Submission Deadline': value }).action, 'error', String(value));
  assert.equal(resolve({ 'Submission Deadline': '2000-02-29' }).action, 'create');
  assert.equal(resolve({ 'Submission Deadline': '1900-02-29' }).action, 'error');
});

test('Excel leap-year phantom is rejected and 1904 date system is supported', () => {
  assert.throws(() => parsePublicationWorkbook(workbook([valuesRow({ Title: 'Synthetic', 'Submission Deadline': 60 })], {
    edit: s => { s.E2.z = 'yyyy-mm-dd'; },
  })), /Excel date/);
  const buffer = workbook([valuesRow({ Title: 'Synthetic', 'Submission Deadline': 0 })], {
    edit: (s, wb) => { s.E2.z = 'yyyy-mm-dd'; wb.Workbook = { WBProps: { date1904: true } }; },
  });
  assert.equal(parsePublicationWorkbook(buffer).records[0].values['Submission Deadline'], '1904-01-01T00:00:00.000Z');
});

test('identities must exist uniquely; internal email and ambiguous names are not accepted', () => {
  for (const value of ['Unknown Person', 'writer@example.invalid']) assert.equal(resolve({ Writer: value }).action, 'error');
  assert.equal(resolve({ Writer: 'Synthetic Writer' }, { members: [...members, { ...members[0], id: 'duplicate' }] }).action, 'error');
  assert.equal(resolve({ Editor: 'Missing Editor' }).action, 'error');
  assert.equal(resolve({ Writer: 'Synthetic Writer' }, { canAssign: false }).action, 'error');
  assert.throws(() => resolvePublicationRows([record()], { settings }), /lookup arrays/);
});

test('external writers are email-only existing identities; names only verify, assignments cannot contradict', () => {
  const values = { 'External Writer': 'Yes', 'External Writer email': ' WRITER@EXAMPLE.INVALID ' };
  const result = resolve(values);
  assert.equal(result.action, 'create');
  assert.equal(result.payload.external_writer_id, 'external-1');
  assert.equal(result.payload.assigned_writer_id, null);
  for (const changes of [
    { Writer: 'Synthetic Writer' },
    { 'External Writer email': '' },
    { 'External Writer email': 'absent@example.invalid' },
    { 'External Writer first name': 'Conflicting' },
    { 'External Writer': 'No' },
  ]) assert.equal(resolve({ ...values, ...changes }).action, 'error');
  assert.equal(resolve(values, { externalWriters: [...externalWriters, { ...externalWriters[0], id: 'duplicate' }] }).action, 'error');
});

test('unknown or ambiguous tenant labels and unsupported contributors fail closed', () => {
  for (const values of [{ Category: 'Unknown' }, { Status: 'Unknown' }, { 'Contributor Type': 'Unknown' }]) {
    assert.equal(resolve(values).action, 'error');
  }
  assert.equal(resolve({ Status: 'Draft' }, { settings: { ...settings, stages: [...settings.stages, { key: 'other', label: 'Draft' }] } }).action, 'error');
  assert.equal(resolve({ Category: 'Research' }, { settings: { ...settings, categories: ['Research', 'RESEARCH'] } }).action, 'error');
  for (const value of ['gfi', 'paid', 'volunteer']) assert.equal(resolve({ 'Contributor Type': value }).action, 'create');
});

test('duplicate titles fail; existing exact payload skips; collisions never update', () => {
  const duplicate = resolvePublicationRows([record(), record({ Title: ' SYNTHETIC   PUBLICATION ' }, 3)], context);
  assert.ok(duplicate.every(r => r.action === 'error'));
  const payload = resolve({ 'Submission Deadline': '2028-01-01' }).payload;
  assert.equal(resolve({ 'Submission Deadline': '2028-01-01' }, { briefs: [{ ...payload, deadline: '2028-01-01T00:00:00+00:00' }] }).action, 'skip');
  assert.equal(resolve({ 'Submission Deadline': '2028-01-01' }, { briefs: [{ ...payload, notes: 'Different' }] }).action, 'error');
  assert.equal(resolve({}, { briefs: [payload, payload] }).action, 'error');
  assert.equal(resolve({ Title: '' }).action, 'error');
});
