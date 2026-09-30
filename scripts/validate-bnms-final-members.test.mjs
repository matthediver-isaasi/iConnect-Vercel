import test from 'node:test';
import assert from 'node:assert/strict';
import { CUSTOM_MAPPINGS, HEADERS, TENANT_ID } from './bnms-final-source.mjs';
import { makeReport, mappingAudit } from './validate-bnms-final-members.mjs';

const FOCUS = '9e6a7200-1194-4e75-98d1-25a29303e95e';
const groupId = '00000000-0000-4000-8000-000000000001';
const organizationId = '00000000-0000-4000-8000-000000000002';

function sourceRow(sourceRow, overrides = {}) {
  const values = Array(21).fill('');
  values[0] = `90${String(sourceRow).padStart(6, '0')}`;
  values[1] = 'Active';
  values[3] = 'Guest';
  values[4] = 'CPD Guest';
  values[5] = `First${sourceRow}`;
  values[6] = `Last${sourceRow}`;
  values[8] = `person${sourceRow}@example.invalid`;
  values[14] = 'false';
  for (const [column, value] of Object.entries(overrides.values || {})) values[Number(column)] = value;
  return {
    sourceRow,
    legacyId: values[0],
    email: values[8].toLowerCase(),
    values,
    original: [...values],
    reasons: [...(overrides.reasons || [])],
  };
}

function fieldState() {
  const options = {
    1: ['Active'],
    3: ['Guest', 'Resigned Membership'],
    4: ['CPD Guest', 'Former', 'Alien'],
    7: ['Dr'],
    13: ['Scientist'],
  };
  return CUSTOM_MAPPINGS.map((mapping) => ({
    id: mapping.id,
    tenant_id: TENANT_ID,
    entity_scope: 'member',
    name: mapping.name,
    label: mapping.label,
    field_type: mapping.type,
    is_active: true,
    options: mapping.type === 'dropdown'
      ? (options[mapping.column] || []).map((value) => ({ value, label: value }))
      : null,
  }));
}

function baseState() {
  return {
    fields: fieldState(),
    categories: [{
      id: FOCUS,
      tenant_id: TENANT_ID,
      name: 'Focus Area',
      is_active: true,
      subcategories: ['Bone', 'Diagnostics'],
    }],
    groups: [{ id: groupId, tenant_id: TENANT_ID, archived_at: null }],
    organizations: [{ id: organizationId, tenant_id: TENANT_ID, organization_group_id: groupId, archived_at: null }],
    members: [],
    preferences: [],
    legacy: [],
    memberCategories: [],
    edges: [],
    columns: [
      'first_name', 'last_name', 'email', 'mobile', 'organization_id', 'organization_group_id',
    ].map((column_name) => ({
      column_name,
      is_nullable: ['organization_id', 'organization_group_id'].includes(column_name) ? 'YES' : 'NO',
      data_type: 'text',
    })),
  };
}

function memberFor(row, id, extra = {}) {
  return {
    id,
    tenant_id: TENANT_ID,
    email: row.email,
    first_name: row.values[5],
    last_name: row.values[6],
    mobile: row.values[10] || null,
    organization_id: row.values[12] || null,
    organization_group_id: row.values[11] || null,
    ...extra,
  };
}

function attachLegacy(state, row, memberId) {
  const value = {
    id: `legacy-${row.sourceRow}`,
    member_id: memberId,
    field_id: CUSTOM_MAPPINGS.find((mapping) => mapping.column === 0).id,
    value: row.legacyId,
  };
  state.legacy.push(value);
  state.preferences.push(value);
}

function attachAllMappedValues(state, row, memberId, omittedColumns = new Set()) {
  for (const mapping of CUSTOM_MAPPINGS) {
    if (!row.values[mapping.column] || omittedColumns.has(mapping.column)) continue;
    const value = {
      id: `preference-${row.sourceRow}-${mapping.column}`,
      member_id: memberId,
      field_id: mapping.id,
      value: row.values[mapping.column],
    };
    state.preferences.push(value);
    if (mapping.column === 0) state.legacy.push(value);
  }
}

test('mapping audit verifies all 21 destinations and exposes exact mapping metadata and options', () => {
  const state = baseState();
  const audit = mappingAudit(state);
  assert.equal(audit.length, HEADERS.length);
  assert.ok(audit.every((mapping) => mapping.verified));
  const title = audit[7];
  assert.equal(title.contract.id, '4f2e504c-1663-4dd8-a486-274159834320');
  assert.equal(title.contract.name, 'title');
  assert.equal(title.contract.label, 'Title');
  assert.equal(title.contract.type, 'dropdown');
  assert.deepEqual(title.options, [{ value: 'Dr', label: 'Dr' }]);
  assert.equal(audit[10].destination, 'member.mobile');
  assert.match(audit[10].transform, /Opaque phone/);
  assert.match(audit[20].destination, new RegExp(FOCUS));
});

test('makeReport classifies every outcome and audits preference-only updates and blank hierarchy preservation', () => {
  const excluded = sourceRow(75);
  const ready = sourceRow(2);
  const unchanged = sourceRow(3);
  const preferenceOnly = sourceRow(4, { values: { 7: 'Dr' } });
  const conflict = sourceRow(5);
  const blankHierarchy = sourceRow(6);
  const rows = [excluded, ready, unchanged, preferenceOnly, conflict, blankHierarchy];
  const state = baseState();

  const unchangedMember = memberFor(unchanged, 'member-unchanged');
  const preferenceMember = memberFor(preferenceOnly, 'member-preference');
  const conflictMember = memberFor(conflict, 'member-conflict', { first_name: 'Existing nonblank' });
  const hierarchyMember = memberFor(blankHierarchy, 'member-hierarchy', {
    organization_id: organizationId,
    organization_group_id: null,
  });
  state.members.push(unchangedMember, preferenceMember, conflictMember, hierarchyMember);
  attachAllMappedValues(state, unchanged, unchangedMember.id);
  attachAllMappedValues(state, preferenceOnly, preferenceMember.id, new Set([7]));
  attachAllMappedValues(state, conflict, conflictMember.id);
  attachAllMappedValues(state, blankHierarchy, hierarchyMember.id);

  const report = makeReport({
    fingerprint: 'synthetic',
    rows,
    eligible: rows.filter((row) => row !== excluded),
    excluded: [excluded],
    duplicates: [],
    counts: {},
    dateCounts: {},
  }, state);
  assert.deepEqual(report.counts, {
    'user-excluded': 1,
    'ready-new': 1,
    'existing-unchanged': 2,
    'proposed-update': 1,
    blocked: 1,
  });
  const byRow = new Map(report.rows.map((row) => [row.sourceRow, row]));
  assert.equal(byRow.get(75).outcome, 'user-excluded');
  assert.equal(byRow.get(2).outcome, 'ready-new');
  assert.equal(byRow.get(3).outcome, 'existing-unchanged');
  assert.equal(byRow.get(4).outcome, 'proposed-update');
  assert.deepEqual(byRow.get(4).changes.map((change) => change.field), [
    `member_preference_value.value [${CUSTOM_MAPPINGS.find((mapping) => mapping.column === 7).id}]`,
  ]);
  assert.equal(byRow.get(5).outcome, 'blocked');
  assert.ok(byRow.get(5).reasons.includes('Conflicting nonblank member.first_name'));
  assert.equal(byRow.get(6).outcome, 'existing-unchanged');
  assert.equal(byRow.get(6).comparisons.find((item) => item.field === 'member.organization_id').action, 'preserve-blank-source');
  assert.equal(byRow.get(6).comparisons.find((item) => item.field === 'member.organization_id').current, organizationId);
});

test('blocks cross-tenant identities, missing hierarchy targets and missing Organisation parents', () => {
  const crossTenant = sourceRow(10);
  const missingGroup = sourceRow(11, { values: { 11: '00000000-0000-4000-8000-000000000099' } });
  const missingParent = sourceRow(12, { values: { 12: organizationId } });
  const state = baseState();
  state.legacy.push({
    id: 'foreign-legacy',
    member_id: 'foreign-member',
    field_id: CUSTOM_MAPPINGS[0].id,
    value: crossTenant.legacyId,
  });
  state.organizations[0].organization_group_id = '00000000-0000-4000-8000-000000000098';
  const report = makeReport({
    fingerprint: 'synthetic',
    rows: [crossTenant, missingGroup, missingParent],
    eligible: [crossTenant, missingGroup, missingParent],
    excluded: [],
    duplicates: [],
    counts: {},
    dateCounts: {},
  }, state);
  assert.ok(report.rows[0].reasons.includes('Missing or cross-tenant legacy identity'));
  assert.ok(report.rows[1].reasons.includes('Missing, archived or foreign Group UUID'));
  assert.ok(report.rows[2].reasons.includes('Missing or foreign Organisation parent'));
  assert.ok(report.rows.every((row) => row.outcome === 'blocked'));
});

test('blocks all eligible rows sharing a destination while ignoring an excluded sharer', () => {
  const first = sourceRow(20);
  const second = sourceRow(21);
  const excluded = sourceRow(75);
  const state = baseState();
  const member = memberFor(first, 'shared-member');
  state.members.push(member);
  attachLegacy(state, first, member.id);
  attachLegacy(state, second, member.id);
  attachLegacy(state, excluded, member.id);
  const report = makeReport({
    fingerprint: 'synthetic',
    rows: [first, second, excluded],
    eligible: [first, second],
    excluded: [excluded],
    duplicates: [],
    counts: {},
    dateCounts: {},
  }, state);
  assert.equal(report.rows[2].outcome, 'user-excluded');
  for (const row of report.rows.slice(0, 2)) {
    assert.equal(row.outcome, 'blocked');
    assert.ok(row.reasons.includes('Destination matched by multiple eligible source rows'));
  }
});

test('blocks unsupported mapping options, contradictory metadata, and live-field metadata restrictions', () => {
  const unsupported = sourceRow(30, { values: { 4: 'Not a live option' } });
  const contradictory = sourceRow(31, {
    values: { 3: 'Resigned Membership', 4: 'Former' },
  });
  const restricted = sourceRow(32, { values: { 7: 'Dr' } });
  const state = baseState();
  state.fields.find((field) => field.name === 'title').is_read_only = true;
  const report = makeReport({
    fingerprint: 'synthetic',
    rows: [unsupported, contradictory, restricted],
    eligible: [unsupported, contradictory, restricted],
    excluded: [],
    duplicates: [],
    counts: {},
    dateCounts: {},
  }, state);
  assert.ok(report.rows[0].reasons.some((reason) => reason.includes('Unsupported or noncanonical option Member class')));
  assert.ok(report.rows[1].reasons.includes('Active status contradicts Former/Resigned classification; metadata review required'));
  assert.ok(report.rows[2].reasons.includes('Title: Live field restricts writing'));
  assert.ok(report.rows.every((row) => row.outcome === 'blocked'));
});

test('reports nullable hierarchy schema blockers for otherwise-ready new rows', () => {
  const row = sourceRow(40);
  const state = baseState();
  state.columns.find((column) => column.column_name === 'organization_group_id').is_nullable = 'NO';
  const report = makeReport({
    fingerprint: 'synthetic',
    rows: [row],
    eligible: [row],
    excluded: [],
    duplicates: [],
    counts: {},
    dateCounts: {},
  }, state);
  assert.deepEqual(report.schemaBlockers, ['Nullable organization_group_id not confirmed']);
  assert.equal(report.rows[0].outcome, 'blocked');
  assert.ok(report.rows[0].reasons.includes('Nullable organization_group_id not confirmed'));
});