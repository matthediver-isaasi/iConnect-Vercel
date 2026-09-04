import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ROLE_ID,
  ROLE_NAME,
  makePlan,
} from './assign-bnms-radiopharmacy-point-of-contact-role.mjs';
import { ROW_COUNT, TENANT_ID, readSource } from './import-bnms-radiopharmacy-members.mjs';

function fixture(roleId = null) {
  const importedSource = readSource();
  const source = {
    ...importedSource,
    rows: importedSource.rows.map((row, index) => ({
      ...row,
      memberId: row.id,
      departmentId: `40000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      email: `radiopharmacy-${index + 1}@example.test`,
      firstName: `First${index + 1}`,
      lastName: `Last${index + 1}`,
    })),
  };
  const importedMembers = [];
  const parentEdges = [];
  const memberEdges = [];
  for (const row of source.rows) {
    const organizationId = `10000000-0000-4000-8000-${String(row.sourceRow).padStart(12, '0')}`;
    importedMembers.push({
      id: row.memberId,
      tenant_id: TENANT_ID,
      email: row.email,
      first_name: row.firstName,
      last_name: row.lastName,
      organization_id: organizationId,
      role_id: roleId,
      role_effective_from: null,
      login_enabled: true,
      show_in_directory: true,
      is_guest: false,
    });
    parentEdges.push({
      tenant_id: TENANT_ID,
      source_record_id: row.departmentId,
      target_record_id: organizationId,
      archived_at: null,
    });
    memberEdges.push({
      tenant_id: TENANT_ID,
      source_record_id: row.departmentId,
      target_record_id: row.memberId,
      archived_at: null,
    });
  }
  return { source, state: { importedMembers, parentEdges, memberEdges } };
}

test('assignment is pinned to the approved BNMS Point of Contact role', () => {
  assert.equal(ROLE_ID, '0c329e46-898f-4660-acaf-c0d3d49993c0');
  assert.equal(ROLE_NAME, 'Point of Contact');
});

test('all-null role state plans exactly 55 assignments', () => {
  const { source, state } = fixture();
  const plan = makePlan(source, state);
  assert.equal(plan.assignments, ROW_COUNT);
  assert.equal(plan.unchanged, 0);
});

test('exact assigned role state plans zero writes', () => {
  const { source, state } = fixture(ROLE_ID);
  const plan = makePlan(source, state);
  assert.equal(plan.assignments, 0);
  assert.equal(plan.unchanged, ROW_COUNT);
});

test('mixed or different role state fails closed', () => {
  const mixed = fixture();
  mixed.state.importedMembers[0].role_id = ROLE_ID;
  assert.throws(() => makePlan(mixed.source, mixed.state), /Mixed role state/);

  const other = fixture();
  other.state.importedMembers[0].role_id = '20000000-0000-4000-8000-000000000000';
  assert.throws(() => makePlan(other.source, other.state), /another role/);
});

test('Member and Department mapping drift fails closed', () => {
  const memberDrift = fixture();
  memberDrift.state.importedMembers[0].show_in_directory = false;
  assert.throws(() => makePlan(memberDrift.source, memberDrift.state), /Member invariant/);

  const departmentDrift = fixture();
  departmentDrift.state.parentEdges[0].target_record_id = '30000000-0000-4000-8000-000000000000';
  assert.throws(() => makePlan(departmentDrift.source, departmentDrift.state), /Department-to-Organisation invariant/);
});

test('additional same-Organisation Departments are accepted without choosing a primary', () => {
  const extra = fixture();
  const member = extra.state.importedMembers[0];
  const departmentId = '50000000-0000-4000-8000-000000000001';
  extra.state.memberEdges.push({
    tenant_id: TENANT_ID, source_record_id: departmentId, target_record_id: member.id, archived_at: null,
  });
  extra.state.parentEdges.push({
    tenant_id: TENANT_ID, source_record_id: departmentId, target_record_id: member.organization_id, archived_at: null,
  });
  assert.equal(makePlan(extra.source, extra.state).assignments, ROW_COUNT);
});

test('duplicate and wrong-Organisation Department assignments fail closed', () => {
  const duplicate = fixture();
  duplicate.state.memberEdges.push({ ...duplicate.state.memberEdges[0], id: 'duplicate' });
  assert.throws(() => makePlan(duplicate.source, duplicate.state), /duplicate assignment/);

  const foreign = fixture();
  const member = foreign.state.importedMembers[0];
  const departmentId = '50000000-0000-4000-8000-000000000002';
  foreign.state.memberEdges.push({
    tenant_id: TENANT_ID, source_record_id: departmentId, target_record_id: member.id, archived_at: null,
  });
  foreign.state.parentEdges.push({
    tenant_id: TENANT_ID, source_record_id: departmentId, target_record_id: 'foreign-organization', archived_at: null,
  });
  assert.throws(() => makePlan(foreign.source, foreign.state), /Department-to-Organisation invariant/);
});