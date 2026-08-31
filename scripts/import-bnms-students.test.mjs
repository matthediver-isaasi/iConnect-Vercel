import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import test from 'node:test';
import {
  ASSIGNMENT_COUNTS, COLUMN_COUNT, COMBINATION_COUNTS, CORE_MAPPINGS,
  CUSTOM_MAPPINGS, EXPECTED_FILE_SHA256, FILE, FOCUS_AREA_MAPPING, HEADERS,
  REGION_MAPPING, ROW_COUNT, IMPORT_ROW_COUNT, auditFocusArea, auditHierarchy, auditMappings,
  applyStudentPlan, auditNoReferenceEligibility, decodeMixedEncoding, makePlan, noReferenceRows, parseSourceBytes,
  prepareApprovedSource, preservationSnapshot, readSource,
} from './import-bnms-students.mjs';
import { TENANT_ID, parseBritishDate, verifyOrCompensate } from './import-bnms-direct-debit-members.mjs';

function csvBytes(rows) {
  const cell = (value) => `"${String(value).replaceAll('"', '""')}"`;
  return Buffer.from(rows.map((row) => row.map(cell).join(',')).join('\r\n'));
}

function syntheticSourceBytes() {
  const skippedOrg = '55b65591-6a02-4370-9805-c0c720924d79';
  const organizationIds = Array.from({ length: 35 }, (_, index) =>
    index === 19 ? skippedOrg : `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`);
  const rows = Array.from({ length: ROW_COUNT }, (_, index) => {
    const values = Array(COLUMN_COUNT).fill('');
    const membership = index < 47
      ? ['Student Membership', 'Active', 'Student']
      : index < 52
        ? ['Resigned Membership', 'Active', 'Former']
        : ['Student Membership', 'Active', 'Patient representative'];
    values[0] = index === 19 ? '81630031' : `SYN-${String(index + 1).padStart(4, '0')}`;
    values[1] = `${(index % 27) + 1}/1/2026`;
    values[2] = `${(index % 27) + 1}/1/2027`;
    [values[3], values[4], values[5]] = membership;
    values[6] = `Synthetic${index + 1}`;
    values[7] = `Student${index + 1}`;
    values[8] = index === 23 ? 'Ms.' : index === 35 ? 'Mr.' : index % 2 ? 'Mr' : 'Ms';
    values[9] = `synthetic.student.${index + 1}@example.invalid`;
    values[10] = index % 4 ? `synthetic.alt.${index + 1}@example.invalid` : '';
    values[11] = index === 0 ? '17–19 Synthetic Street' : `${index + 1} Example Road`;
    values[12] = index % 3 ? 'Learning House' : '';
    values[13] = `Test City ${index % 5}`;
    values[14] = 'Example County';
    values[15] = `ZZ${String(index).padStart(2, '0')} 0ZZ`;
    values[16] = 'United Kingdom';
    values[17] = `Region ${index % 4}`;
    values[18] = index % 5 ? `0100000${String(index).padStart(3, '0')}` : '';
    values[19] = index === 52 ? '' : `0700000${String(index).padStart(3, '0')}`;
    values[20] = `Synthetic course ${index % 3}`;
    values[21] = index === 0 ? 'I’m ready for training' : index % 6 ? `Synthetic note ${index + 1}` : '';
    values[22] = index === 52 ? '' : index === 35 ? skippedOrg : organizationIds[index % organizationIds.length];
    values[23] = index === 2 ? '' : index % 2
      ? 'Physics – imaging science'
      : 'Physics – imaging science|Physics – dosimetry';
    return values;
  });
  return csvBytes([HEADERS, ...rows]);
}

const rawSource = parseSourceBytes(syntheticSourceBytes(), { verifyFingerprint: false });
const source = prepareApprovedSource(rawSource);
const requested = (mapping) => [...new Set(source.rows.map((row) => row.values[mapping.column]).filter(Boolean))];
const fields = [...CUSTOM_MAPPINGS, REGION_MAPPING].map((mapping, index) => ({
  id: mapping.id || `region-${index}`, tenant_id: TENANT_ID, name: mapping.name, label: mapping.label,
  field_type: mapping.type, entity_scope: 'member', is_active: true,
  options: mapping.type === 'dropdown' ? requested(mapping).map((value) => ({ label: value, value })) : null,
}));
fields.push({
  id: 'organization-region', tenant_id: TENANT_ID, name: 'region', label: 'Region',
  field_type: 'dropdown', entity_scope: 'organization', is_active: true,
  options: requested(REGION_MAPPING).map((value) => ({ label: value, value })),
});
const focusNames = [...new Set(source.rows.flatMap((row) => row.values[23].split('|')).filter(Boolean))];
const categories = [{
  id: FOCUS_AREA_MAPPING.categoryId, tenant_id: TENANT_ID, name: FOCUS_AREA_MAPPING.categoryName,
  is_active: true, subcategories: focusNames,
}];
const organizationIds = [...new Set(source.rows.map((row) => row.values[22]).filter(Boolean))];
const groups = [{ id: 'group', tenant_id: TENANT_ID }];
const organizations = organizationIds.map((id) => ({ id, tenant_id: TENANT_ID, organization_group_id: 'group' }));
const hierarchy = auditHierarchy(source, { groups, organizations });
const mappings = auditMappings(fields, source);
const focusArea = auditFocusArea(categories, source);
function mutateSource(mutator) {
  const rows = [HEADERS, ...rawSource.rows.map((row) => [...row.values])];
  mutator(rows);
  return parseSourceBytes(csvBytes(rows), { verifyFingerprint: false });
}

test('synthetic fixture preserves source shape, identities, combinations and hierarchy counts', () => {
  assert.equal(rawSource.rows.length, ROW_COUNT);
  assert.equal(source.rows.length, IMPORT_ROW_COUNT);
  assert.equal(HEADERS.length, COLUMN_COUNT);
  assert.deepEqual(rawSource.counts, ASSIGNMENT_COUNTS);
  assert.deepEqual(rawSource.combinations, COMBINATION_COUNTS);
  assert.equal(new Set(rawSource.rows.map((row) => row.email)).size, ROW_COUNT);
  assert.equal(new Set(rawSource.rows.map((row) => row.legacyId)).size, ROW_COUNT);
  assert.deepEqual(source.skipped.map((row) => row.sourceRow), [21]);
  assert.deepEqual(source.normalized, [
    { sourceRow: 25, from: 'Ms.', to: 'Ms' },
    { sourceRow: 37, from: 'Mr.', to: 'Mr' },
  ]);
});

test('pins the exact protected mixed-encoding source when the local file is available', {
  skip: !existsSync(FILE),
}, () => {
  const protectedSource = readSource();
  assert.equal(protectedSource.fingerprint, EXPECTED_FILE_SHA256);
  assert.equal(protectedSource.rows.length, ROW_COUNT);
});

test('mixed decoder preserves valid UTF-8 while repairing isolated Windows-1252 and rejects corruption', () => {
  const mixed = Buffer.concat([
    Buffer.from('I’m '),
    Buffer.from([0x96]),
    Buffer.from(' ready'),
  ]);
  assert.equal(decodeMixedEncoding(mixed), 'I’m – ready');
  assert.throws(() => decodeMixedEncoding(Buffer.from('bad \uFFFD')), /replacement character/);
  assert.throws(() => decodeMixedEncoding(Buffer.from('Iâ€™m')), /mojibake/);
  assert.ok(rawSource.rows.some((row) => row.values[21].includes('I’m')));
  assert.ok(rawSource.rows.some((row) => row.values[11].includes('17–19')));
  assert.ok(rawSource.rows.some((row) => row.values[23].includes('Physics – dosimetry')));
  assert.ok(rawSource.rows.every((row) => row.values.every((value) => !value.includes('\uFFFD'))));
});

test('rejects fingerprint drift, duplicates, invalid dates/UUIDs and unapproved membership combinations', () => {
  assert.throws(() => parseSourceBytes(Buffer.from('changed')), /fingerprint mismatch/);
  assert.throws(() => mutateSource((rows) => { rows[2][9] = rows[1][9].toUpperCase(); }), /Duplicate normalized Email/);
  assert.throws(() => mutateSource((rows) => { rows[2][0] = rows[1][0]; }), /Duplicate YM Web Site Member ID/);
  assert.throws(() => mutateSource((rows) => { rows[1][1] = '31/2/2026'; }), /Invalid/);
  assert.throws(() => mutateSource((rows) => { rows[1][22] = 'bad'; }), /invalid Organisation UUID/);
  assert.throws(() => mutateSource((rows) => { rows[1][5] = 'Full'; }), /Unapproved membership/);
});

test('maps every source column exactly once including Notes, Region, Organisation and Focus Area', () => {
  const mapped = [
    ...CORE_MAPPINGS.map((item) => item.column),
    ...CUSTOM_MAPPINGS.map((item) => item.column),
    REGION_MAPPING.column, 22, FOCUS_AREA_MAPPING.column,
  ].sort((a, b) => a - b);
  assert.deepEqual(mapped, [...Array(COLUMN_COUNT).keys()]);
  assert.deepEqual(CORE_MAPPINGS.find((item) => item.column === 21), { column: 21, destination: 'job_title' });
  assert.equal(mappings.length, CUSTOM_MAPPINGS.length + 1);
});

test('member fields fail closed when missing, ambiguous, wrong-scope or unsupported', () => {
  assert.throws(() => auditMappings(fields.filter((field) => field.name !== 'member_region'), source), /unambiguous/);
  assert.throws(() => auditMappings(fields.map((field) => field.name === 'member_region'
    ? { ...field, entity_scope: 'organization' } : field), source), /unambiguous/);
  const memberRegion = fields.find((field) => field.name === 'member_region');
  assert.throws(() => auditMappings([...fields, { ...memberRegion, id: 'duplicate' }], source), /unambiguous/);
  assert.throws(() => auditMappings(fields.map((field) => field.name === 'member_region'
    ? { ...field, options: [] } : field), source), /Unsupported "Region"/);
  assert.throws(() => auditMappings(fields.map((field) => field.name === 'region'
    ? { ...field, options: [...field.options, { label: 'Extra', value: 'Extra' }] } : field), source), /exact clone/);
});

test('Focus Area uses approved member_resource_category representation and exact live subcategories', () => {
  assert.equal(focusArea.categoryId, FOCUS_AREA_MAPPING.categoryId);
  assert.ok(focusArea.requested.includes('Physics – imaging science'));
  assert.throws(() => auditFocusArea([], source), /unambiguous/);
  assert.throws(() => auditFocusArea([{ ...categories[0], subcategories: categories[0].subcategories.slice(1) }], source), /Unsupported Focus Area/);
  const withHyphen = categories[0].subcategories.map((name) => name === 'Physics – dosimetry' ? 'Physics - dosimetry' : name);
  assert.throws(() => auditFocusArea([{ ...categories[0], subcategories: withHyphen }], source), /never canonicalized/);
});

test('requires tenant-owned Organisations but explicitly permits no Group parent', () => {
  assert.equal(hierarchy.chains.length, source.counts.organization);
  assert.throws(() => auditHierarchy(source, { groups, organizations: organizations.slice(1) }), /missing or outside BNMS/);
  const parentless = auditHierarchy(source, {
    groups: [], organizations: organizations.map((row) => ({ ...row, organization_group_id: null })),
  });
  assert.ok(parentless.chains.every((chain) => chain.approvedParentless && chain.groupId === null));
});

test('plans normalized-email matching, preserves blanks, and never invents the one absent Organisation', () => {
  const unassigned = source.rows.find((row) => !row.values[22]);
  const member = {
    id: 'member', tenant_id: TENANT_ID, email: unassigned.email.toUpperCase(),
    first_name: unassigned.values[6], last_name: unassigned.values[7],
    created_on: parseBritishDate(unassigned.values[1].replace(/ 00:00$/, '')), organization_id: 'preserve-org',
    landline: 'preserve', mobile: 'preserve', job_title: 'preserve',
  };
  const plan = makePlan({ ...source, rows: [unassigned] }, {
    members: [member], preferenceValues: [], memberCategories: [],
  }, mappings, hierarchy, focusArea);
  assert.equal(plan.items[0].member, member);
  assert.equal('organization_id' in plan.items[0].patch, false);
  if (!unassigned.values[18]) assert.equal('landline' in plan.items[0].patch, false);
  if (!unassigned.values[19]) assert.equal('mobile' in plan.items[0].patch, false);
  if (!unassigned.values[21]) assert.equal('job_title' in plan.items[0].patch, false);
  assert.deepEqual(noReferenceRows(source), [{ sourceRow: unassigned.sourceRow, email: unassigned.email }]);
});

test('new no-Organisation Member requires confirmed nullable assignment columns', () => {
  const unassigned = source.rows.find((row) => !row.values[22]);
  const plan = makePlan({ ...source, rows: [unassigned] }, {
    members: [], preferenceValues: [], memberCategories: [],
  }, mappings, hierarchy, focusArea);
  assert.throws(() => auditNoReferenceEligibility(source, {
    memberAssignmentNullability: { organization_id: true, organization_group_id: false },
  }, plan), /confirmed nullable/);
  assert.doesNotThrow(() => auditNoReferenceEligibility(source, {
    memberAssignmentNullability: { organization_id: true, organization_group_id: true },
  }, plan));
});

test('plans exact preference/category replay and rejects duplicate destination rows', () => {
  const row = source.rows.find((item) => item.values[23]);
  const member = {
    id: 'member', tenant_id: TENANT_ID, email: row.email,
    created_on: parseBritishDate(row.values[1]), first_name: row.values[6], last_name: row.values[7],
    landline: row.values[18] || null, mobile: row.values[19] || null,
    job_title: row.values[21] || null, organization_id: row.values[22],
  };
  const preferenceValues = mappings.flatMap((mapping) => row.values[mapping.column] ? [{
    id: mapping.id, member_id: member.id, field_id: mapping.id, value: row.values[mapping.column],
  }] : []);
  const memberCategories = row.values[23].split('|').map((name, index) => ({
    id: `category-${index}`, member_id: member.id, resource_category_id: focusArea.categoryId, subcategory_name: name,
  }));
  const replay = makePlan({ ...source, rows: [row] }, {
    members: [member], preferenceValues, memberCategories,
  }, mappings, hierarchy, focusArea);
  assert.equal(replay.items[0].action, 'unchanged');
  assert.ok(replay.items[0].preferences.every((item) => item.action === 'unchanged'));
  assert.ok(replay.items[0].focusAreas.every((item) => item.action === 'unchanged'));
  assert.throws(() => makePlan({ ...source, rows: [row] }, {
    members: [member], preferenceValues: [...preferenceValues, { ...preferenceValues[0], id: 'dup' }], memberCategories,
  }, mappings, hierarchy, focusArea), /Duplicate preference values/);
  assert.throws(() => makePlan({ ...source, rows: [row] }, {
    members: [member], preferenceValues, memberCategories: [...memberCategories, { ...memberCategories[0], id: 'dup' }],
  }, mappings, hierarchy, focusArea), /Duplicate Focus Area/);
});

test('preservation digest includes unmanaged data, blank source preference/category rows, relationships, and outside Focus Area rows', async () => {
  const blankPrefRow = source.rows.find((row) => !row.values[10]);
  const blankFocusRow = source.rows.find((row) => !row.values[23]);
  const blankCoreRow = source.rows.find((row) => !row.values[19] && !row.values[22]);
  const members = [
    { id: 'blank-pref', tenant_id: TENANT_ID, email: blankPrefRow.email, first_name: 'managed', secret: 'preserve' },
    { id: 'blank-focus', tenant_id: TENANT_ID, email: blankFocusRow.email, first_name: 'managed', secret: 'preserve-too' },
    { id: 'blank-core', tenant_id: TENANT_ID, email: blankCoreRow.email, mobile: 'preserve mobile', organization_id: 'preserve organisation' },
  ];
  const state = {
    member: members,
    prefs: [{ id: 'p', member_id: 'blank-pref', field_id: CUSTOM_MAPPINGS.find((m) => m.column === 10).id, value: 'must survive' }],
    targetPrefs: [{ id: 'outside-pref', member_id: 'outside', field_id: CUSTOM_MAPPINGS[0].id, value: 'must survive outside' }],
    rels: [{ id: 'r', target_record_id: 'blank-pref', type: 'unrelated' }],
    focus: [
      { id: 'f', member_id: 'blank-focus', resource_category_id: FOCUS_AREA_MAPPING.categoryId, subcategory_name: 'Bone' },
      { id: 'outside', member_id: 'outside', resource_category_id: FOCUS_AREA_MAPPING.categoryId, subcategory_name: 'Bone' },
    ],
  };
  class Query {
    constructor(table) { this.table = table; } select() { return this; } eq() { return this; }
    in(column) { if (column === 'field_id') this.mode = 'field'; return this; }
    order() { return this; } range() { return this; }
    then(resolve) {
      const data = this.table === 'member' ? state.member : this.table === 'member_preference_value'
        ? (this.mode === 'field' ? state.targetPrefs : state.prefs)
        : this.table === 'custom_object_relationship' ? state.rels : state.focus;
      return Promise.resolve({ data, error: null }).then(resolve);
    }
  }
  const db = { from: (table) => new Query(table) };
  const smallSource = { ...source, rows: [blankPrefRow, blankFocusRow, blankCoreRow] };
  const before = await preservationSnapshot(db, smallSource, mappings);
  state.member[2].mobile = 'blank source core drift';
  const after = await preservationSnapshot(db, smallSource, mappings, before.ids);
  assert.notEqual(before.digest, after.digest);
  state.member[2].mobile = 'preserve mobile';
  const beforeOrganisation = await preservationSnapshot(db, smallSource, mappings, before.ids);
  state.member[2].organization_id = 'unassigned source organisation drift';
  const afterOrganisation = await preservationSnapshot(db, smallSource, mappings, before.ids);
  assert.notEqual(beforeOrganisation.digest, afterOrganisation.digest);
  state.member[2].organization_id = 'preserve organisation';
  const beforeOutside = await preservationSnapshot(db, smallSource, mappings, before.ids);
  state.targetPrefs[0].value = 'outside drift';
  const afterOutside = await preservationSnapshot(db, smallSource, mappings, before.ids);
  assert.notEqual(beforeOutside.digest, afterOutside.digest);
});

test('skipped source Member is wholly immutable in the preservation digest', async () => {
  const skipped = source.skipped[0];
  const member = { id: 'skipped', tenant_id: TENANT_ID, email: skipped.email, first_name: skipped.values[6] };
  const state = {
    member: [member],
    prefs: [{ id: 'pref', member_id: member.id, field_id: CUSTOM_MAPPINGS[0].id, value: skipped.values[0] }],
    focus: [{ id: 'focus', member_id: member.id, resource_category_id: FOCUS_AREA_MAPPING.categoryId, subcategory_name: 'Bone' }],
  };
  class Query {
    constructor(table) { this.table = table; } select() { return this; } eq() { return this; }
    in(column) { this.mode = column; return this; } order() { return this; } range() { return this; }
    then(resolve) {
      const data = this.table === 'member' ? state.member
        : this.table === 'member_preference_value' ? state.prefs
          : this.table === 'member_resource_category' ? state.focus : [];
      return Promise.resolve({ data, error: null }).then(resolve);
    }
  }
  const db = { from: (table) => new Query(table) };
  const skippedSource = { ...source, rows: [skipped] };
  const immutable = new Set([skipped.email]);
  const before = await preservationSnapshot(db, skippedSource, mappings, null, immutable);
  state.member[0].first_name = 'changed';
  assert.notEqual(before.digest, (await preservationSnapshot(db, skippedSource, mappings, before.ids, immutable)).digest);
  state.member[0].first_name = skipped.values[6];
  const beforePref = await preservationSnapshot(db, skippedSource, mappings, before.ids, immutable);
  state.prefs[0].value = 'changed';
  assert.notEqual(beforePref.digest, (await preservationSnapshot(db, skippedSource, mappings, before.ids, immutable)).digest);
  state.prefs[0].value = skipped.values[0];
  const beforeFocus = await preservationSnapshot(db, skippedSource, mappings, before.ids, immutable);
  state.focus[0].subcategory_name = 'changed';
  assert.notEqual(beforeFocus.digest, (await preservationSnapshot(db, skippedSource, mappings, before.ids, immutable)).digest);
});

test('mocked execution writes mixed create/update, preferences and Focus Areas', async () => {
  const rows = [source.rows[0], source.rows[1]];
  const existing = { id: 'existing', tenant_id: TENANT_ID, email: rows[1].email };
  const plan = makePlan({ ...source, rows }, { members: [existing], preferenceValues: [], memberCategories: [] }, mappings, hierarchy, focusArea);
  const calls = [];
  let created = 0;
  class Query {
    constructor(table) { this.table = table; } insert(payload) { this.op = 'insert'; this.payload = payload; return this; }
    update(payload) { this.op = 'update'; this.payload = payload; return this; } upsert(payload) { this.op = 'upsert'; this.payload = payload; return this; }
    select() { return this; } single() { return this.run(true); } eq() { return this; } in() { return this; } is() { return this; } order() { return this; } range() { return this; }
    then(resolve, reject) { return this.run(false).then(resolve, reject); }
    async run(single) {
      calls.push(`${this.table}:${this.op || 'read'}`);
      if (this.table === 'member' && this.op === 'insert') return { data: { id: `new-${++created}`, tenant_id: TENANT_ID, email: this.payload.email, ...this.payload }, error: null };
      if (this.table === 'member' && this.op === 'update') return { data: { ...existing, ...this.payload }, error: null };
      if (this.table === 'member' && !this.op) return { data: [existing, ...Array.from({ length: created }, (_, i) => ({ id: `new-${i + 1}`, tenant_id: TENANT_ID, email: rows[0].email }))], error: null };
      if (this.table === 'member_preference_value' && this.op === 'upsert') return { data: this.payload, error: null };
      if (this.table === 'member_resource_category' && this.op === 'insert') return { data: this.payload.map((row, i) => ({ id: `cat-${i}`, ...row })), error: null };
      throw new Error(`unexpected ${this.table}:${this.op}`);
    }
  }
  const result = await applyStudentPlan({ from: (table) => new Query(table) }, plan, hierarchy, focusArea);
  assert.equal(result.memberWrites, 2);
  assert.ok(result.preferenceWrites > 0);
  assert.ok(result.categoryWrites > 0);
  assert.ok(calls.includes('member:insert') && calls.includes('member:update'));
  assert.ok(calls.includes('member_preference_value:upsert') && calls.includes('member_resource_category:insert'));
});

test('category failure compensates earlier member/preference writes; verify failure rolls back completed journal', async () => {
  const row = source.rows[0];
  const plan = makePlan({ ...source, rows: [row] }, { members: [], preferenceValues: [], memberCategories: [] }, mappings, hierarchy, focusArea);
  const calls = [];
  function dbFor({ failCategory = false } = {}) {
    class Query {
      constructor(table) { this.table = table; } insert(payload) { this.op = 'insert'; this.payload = payload; return this; }
      upsert(payload) { this.op = 'upsert'; this.payload = payload; return this; } delete() { this.op = 'delete'; return this; }
      update(payload) { this.op = 'update'; this.payload = payload; return this; } select() { return this; } single() { return this.run(); }
      eq() { return this; } in() { return this; } is() { return this; } order() { return this; } range() { return this; }
      then(resolve, reject) { return this.run().then(resolve, reject); }
      async run() {
        calls.push(`${this.table}:${this.op || 'read'}`);
        if (this.table === 'member' && this.op === 'insert') return { data: { id: 'created', tenant_id: TENANT_ID, email: row.email }, error: null };
        if (this.table === 'member' && !this.op) return { data: [{ id: 'created', tenant_id: TENANT_ID, email: row.email }], error: null };
        if (this.table === 'member_preference_value' && this.op === 'upsert') return { data: this.payload, error: null };
        if (this.table === 'member_preference_value' && this.op === 'delete') return { data: [{ member_id: 'created', field_id: 'x' }], error: null };
        if (this.table === 'member' && this.op === 'delete') return { data: [{ id: 'created' }], error: null };
        if (this.table === 'member_resource_category' && this.op === 'insert') {
          return failCategory ? { data: null, error: { message: 'category failure' } }
            : { data: this.payload.map((value, i) => ({ id: `c${i}`, ...value })), error: null };
        }
        if (this.table === 'member_resource_category' && this.op === 'delete') return { data: [{ id: 'c0' }], error: null };
        throw new Error(`unexpected ${this.table}:${this.op}`);
      }
    }
    return { from: (table) => new Query(table) };
  }
  await assert.rejects(() => applyStudentPlan(dbFor({ failCategory: true }), plan, hierarchy, focusArea), /category failure/);
  assert.ok(calls.includes('member:delete'));
  assert.ok(calls.includes('member_preference_value:delete'));
  calls.length = 0;
  const result = await applyStudentPlan(dbFor(), plan, hierarchy, focusArea);
  await assert.rejects(() => verifyOrCompensate(result.journal, async () => { throw new Error('post verify failure'); }), /post verify failure/);
  assert.ok(calls.includes('member_resource_category:delete'));
  assert.ok(calls.includes('member:delete'));
});