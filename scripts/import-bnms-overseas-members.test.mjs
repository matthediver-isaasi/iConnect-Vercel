import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import XLSX from 'xlsx';
import {
  COLUMN_COUNT, CORE_MAPPINGS, CUSTOM_MAPPINGS, EXPECTED_FILE_SHA256, FILE,
  FOCUS_AREA, HEADERS, ROW_COUNT, auditFocusArea, auditMappings, makePlan,
  parseSourceBytes, writeFocusAreas,
} from './import-bnms-overseas-members.mjs';
import {
  TENANT_ID, compensateJournal, parseBritishDate, transformed,
} from './import-bnms-direct-debit-members.mjs';

const protectedBytes = readFileSync(FILE);
const source = parseSourceBytes(protectedBytes);

function mutateWorkbook(mutator) {
  const workbook = XLSX.read(protectedBytes, { type: 'buffer', raw: false });
  const sheet = workbook.Sheets['Overseas Members'];
  mutator(sheet);
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
}

test('pins and parses the corrected BNMS overseas workbook', () => {
  assert.equal(source.fingerprint, EXPECTED_FILE_SHA256);
  assert.equal(source.rows.length, ROW_COUNT);
  assert.equal(HEADERS.length, COLUMN_COUNT);
  assert.equal(HEADERS[0], 'ym_web_site_member_id');
  assert.deepEqual(source.counts, { organization: 33, none: 3, uniqueOrganizations: 31 });
  assert.equal(new Set(source.rows.map((row) => row.email)).size, ROW_COUNT);
  assert.equal(new Set(source.rows.map((row) => row.legacyId)).size, ROW_COUNT);
});

test('corrected phones contain only full text digits with an optional plus', () => {
  const phones = source.rows.map((row) => row.values[17]).filter(Boolean);
  assert.equal(phones.length, 26);
  assert.ok(phones.every((value) => /^\+?\d{6,15}$/.test(value)));
  assert.ok(phones.every((value) => !/[Ee.-]/.test(value)));
});

test('Member Since remains a core positional source column', () => {
  assert.ok(source.rows.every((row) => /^\d{2}\/\d{2}\/\d{4}$/.test(row.values[1])));
  assert.deepEqual(CORE_MAPPINGS.find((mapping) => mapping.column === 1), {
    column: 1, destination: 'created_on', transform: 'date',
  });
});

test('normalizes the workbook capitalization to the exact live Member class option', () => {
  assert.equal(source.rows.filter((row) => row.values[5] === 'Overseas associate').length, 8);
  assert.equal(source.rows.filter((row) => row.values[5] === 'Overseas Associate').length, 0);
});

test('rejects source drift, duplicate identities, malformed phones and invalid dates', () => {
  assert.throws(() => parseSourceBytes(Buffer.from('changed')), /fingerprint mismatch/);
  assert.throws(() => parseSourceBytes(mutateWorkbook((sheet) => {
    sheet.P3.v = sheet.P2.v.toUpperCase();
  }), { verifyFingerprint: false }), /Duplicate normalized Email/);
  assert.throws(() => parseSourceBytes(mutateWorkbook((sheet) => {
    sheet.A3.v = sheet.A2.v;
  }), { verifyFingerprint: false }), /Duplicate YM Web Site Member ID/);
  assert.throws(() => parseSourceBytes(mutateWorkbook((sheet) => {
    sheet.R2 = { t: 's', v: '9.64784E+12' };
  }), { verifyFingerprint: false }), /malformed Phone/);
  assert.throws(() => parseSourceBytes(mutateWorkbook((sheet) => {
    sheet.B2 = { t: 's', v: '31/02/2026' };
  }), { verifyFingerprint: false }), /Invalid Member Since/);
});

const requested = (mapping) => [...new Set(source.rows.map((row) => row.values[mapping.column]).filter(Boolean))];
const fields = CUSTOM_MAPPINGS.map((mapping) => ({
  id: mapping.id,
  tenant_id: TENANT_ID,
  name: mapping.name,
  label: mapping.label,
  field_type: mapping.type,
  entity_scope: 'member',
  is_active: true,
  options: mapping.type === 'dropdown'
    ? requested(mapping).map((value) => ({ label: value, value }))
    : null,
}));
const focusNames = [...new Set(source.rows.flatMap((row) => row.values[FOCUS_AREA.column].split('|').map((value) => value.trim()).filter(Boolean)))];
const categories = [{
  id: FOCUS_AREA.id, tenant_id: TENANT_ID, name: FOCUS_AREA.name,
  is_active: true, subcategories: focusNames,
}];
const mappings = auditMappings(fields, source);
const focusArea = auditFocusArea(categories, source);
const organizations = [...new Set(source.rows.map((row) => row.values[19]).filter(Boolean))]
  .map((id) => ({ id, tenant_id: TENANT_ID }));

test('audits exact live custom fields, controlled options and Focus Area values', () => {
  assert.equal(mappings.length, CUSTOM_MAPPINGS.length);
  assert.equal(focusArea.requested.length, 21);
  assert.throws(() => auditMappings(fields.filter((field) => field.name !== 'member_class'), source), /Expected one live field/);
  assert.throws(() => auditMappings(fields.map((field) => field.name === 'occupation'
    ? { ...field, options: [] } : field), source), /Unsupported "Occupation"/);
  assert.throws(() => auditFocusArea([{ ...categories[0], subcategories: [] }], source), /Unsupported Focus Area/);
});

function replayState(row) {
  const member = {
    id: 'member',
    tenant_id: TENANT_ID,
    email: row.email,
    first_name: row.values[12],
    last_name: row.values[13],
    created_on: parseBritishDate(row.values[1]),
    mobile: row.values[17] || null,
    organization_id: row.values[19] || null,
  };
  const preferenceValues = mappings.flatMap((mapping) => row.values[mapping.column] ? [{
    id: `pref-${mapping.id}`,
    member_id: member.id,
    field_id: mapping.id,
    value: String(transformed(row.values[mapping.column], mapping.transform, mapping.label)),
  }] : []);
  const memberCategories = row.values[FOCUS_AREA.column].split('|').map((name, index) => ({
    id: `area-${index}`,
    member_id: member.id,
    resource_category_id: FOCUS_AREA.id,
    subcategory_name: name.trim(),
  }));
  return { members: [member], preferenceValues, memberCategories, organizations };
}

test('plans a zero-write replay and rejects duplicate destination preference/category rows', () => {
  const row = source.rows.find((item) => item.values[FOCUS_AREA.column]);
  const state = replayState(row);
  const replay = makePlan({ ...source, rows: [row] }, state, mappings, focusArea);
  assert.equal(replay.items[0].action, 'unchanged');
  assert.equal(replay.items[0].departmentAssignmentMode, 'preserve');
  assert.deepEqual(replay.items[0].departmentIds, []);
  assert.ok(replay.items[0].preferences.every((item) => item.action === 'unchanged'));
  assert.ok(replay.items[0].focusAreas.every((item) => item.action === 'unchanged'));
  assert.throws(() => makePlan({ ...source, rows: [row] }, {
    ...state, preferenceValues: [...state.preferenceValues, { ...state.preferenceValues[0], id: 'duplicate' }],
  }, mappings, focusArea), /Duplicate destination preference/);
  assert.throws(() => makePlan({ ...source, rows: [row] }, {
    ...state, memberCategories: [...state.memberCategories, { ...state.memberCategories[0], id: 'duplicate' }],
  }, mappings, focusArea), /Duplicate destination Focus Area/);
});

test('requires every supplied Organisation to belong to BNMS', () => {
  const row = source.rows.find((item) => item.values[19]);
  assert.throws(() => makePlan({ ...source, rows: [row] }, {
    members: [], preferenceValues: [], memberCategories: [],
    organizations: organizations.map((organization) => organization.id === row.values[19]
      ? { ...organization, tenant_id: 'other-tenant' } : organization),
  }, mappings, focusArea), /missing or outside BNMS/);
});

test('compensates committed Focus Areas when the insert response is incomplete', async () => {
  const row = source.rows.find((item) => item.values[FOCUS_AREA.column]);
  const plan = makePlan({ ...source, rows: [row] }, {
    members: [], preferenceValues: [], memberCategories: [], organizations,
  }, mappings, focusArea);
  const inserted = [];
  const deleted = [];
  const persisted = new Map();
  const member = { id: 'member', tenant_id: TENANT_ID, email: row.email };
  const db = {
    from(table) {
      assert.ok(['member', 'member_resource_category'].includes(table));
      if (table === 'member') return {
        select() { return this; },
        order() { return this; },
        range() { return this; },
        eq() { return Promise.resolve({ data: [member], error: null }); },
      };
      return {
        insert(rows) {
          inserted.push(...rows);
          rows.forEach((item) => persisted.set(item.id, item));
          return { select: async () => ({ data: rows.slice(0, -1), error: null }) };
        },
        delete() {
          return {
            in(_column, ids) {
              deleted.push(...ids);
              ids.forEach((id) => persisted.delete(id));
              return { select: async () => ({ data: ids.map((id) => ({ id })), error: null }) };
            },
          };
        },
        select() {
          return { in: async (_column, ids) => ({
            data: ids.filter((id) => persisted.has(id)).map((id) => ({ id })),
            error: null,
          }) };
        },
      };
    },
  };
  const journal = [];
  let failure;
  try {
    await writeFocusAreas(db, plan, focusArea, journal);
  } catch (error) {
    failure = error;
    await compensateJournal(journal, error);
  }
  assert.match(failure.message, /returned 0\/1 rows/);
  assert.ok(inserted.length > 0);
  assert.deepEqual(deleted.sort(), inserted.map((item) => item.id).sort());
});

test('preserves the original error when a Focus Area insert commits nothing', async () => {
  const row = source.rows.find((item) => item.values[FOCUS_AREA.column]);
  const plan = makePlan({ ...source, rows: [row] }, {
    members: [], preferenceValues: [], memberCategories: [], organizations,
  }, mappings, focusArea);
  const member = { id: 'member', tenant_id: TENANT_ID, email: row.email };
  const db = {
    from(table) {
      if (table === 'member') return {
        select() { return this; },
        order() { return this; },
        range() { return this; },
        eq() { return Promise.resolve({ data: [member], error: null }); },
      };
      return {
        insert() {
          return { select: async () => ({ data: null, error: { message: 'constraint failure' } }) };
        },
        delete() {
          return { in() { return { select: async () => ({ data: [], error: null }) }; } };
        },
        select() {
          return { in: async () => ({ data: [], error: null }) };
        },
      };
    },
  };
  const journal = [];
  let failure;
  try {
    await writeFocusAreas(db, plan, focusArea, journal);
  } catch (error) {
    failure = error;
    await compensateJournal(journal, error);
  }
  assert.equal(failure.message, `Could not write Focus Areas for "${row.email}": constraint failure`);
});