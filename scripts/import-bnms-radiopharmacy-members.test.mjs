import assert from 'node:assert/strict';
import test from 'node:test';
import {
  EXPECTED_FILE_SHA256,
  HEADERS,
  ROW_COUNT,
  deterministicMemberId,
  makePlan,
  readSource,
} from './import-bnms-radiopharmacy-members.mjs';

test('source workbook is pinned to the approved exact 55-row shape', () => {
  const source = readSource();
  assert.equal(source.fingerprint, EXPECTED_FILE_SHA256);
  assert.equal(source.rows.length, ROW_COUNT);
  assert.deepEqual(HEADERS, ['Department UUID', 'First name', 'Last name', 'Email address']);
  assert.equal(new Set(source.rows.map((row) => row.email)).size, ROW_COUNT);
  assert.equal(new Set(source.rows.map((row) => row.departmentId)).size, ROW_COUNT);
});

test('deterministic member IDs are stable UUIDs and normalize email case', () => {
  const lower = deterministicMemberId('person@example.org');
  assert.equal(lower, deterministicMemberId(' Person@Example.org '));
  assert.match(lower, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/);
});

function fixture({ existing = false, archivedConflict = false } = {}) {
  const source = readSource();
  const activeParentByDepartment = new Map();
  const organizationById = new Map();
  const byEmail = new Map();
  const memberEdges = [];
  for (const [index, row] of source.rows.entries()) {
    const organizationId = `10000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
    activeParentByDepartment.set(row.departmentId, { source_record_id: row.departmentId, target_record_id: organizationId });
    organizationById.set(organizationId, { id: organizationId, tenant_id: 'tenant', status: 'active' });
    if (existing) {
      byEmail.set(row.email, {
        id: row.memberId, email: row.email, first_name: row.firstName, last_name: row.lastName,
        organization_id: organizationId, login_enabled: true, show_in_directory: true, is_guest: false,
      });
      memberEdges.push({
        id: `edge-${index}`, source_record_id: row.departmentId, target_record_id: row.memberId,
        archived_at: archivedConflict && index === 0 ? '2026-01-01T00:00:00Z' : null,
      });
    }
  }
  const sharon = { id: 'sharon' };
  return {
    source,
    model: { memberDefinition: { id: 'members-definition' } },
    state: {
      activeParentByDepartment, organizationById, byEmail, memberEdges,
      allMembers: existing ? [sharon, ...byEmail.values()] : [sharon],
    },
  };
}

test('clean pre-import state plans Member before matching Department edge', () => {
  const { source, state, model } = fixture();
  const plan = makePlan(source, state, model);
  assert.equal(plan.members.filter((row) => row.action === 'create').length, 55);
  assert.equal(plan.edges.filter((row) => row.action === 'create').length, 55);
  for (let index = 0; index < ROW_COUNT; index += 1) {
    assert.equal(plan.members[index].organizationId, state.activeParentByDepartment.get(source.rows[index].departmentId).target_record_id);
    assert.equal(plan.edges[index].memberId, plan.members[index].memberId);
  }
});

test('exact replay plans zero writes', () => {
  const { source, state, model } = fixture({ existing: true });
  const plan = makePlan(source, state, model);
  assert.ok(plan.members.every((row) => row.action === 'unchanged'));
  assert.ok(plan.edges.every((row) => row.action === 'unchanged'));
});

test('interrupted apply with committed Members safely resumes only missing edges', () => {
  const { source, state, model } = fixture({ existing: true });
  state.memberEdges = [];
  const plan = makePlan(source, state, model);
  assert.ok(plan.members.every((row) => row.action === 'unchanged'));
  assert.ok(plan.edges.every((row) => row.action === 'create'));
});

test('existing Member drift and archived edge history fail closed', () => {
  const memberDrift = fixture({ existing: true });
  memberDrift.state.byEmail.get(memberDrift.source.rows[0].email).organization_id = '20000000-0000-4000-8000-000000000000';
  assert.throws(() => makePlan(memberDrift.source, memberDrift.state, memberDrift.model), /never updated/);

  const archived = fixture({ existing: true, archivedConflict: true });
  assert.throws(() => makePlan(archived.source, archived.state, archived.model), /conflicting active or archived/);
});