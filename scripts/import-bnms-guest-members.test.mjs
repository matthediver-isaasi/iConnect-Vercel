import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import XLSX from 'xlsx';
import {
  COLUMN_COUNT, CORE_MAPPINGS, CUSTOM_MAPPINGS, EXPECTED_FILE_SHA256, FILE,
  HEADERS, ROW_COUNT, SHEET_NAME, auditMappings, makePlan, parseSourceBytes,
  pendingItems,
} from './import-bnms-guest-members.mjs';
import { TENANT_ID, parseBritishDate, transformed } from './import-bnms-direct-debit-members.mjs';

const bytes = readFileSync(FILE);
const source = parseSourceBytes(bytes);
function mutate(mutator) {
  const workbook = XLSX.read(bytes, { type: 'buffer', raw: false });
  mutator(workbook.Sheets[SHEET_NAME]);
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
}
function fieldFixture() {
  return CUSTOM_MAPPINGS.map((mapping) => ({
    id: mapping.id, tenant_id: TENANT_ID, name: mapping.name, label: mapping.label,
    field_type: mapping.type, entity_scope: 'member', is_active: true,
    options: mapping.type === 'dropdown'
      ? [...new Set(source.rows.map((row) => row.values[mapping.column]).filter(Boolean))]
        .map((value) => ({ value, label: value }))
      : null,
  }));
}

test('pins the corrected 872-row, 15-column Guest workbook', () => {
  assert.equal(source.fingerprint, EXPECTED_FILE_SHA256);
  assert.equal(source.rows.length, ROW_COUNT);
  assert.equal(HEADERS.length, COLUMN_COUNT);
  assert.equal(new Set(source.rows.map((row) => row.email)).size, ROW_COUNT);
  assert.equal(new Set(source.rows.map((row) => row.legacyId)).size, ROW_COUNT);
  assert.deepEqual([...CORE_MAPPINGS.map((mapping) => mapping.column), ...CUSTOM_MAPPINGS.map((mapping) => mapping.column)].sort((a, b) => a - b), [...Array(COLUMN_COUNT).keys()]);
});

test('validates dates, normalized emails, alternative emails, phones, and duplicate identities', () => {
  assert.ok(source.rows.every((row) => parseBritishDate(row.values[1])));
  assert.ok(source.rows.filter((row) => row.values[11]).every((row) => /^\+?\d{5,15}$/.test(row.values[11])));
  assert.throws(() => parseSourceBytes(Buffer.from('wrong')), /fingerprint mismatch/);
  assert.throws(() => parseSourceBytes(mutate((sheet) => { sheet.I3.v = sheet.I2.v.toUpperCase(); }), { verifyFingerprint: false }), /Duplicate normalized Email/);
  assert.throws(() => parseSourceBytes(mutate((sheet) => { sheet.A3.v = sheet.A2.v; }), { verifyFingerprint: false }), /Duplicate YM Web Site Member ID/);
  assert.throws(() => parseSourceBytes(mutate((sheet) => { sheet.B2 = { t: 's', v: '31/02/2026' }; }), { verifyFingerprint: false }), /Invalid Member Since/);
  assert.throws(() => parseSourceBytes(mutate((sheet) => { sheet.J2 = { t: 's', v: 'bad' }; }), { verifyFingerprint: false }), /invalid Alternative/);
  assert.throws(() => parseSourceBytes(mutate((sheet) => { sheet.L2 = { t: 's', v: '7.95E+10' }; }), { verifyFingerprint: false }), /unsafe Phone/);
});

test('audits exact live-field contracts and controlled options without normalization', () => {
  const fields = fieldFixture();
  assert.equal(auditMappings(fields, source).length, CUSTOM_MAPPINGS.length);
  const occupation = fields.find((field) => field.name === 'occupation');
  assert.throws(() => auditMappings(fields.map((field) => field === occupation ? { ...field, options: [] } : field), source), /Unsupported "Occupation"/);
  assert.throws(() => auditMappings(fields.map((field) => field.name === 'non_linked_organisation' ? { ...field, entity_scope: 'organization' } : field), source), /unambiguous/);
});

function replayState(row, mappings) {
  const member = {
    id: 'member', tenant_id: TENANT_ID, email: row.email,
    first_name: row.values[5], last_name: row.values[6],
    created_on: parseBritishDate(row.values[1]), mobile: row.values[11] || null,
  };
  const preferenceValues = mappings.flatMap((mapping) => row.values[mapping.column] ? [{
    id: `pref-${mapping.id}`, member_id: member.id, field_id: mapping.id,
    value: String(transformed(row.values[mapping.column], mapping.transform, mapping.label)),
  }] : []);
  return {
    members: [member], preferenceValues,
    legacyValues: [{ member_id: member.id, field_id: CUSTOM_MAPPINGS[0].id, value: row.legacyId }],
  };
}

test('reconciles by either identity, rejects split identities, and replays with zero writes', () => {
  const mappings = auditMappings(fieldFixture(), source);
  const row = source.rows.find((item) => item.values[9] && item.values[11] && item.values[14]);
  const state = replayState(row, mappings);
  const replay = makePlan({ ...source, rows: [row] }, state, mappings);
  assert.equal(replay.items[0].action, 'unchanged');
  assert.equal(pendingItems(replay).length, 0);
  const legacyOnly = makePlan({ ...source, rows: [row] }, {
    ...state, members: [{ ...state.members[0], email: 'old@example.test' }],
  }, mappings);
  assert.equal(legacyOnly.items[0].member.id, 'member');
  assert.equal(legacyOnly.items[0].patch.email, row.email);
  assert.throws(() => makePlan({ ...source, rows: [row] }, {
    members: [state.members[0], { ...state.members[0], id: 'other', email: 'old@example.test' }],
    preferenceValues: state.preferenceValues,
    legacyValues: [{ member_id: 'other', value: row.legacyId }],
  }, mappings), /match different/);
});

test('rejects tenant leakage and duplicate destination values', () => {
  const mappings = auditMappings(fieldFixture(), source);
  const row = source.rows[0];
  assert.throws(() => makePlan({ ...source, rows: [row] }, {
    members: [{ id: 'member', tenant_id: 'other', email: row.email }],
    preferenceValues: [], legacyValues: [],
  }, mappings), /outside BNMS/);
  const state = replayState(row, mappings);
  assert.throws(() => makePlan({ ...source, rows: [row] }, {
    ...state, preferenceValues: [...state.preferenceValues, { ...state.preferenceValues[0], id: 'duplicate' }],
  }, mappings), /Duplicate destination preference/);
  assert.throws(() => makePlan({ ...source, rows: [row] }, {
    ...state, legacyValues: [...state.legacyValues, { ...state.legacyValues[0], id: 'duplicate' }],
  }, mappings), /Ambiguous destination legacy/);
});