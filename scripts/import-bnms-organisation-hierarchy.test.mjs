import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { makePlan, readSource } from './import-bnms-organisation-hierarchy.mjs';

const keyFor = (value) => String(value).normalize('NFKC')
  .replace(/[\u2018\u2019\u02bc]/g, "'").replace(/[\u201c\u201d]/g, '"')
  .replace(/[\u0096\u2010-\u2015-]+/g, ' ').replace(/\s+/g, ' ')
  .trim().toLocaleLowerCase('en-GB');

test('BNMS hierarchy source pins all 310 departments and six normalized type totals', () => {
  const source = readSource();
  assert.equal(source.rows.length, 310);
  assert.equal(source.pairs.size, 310);
  assert.equal(source.organisations.size, 231);
  assert.deepEqual(
    Object.fromEntries([...source.types.values()].map(({ name, count }) => [name, count])),
    {
      'Nuclear Medicine - Physics based': 32,
      'PET Centre': 33,
      Radiopharmacy: 71,
      'Radiology based Nuclear Medicine': 95,
      'Nuclear Medicine Stand Alone': 78,
      'Nuclear Cardiology': 1,
    },
  );
});

function matchingState(source, { missingOrganisation = false, conflictingType = false } = {}) {
  const organisationMap = new Map();
  const departmentsByOrganisationAndName = new Map();
  const edgeBySource = new Map();
  const typeByName = new Map();
  const typeEdgeByDepartment = new Map();
  let departmentNumber = 0;
  for (const [key, row] of source.organisations) {
    organisationMap.set(key, { id: `org-${organisationMap.size}`, organization_group_id: row.groupId });
  }
  if (missingOrganisation) organisationMap.delete(source.organisations.keys().next().value);
  for (const row of source.rows) {
    const organisation = organisationMap.get(keyFor(row.organisationName));
    if (!organisation) continue;
    const department = { id: `department-${departmentNumber++}`, data: { name: row.departmentName } };
    departmentsByOrganisationAndName.set(
      `${organisation.id}::${keyFor(row.departmentName)}`,
      department,
    );
    edgeBySource.set(department.id, { id: `organisation-edge-${department.id}`, target_record_id: organisation.id });
  }
  for (const [key, type] of source.types) typeByName.set(key, { id: `type-${key}`, data: { name: type.name } });
  for (const department of departmentsByOrganisationAndName.values()) {
    const typeKey = keyFor(department.data.name);
    typeEdgeByDepartment.set(department.id, {
      id: `type-edge-${department.id}`,
      target_record_id: conflictingType ? 'wrong-type' : typeByName.get(typeKey).id,
    });
  }
  return { organisationMap, departmentsByOrganisationAndName, edgeBySource, typeByName, typeEdgeByDepartment };
}

test('Department Type plan creates only six shared types then exactly 310 links and replays cleanly', () => {
  const source = readSource();
  const state = matchingState(source);
  state.typeByName.clear();
  state.typeEdgeByDepartment.clear();
  const plan = makePlan(source, { definition: { cardinality: 'many_to_one' } }, state);
  assert.equal(plan.departments.length, 310);
  assert.equal(plan.departments.filter((item) => item.typeAction === 'create').length, 310);
  assert.equal(new Set(plan.departments.filter((item) => item.typeAction === 'create')
    .map((item) => item.row.departmentName)).size, 6);
  assert.equal(plan.departments.filter((item) => item.typeRelationshipAction === 'create').length, 310);

  const replay = makePlan(source, { definition: { cardinality: 'many_to_one' } }, matchingState(source));
  assert.equal(replay.departments.filter((item) => item.typeAction !== 'unchanged').length, 0);
  assert.equal(replay.departments.filter((item) => item.typeRelationshipAction !== 'unchanged').length, 0);
});

test('Department Type plan fails closed for missing, duplicate-resolution, or conflicting existing state', () => {
  const source = readSource();
  assert.throws(
    () => makePlan(source, { definition: { cardinality: 'many_to_one' } }, matchingState(source, { missingOrganisation: true })),
    /missing, archived, or has a conflicting Organisation Group/,
  );
  assert.throws(
    () => makePlan(source, { definition: { cardinality: 'many_to_one' } }, matchingState(source, { conflictingType: true })),
    /conflicting active Department Type link/,
  );
  const duplicate = matchingState(source);
  const first = duplicate.departmentsByOrganisationAndName.entries().next().value;
  const second = [...duplicate.departmentsByOrganisationAndName.keys()][1];
  duplicate.departmentsByOrganisationAndName.set(second, first[1]);
  duplicate.typeEdgeByDepartment.clear();
  assert.throws(
    () => makePlan(source, { definition: { cardinality: 'many_to_one' } }, duplicate),
    /do not resolve to 310 distinct existing Department records/,
  );
});

test('Department Type migration is pinned, idempotent, and rejects incompatible schema state', async () => {
  const sql = await readFile(new URL('../supabase/migrations/20260924_bnms_department_type_normalization.sql', import.meta.url), 'utf8');
  assert.match(sql, /v_tenant uuid := 'ff2df806-b321-4254-b651-3af11fccf1db'/);
  assert.match(sql, /object_key = 'department_type'/);
  assert.match(sql, /IF v_count > 1 THEN RAISE EXCEPTION 'More than one BNMS Department Type object exists'/);
  assert.match(sql, /Existing BNMS Department Type object is incompatible/);
  assert.match(sql, /Existing BNMS Department Type name field is incompatible/);
  assert.match(sql, /Existing BNMS Department Type relationship is incompatible/);
  assert.match(sql, /'many_to_one', 'Department Type'/);
});