import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import XLSX from 'xlsx';
import {
  ASSIGNMENT_COUNTS, COLUMN_COUNT, CORE_MAPPINGS, CUSTOM_MAPPINGS, EXPECTED_FILE_SHA256, FILE,
  HEADERS, ROW_COUNT, SHEET_NAME, auditMappings, makePlan, parseSourceBytes,
  pendingItems, auditHierarchy, auditPriorGuestOverlaps, PRIOR_GUEST_EMAIL_OVERLAPS,
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

test('pins the linked 1,500-row, 15-column Guest workbook', () => {
  assert.equal(source.fingerprint, EXPECTED_FILE_SHA256);
  assert.equal(source.rows.length, ROW_COUNT);
  assert.equal(HEADERS.length, COLUMN_COUNT);
  assert.equal(new Set(source.rows.map((row) => row.email)).size, ROW_COUNT);
  assert.equal(new Set(source.rows.map((row) => row.legacyId)).size, ROW_COUNT);
  assert.deepEqual(source.counts, ASSIGNMENT_COUNTS);
  assert.deepEqual([...CORE_MAPPINGS.map((mapping) => mapping.column), ...CUSTOM_MAPPINGS.map((mapping) => mapping.column), 11, 12].sort((a, b) => a - b), [...Array(COLUMN_COUNT).keys()]);
});

test('validates dates, normalized emails, alternative emails, phones, and duplicate identities', () => {
  assert.ok(source.rows.every((row) => parseBritishDate(row.values[1])));
  assert.ok(source.rows.filter((row) => row.values[10]).every((row) => /^\+?\d{5,16}$/.test(row.values[10])));
  assert.throws(() => parseSourceBytes(Buffer.from('wrong')), /fingerprint mismatch/);
  assert.throws(() => parseSourceBytes(mutate((sheet) => { sheet.I3.v = sheet.I2.v.toUpperCase(); }), { verifyFingerprint: false }), /Duplicate normalized Email/);
  assert.throws(() => parseSourceBytes(mutate((sheet) => { sheet.A3.v = sheet.A2.v; }), { verifyFingerprint: false }), /Duplicate YM Web Site Member ID/);
  assert.throws(() => parseSourceBytes(mutate((sheet) => { sheet.B2 = { t: 's', v: '31/02/2026' }; }), { verifyFingerprint: false }), /Invalid Member Since/);
  assert.throws(() => parseSourceBytes(mutate((sheet) => { sheet.J2 = { t: 's', v: 'bad' }; }), { verifyFingerprint: false }), /invalid Alternative/);
  assert.throws(() => parseSourceBytes(mutate((sheet) => { sheet.K2 = { t: 's', v: '7.95E+10' }; }), { verifyFingerprint: false }), /unsafe Phone/);
  assert.throws(() => parseSourceBytes(mutate((sheet) => { sheet.M2 = { t: 's', v: sheet.L2.v }; }), { verifyFingerprint: false }), /exactly one/);
  assert.throws(() => parseSourceBytes(mutate((sheet) => { sheet.L2 = { t: 's', v: 'not-a-uuid' }; }), { verifyFingerprint: false }), /invalid hierarchy UUID/);
});

test('audits exact live-field contracts and controlled options without normalization', () => {
  const fields = fieldFixture();
  assert.equal(auditMappings(fields, source).length, CUSTOM_MAPPINGS.length);
  const occupation = fields.find((field) => field.name === 'occupation');
  assert.throws(() => auditMappings(fields.map((field) => field === occupation ? { ...field, options: [] } : field), source), /Unsupported "Occupation"/);
  assert.throws(() => auditMappings(fields.map((field) => field.name === 'qualifications' ? { ...field, entity_scope: 'organization' } : field), source), /unambiguous/);
});

function replayState(row, mappings) {
  const member = {
    id: 'member', tenant_id: TENANT_ID, email: row.email,
    first_name: row.values[5], last_name: row.values[6],
    created_on: parseBritishDate(row.values[1]), mobile: row.values[10] || null,
    organization_id: row.values[12] || null, organization_group_id: row.values[11] || null,
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

test('audits hierarchy ownership and applies authoritative Group/Organisation transitions', () => {
  const mappings = auditMappings(fieldFixture(), source);
  const groupRow = source.rows.find((row) => row.values[11]);
  const organizationRow = source.rows.find((row) => row.values[12]);
  const hierarchyState = {
    groups: [{ id: groupRow.values[11], tenant_id: TENANT_ID }],
    organizations: [{ id: organizationRow.values[12], tenant_id: TENANT_ID }],
  };
  assert.doesNotThrow(() => auditHierarchy({ ...source, rows: [groupRow, organizationRow] }, hierarchyState));
  assert.throws(() => auditHierarchy({ ...source, rows: [groupRow] }, {
    ...hierarchyState, groups: [{ id: groupRow.values[11], tenant_id: 'other' }],
  }), /outside BNMS/);
  let member = { ...replayState(groupRow, mappings).members[0], organization_id: 'old-org', organization_group_id: null };
  let plan = makePlan({ ...source, rows: [groupRow] }, { members: [member], preferenceValues: [], legacyValues: [] }, mappings);
  assert.equal(plan.items[0].patch.organization_group_id, groupRow.values[11]);
  assert.equal(plan.items[0].patch.organization_id, null);
  member = { ...replayState(organizationRow, mappings).members[0], organization_id: null, organization_group_id: 'old-group' };
  plan = makePlan({ ...source, rows: [organizationRow] }, { members: [member], preferenceValues: [], legacyValues: [] }, mappings);
  assert.equal(plan.items[0].patch.organization_id, organizationRow.values[12]);
  assert.equal(plan.items[0].patch.organization_group_id, null);
});

test('requires prior-workbook overlap identities to belong to the normalized-email member', () => {
  const rows = PRIOR_GUEST_EMAIL_OVERLAPS.map((contract, index) => ({
    sourceRow: index + 2, email: contract.email, legacyId: contract.incomingLegacyId,
  }));
  const members = rows.map((row, index) => ({ id: `member-${index}`, tenant_id: TENANT_ID, email: row.email }));
  const state = {
    members,
    legacyValues: [],
    priorLegacyValues: PRIOR_GUEST_EMAIL_OVERLAPS.map((contract, index) => ({
      member_id: members[index].id, value: contract.priorLegacyId,
    })),
  };
  assert.doesNotThrow(() => auditPriorGuestOverlaps({ rows }, state));
  assert.throws(() => auditPriorGuestOverlaps({ rows }, {
    ...state,
    priorLegacyValues: state.priorLegacyValues.map((value, index) =>
      index === 0 ? { ...value, member_id: 'different-member' } : value),
  }), /does not belong/);
});

test('passes active hierarchy edges through for compensation and rejects cross-tenant edges', () => {
  const mappings = auditMappings(fieldFixture(), source);
  const row = source.rows.find((candidate) => candidate.values[12]);
  const state = replayState(row, mappings);
  state.memberEdges = [{
    id: 'edge', tenant_id: TENANT_ID, target_record_id: 'member',
    source_record_id: 'department', archived_at: null,
  }];
  let plan = makePlan({ ...source, rows: [row] }, state, mappings);
  assert.deepEqual(plan.items[0].activeDepartmentEdges, state.memberEdges);
  assert.throws(() => makePlan({ ...source, rows: [row] }, {
    ...state, memberEdges: [{ ...state.memberEdges[0], tenant_id: 'other' }],
  }, mappings), /outside BNMS/);
});