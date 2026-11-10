import test from 'node:test';
import assert from 'node:assert/strict';
import { applyRows, assertReview, digest, verifyPreservation } from './import-bnms-student-dates.mjs';
import { FIELD, TENANT } from './bnms-student-dates-source.mjs';

const member = '00000000-0000-4000-8000-000000000001';
const row = { member_id: member, value: '2028-09-18', outcome: 'update', before: [] };
test('changed preflight and missing metadata approval prevent apply', () => {
  const plan = { beforeHash: 'old', rows: [row] };
  const hash = digest(plan);
  assert.doesNotThrow(() => assertReview(plan, hash, true));
  assert.throws(() => assertReview(plan, hash, false), /consent/);
  assert.throws(() => assertReview({ ...plan, beforeHash: 'concurrent' }, hash, true), /Preflight changed/);
});
test('held and unchanged rows issue no writes; reruns are idempotent', async () => {
  let calls = 0;
  const db = { query: async () => { calls++; throw Error('Unexpected write'); } };
  assert.equal(await applyRows(db, [{ ...row, outcome: 'held' }, { ...row, outcome: 'unchanged' }]), 0);
  assert.equal(calls, 0);
});
test('inserts bind tenant and field, guard absence, and fail on conflicts', async () => {
  const db = { query: async (sql, args) => {
    assert.match(sql, /m\.tenant_id=\$3/);
    assert.match(sql, /not exists/);
    assert.equal(args[1], FIELD);
    assert.equal(args[2], TENANT);
    assert.equal(JSON.parse(args[0]).length, 1);
    return { rowCount: 0 };
  } };
  await assert.rejects(applyRows(db, [row]), /insert conflict/);
  assert.equal(await applyRows({ query: async () => ({ rowCount: 1 }) }, [row]), 1);
});
test('overwrites compare full before-image and never silently accept zero writes', async () => {
  const update = { ...row, before: [{ id: member, member_id: member, field_id: FIELD, value: '2020-01-01' }] };
  await assert.rejects(applyRows({ query: async (sql, args) => {
    assert.match(sql, /to_jsonb\(p\)=r\.before->0/);
    assert.match(sql, /p\.field_id=\$2/);
    assert.match(sql, /m\.tenant_id=\$3/);
    assert.equal(JSON.parse(args[0])[0].before[0].value, '2020-01-01');
    return { rowCount: 0 };
  } }, [update]), /update conflict/);
  await assert.rejects(applyRows({ query: async () => { throw Error('DB error'); } }, [update]), /DB error/);
});
test('preservation permits only approved metadata and managed preference changes', () => {
  const before = {
    members: [{ id: member, tenant_id: TENANT, role_id: null, updated_at: 'old', survey_invitation_revision: 4 }],
    preferences: [], fields: [{ id: FIELD }], groups: [],
  };
  const after = structuredClone(before);
  after.members[0].updated_at = 'new';
  after.members[0].survey_invitation_revision = 5;
  after.preferences.push({ member_id: member, field_id: FIELD, value: row.value });
  assert.doesNotThrow(() => verifyPreservation(before, after, [row]));
  for (const mutate of [
    s => { s.members[0].role_id = member; },
    s => { s.members[0].survey_invitation_revision = 6; },
    s => { s.groups.push({ unexpected: true }); },
    s => { s.preferences.push({ member_id: member, field_id: member, value: 'unexpected' }); },
    s => { s.fields[0].id = member; },
  ]) {
    const invalid = structuredClone(after); mutate(invalid);
    assert.throws(() => verifyPreservation(before, invalid, [row]));
  }
});
