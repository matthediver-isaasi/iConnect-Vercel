import assert from 'node:assert/strict';
import test from 'node:test';
import {
  KEYS,
  OBJECT_ID,
  PHONE_ID,
  TENANT_ID,
  digest,
  makePlan,
  readSource,
  stable,
  resolveApprovedMatch,
  parseDepartmentLabel,
  assertIdenticalDuplicate,
} from './lib/bnms-department-address-plan.mjs';
import { APPROVED_RESOLUTIONS } from './lib/bnms-department-address-approvals.mjs';

function fixture(source = readSource()) {
  const fields = KEYS.map((name, index) => ({
    id: name === 'phone_number' ? PHONE_ID : `field-${index}`,
    tenant_id: TENANT_ID,
    custom_object_id: OBJECT_ID,
    entity_scope: 'custom_object',
    name,
    label: name,
    field_type: name === 'phone_number' ? 'number' : 'text',
    is_active: true,
    is_required: false,
    archived_at: null,
  }));
  const organisations = [];
  const organisationByName = new Map();
  const records = [];
  const edges = [];
  for (const item of source.items) {
    let organisation = organisationByName.get(item.organisationName);
    if (!organisation) {
      organisation = {
        id: `organisation-${organisations.length}`,
        tenant_id: TENANT_ID,
        name: item.organisationName,
        archived_at: null,
      };
      organisations.push(organisation);
      organisationByName.set(item.organisationName, organisation);
    }
    const record = {
      id: `record-${records.length}`,
      tenant_id: TENANT_ID,
      custom_object_id: OBJECT_ID,
      archived_at: null,
      data: { name: item.departmentName, legacy: 'preserved', ...item.values },
    };
    records.push(record);
    edges.push({
      id: `edge-${edges.length}`,
      tenant_id: TENANT_ID,
      relationship_definition_id: 'definition-1',
      source_record_id: record.id,
      target_record_id: organisation.id,
      archived_at: null,
    });
  }
  return {
    tenant: { id: TENANT_ID, name: 'BNMS' },
    object: {
      id: OBJECT_ID,
      tenant_id: TENANT_ID,
      object_key: 'org_department',
      status: 'active',
      archived_at: null,
    },
    fields,
    organisations,
    records,
    definitions: [{
      id: 'definition-1',
      tenant_id: TENANT_ID,
      source_kind: 'custom_object',
      source_custom_object_id: OBJECT_ID,
      target_kind: 'organization',
      target_custom_object_id: null,
      status: 'active',
      archived_at: null,
    }],
    edges,
  };
}

test('pinned workbook has 301 reported rows, 298 pairs, and only identical C-I repeats', () => {
  const source = readSource();
  assert.equal(source.fileDigest, 'acfc52ca8baf88c09ac76a688d05ba5c98ba1ee4b44ac766f8f900bd9b78225f');
  assert.equal(source.sheet, 'NM departments');
  assert.equal(source.headers.length, 10);
  assert.equal(source.rows.length, 301);
  assert.equal(source.items.length, 298);
  const phones = source.rows.map(row => row.values.phone_number).filter(Boolean);
  assert.equal(phones.length, 17);
  assert.ok(phones.includes('0115 9691169 x55497'));
  assert.ok(phones.every(value => typeof value === 'string'));
  assert.equal(source.rows.filter((row) => row.duplicateOf !== null).length, 3);
  assert.deepEqual(source.rows.filter((row) => row.duplicateOf !== null)
    .map(({ sourceRow, duplicateOf }) => [sourceRow, duplicateOf]), [
    [117, 115],
    [210, 209],
    [218, 217],
  ]);
  for (const item of source.items) {
    assert.match(`${item.departmentName}: ${item.departmentName}`, /^(.+): \1$/);
    assert.ok(item.sourceRows.length === 1 || item.sourceRows.length === 2);
  }
});

test('colon labels reject mismatches and multiple colons; duplicates cannot overwrite a conflicting value', () => {
  assert.equal(parseDepartmentLabel('PET Centre: PET Centre', 5), 'PET Centre');
  for (const label of ['PET Centre', 'PET Centre: Radiopharmacy', 'PET: PET: PET', ':']) {
    assert.throws(() => parseDepartmentLabel(label, 5), /Source row 5/);
  }
  const values = Object.fromEntries(KEYS.map(key => [key, null]));
  const first = { sourceRow: 115, values };
  assert.doesNotThrow(() => assertIdenticalDuplicate(first, { ...values }, 117));
  assert.throws(() => assertIdenticalDuplicate(first, { ...values, phone_number: '01234' }, 117),
    /rows 115 and 117/);
});

test('stable JSON and digest do not depend on object insertion order', () => {
  assert.equal(stable({ z: 1, a: { d: 2, b: 3 } }), '{"a":{"b":3,"d":2},"z":1}');
  assert.equal(digest({ b: [2, { y: true, x: null }], a: 1 }),
    digest({ a: 1, b: [2, { x: null, y: true }] }));
  assert.equal(stable({ at: new Date('2026-09-17T10:00:00.000Z') }),
    '{"at":"2026-09-17T10:00:00.000Z"}');
  assert.notEqual(
    digest({ updated_at: new Date('2026-09-17T10:00:00.000Z') }),
    digest({ updated_at: new Date('2026-09-17T10:00:01.000Z') }),
  );
});

test('plan uniquely matches exact normalized organisation and department names and preserves other data', () => {
  const source = readSource();
  const state = fixture(source);
  state.organisations[0].name = `  ${state.organisations[0].name.toUpperCase()}  `;
  state.records[0].data.address_line_1 = 'stale';
  const plan = makePlan(source, state);
  assert.deepEqual(plan.blockers, []);
  assert.equal(plan.items.length, 298);
  assert.equal(plan.rows.length, 301);
  assert.equal(plan.summary.changedRecords, 1);
  assert.equal(plan.summary.changedFields, 1);
  assert.equal(plan.summary.recordsUpdated, 1);
  assert.equal(plan.summary.recordsUnchanged, 297);
  assert.equal(plan.summary.fieldValuesChanged, 1);
  assert.equal(plan.items[0].afterData.legacy, 'preserved');
  assert.equal(plan.items[0].diffs[0].key, 'address_line_1');
  assert.deepEqual(plan.items[0].patch, { address_line_1: source.items[0].values.address_line_1 });
  assert.deepEqual(plan.items[1].patch, {});
  assert.deepEqual(plan.phoneChange, {
    required: true,
    fieldId: PHONE_ID,
    from: 'number',
    to: 'text',
  });
  assert.equal(plan.rows.find((row) => row.sourceRow === 117).duplicateOf, 115);
});

test('text phone schema is replay-safe and reports unchanged records', () => {
  const source = readSource();
  const state = fixture(source);
  state.fields.find((field) => field.id === PHONE_ID).field_type = 'text';
  const plan = makePlan(source, state);
  assert.deepEqual(plan.blockers, []);
  assert.equal(plan.summary.changedRecords, 0);
  assert.equal(plan.summary.unchangedRecords, 298);
  assert.ok(plan.summary.blankCellsPreserved > 0);
  assert.equal(plan.phoneChange.required, false);
});

test('blank workbook cells preserve existing destination values and are not patched', () => {
  const source = readSource();
  const state = fixture(source);
  const itemIndex = source.items.findIndex((item) => item.values.phone_number === null);
  assert.ok(itemIndex >= 0);
  state.records[itemIndex].data.phone_number = '020 7946 0000';
  const plan = makePlan(source, state);
  assert.deepEqual(plan.blockers, []);
  assert.equal(plan.items[itemIndex].afterData.phone_number, '020 7946 0000');
  assert.ok(plan.items[itemIndex].blankKeys.includes('phone_number'));
  assert.ok(!Object.hasOwn(plan.items[itemIndex].patch, 'phone_number'));
});

test('foreign, archived, missing, and ambiguous destination state block the complete plan', () => {
  const source = readSource();
  const cases = [
    (state) => { state.records[0].tenant_id = 'foreign'; },
    (state) => { state.records[0].archived_at = '2026-01-01T00:00:00Z'; },
    (state) => { state.edges.splice(0, 1); },
    (state) => {
      state.organisations.push({ ...state.organisations[0], id: 'duplicate-organisation' });
    },
  ];
  for (const mutate of cases) {
    const state = fixture(source);
    mutate(state);
    const plan = makePlan(source, state);
    assert.ok(plan.blockers.length > 0);
    assert.ok(plan.items.length > 0);
    assert.ok(plan.rows.some((row) => row.recordId));
  }
});

test('matching never uses aliases or fuzzy names', () => {
  const source = readSource();
  const state = fixture(source);
  state.organisations[0].name = `${state.organisations[0].name} NHS`;
  const plan = makePlan(source, state);
  assert.ok(plan.blockers.some((message) => message.includes('Source row(s) 2') && message.includes('was not found')));
  assert.equal(plan.items.length, 297);
  assert.equal(plan.rows[0].status, 'blocked');
  assert.equal(plan.rows[0].recordId, null);
});

test('before-data digest detects stale destination comparisons', () => {
  const source = readSource();
  const plan = makePlan(source, fixture(source));
  assert.deepEqual(plan.blockers, []);
  const item = plan.items[0];
  const expected = digest(item.beforeData);
  assert.equal(digest(item.beforeData), expected);
  assert.notEqual(digest({ ...item.beforeData, name: `${item.beforeData.name}!` }), expected);
  assert.notEqual(
    digest({ ...item.beforeData, updated_at: new Date('2026-09-17T10:00:00.000Z') }),
    digest({ ...item.beforeData, updated_at: new Date('2026-09-17T10:00:01.000Z') }),
  );
});

test('all loaded fields must belong to the object and address fields must be text', () => {
  const source = readSource();
  const foreign = fixture(source);
  foreign.fields.push({
    id: 'foreign-field',
    tenant_id: 'foreign',
    custom_object_id: OBJECT_ID,
    entity_scope: 'custom_object',
    name: 'unrelated',
    field_type: 'text',
    is_active: true,
  });
  assert.ok(makePlan(source, foreign).blockers.some((message) => message.includes('Loaded field')));

  const numeric = fixture(source);
  numeric.fields.find((field) => field.name === 'address_line_1').field_type = 'number';
  assert.ok(makePlan(source, numeric).blockers.some((message) => (
    message.includes('Address field "address_line_1" must use text type')
  )));
});

test('two unique source pairs cannot resolve to one Department record', () => {
  const source = readSource();
  const state = fixture(source);
  const first = source.items[0];
  const second = source.items.find((item) => item.organisationName !== first.organisationName
    && item.departmentName === first.departmentName);
  assert.ok(second);
  const firstRecord = state.records[source.items.indexOf(first)];
  const secondIndex = source.items.indexOf(second);
  state.records.splice(secondIndex, 1);
  state.edges[secondIndex].source_record_id = firstRecord.id;
  const plan = makePlan(source, state);
  assert.ok(plan.blockers.some((message) => message.includes('same Department record')));
  assert.ok(plan.rows.some((row) => row.status === 'blocked' && row.recordId === firstRecord.id));
});

test('approved matches require the exact reviewed candidates and original date', () => {
  for (const approval of [
    ...Object.values(APPROVED_RESOLUTIONS.organisations),
    ...Object.values(APPROVED_RESOLUTIONS.departments),
  ]) {
    const candidates = approval.candidateIds.map(id => ({
      id, created_at: id === approval.selectedId ? '2026-08-27T10:00:00Z' : '2026-09-04T10:00:00Z',
    }));
    assert.deepEqual(resolveApprovedMatch(candidates, approval).map(row => row.id), [approval.selectedId]);
    assert.throws(() => resolveApprovedMatch(candidates.slice(0, 1), approval), /candidate set changed/);
    assert.throws(() => resolveApprovedMatch([...candidates, { id: 'new-duplicate' }], approval), /candidate set changed/);
    assert.throws(() => resolveApprovedMatch(candidates.map(c => ({ ...c, created_at: '2026-09-04' })), approval),
      /original 27 August record/);
  }
});

test('approved duplicates resolve through existing edges without changing later duplicates', () => {
  const source = readSource();
  const state = fixture(source);
  for (const [name, approval] of Object.entries(APPROVED_RESOLUTIONS.organisations)) {
    const org = state.organisations.find(o => o.name === name);
    state.edges.filter(e => e.target_record_id === org.id).forEach(e => { e.target_record_id = approval.selectedId; });
    org.id = approval.selectedId;
    org.created_at = '2026-08-27T00:00:00Z';
    state.organisations.push({ ...org, id: approval.candidateIds.find(id => id !== org.id), created_at: '2026-09-10' });
  }
  for (const [pair, approval] of Object.entries(APPROVED_RESOLUTIONS.departments)) {
    const item = source.items.find(s => `${s.organisationName}::${s.departmentName}` === pair);
    const record = state.records[source.items.indexOf(item)];
    const edge = state.edges.find(e => e.source_record_id === record.id);
    edge.source_record_id = approval.selectedId;
    record.id = approval.selectedId;
    record.created_at = '2026-08-27T00:00:00Z';
    const laterId = approval.candidateIds.find(id => id !== record.id);
    state.records.push({ ...record, id: laterId, created_at: '2026-09-04' });
    state.edges.push({ ...edge, id: `later-${laterId}`, source_record_id: laterId });
  }
  assert.ok(makePlan(source, state).blockers.length > 0);
  const plan = makePlan(source, state, APPROVED_RESOLUTIONS);
  assert.deepEqual(plan.blockers, []);
  assert.equal(plan.items.length, 298);
  for (const approval of Object.values(APPROVED_RESOLUTIONS.departments)) {
    assert.ok(plan.items.some(i => i.recordId === approval.selectedId));
    assert.ok(!plan.items.some(i => i.recordId === approval.candidateIds.find(id => id !== approval.selectedId)));
  }
});