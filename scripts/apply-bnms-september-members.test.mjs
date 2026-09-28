import test from 'node:test';
import assert from 'node:assert/strict';
import { plan, insertMember, verifyImported, main } from './apply-bnms-september-members.mjs';
import { FIELDS } from './bnms-september-source.mjs';
test('reserved IDs recover after rollback; journal-owned matching records replay without writes', () => {
  const row = { sourceRow: 7, outcome: 'held-side-effects', parentOrganizationIds: ['org1', 'org2'], departmentLinks: [{ departmentId: 'd1', organizationId: 'org1', definitionId: 'def' }, { departmentId: 'd2', organizationId: 'org2', definitionId: 'def' }] };
  const first = plan({ rows: [row] }, null);
  const journal = { members: first };
  assert.deepEqual(plan({ rows: [row] }, journal), first);
  const replay = plan({ rows: [{ ...row, outcome: 'already-present-matching', memberIds: [first[0].memberId] }] }, journal);
  assert.equal(replay[0].outcome, 'already-imported');
  assert.equal(plan({ rows: [{ ...row, outcome: 'already-present-matching', memberIds: ['other'] }] }, journal)[0].outcome, 'already-present-matching');
  assert.equal(plan({ rows: [{ ...row, outcome: 'held-validation', reasons: ['identity conflict'] }] }, journal)[0].outcome, 'held');
});
test('multi-Department writes all parent assignments and links, with no primary selection or access', async () => {
  const values = Array(18).fill(''); values[0] = '123'; values[5] = 'First'; values[6] = 'Last';
  const row = { sourceRow: 7, values, email: 'test@example.invalid', organizationId: null, focusAreas: [], outcome: 'held-side-effects',
    parentOrganizationIds: ['org1', 'org2'], departmentLinks: [{ departmentId: 'd1', organizationId: 'org1', definitionId: 'def' }, { departmentId: 'd2', organizationId: 'org2', definitionId: 'def' }] };
  const queries = [];
  await insertMember({ query: async (sql, args) => { queries.push({ sql, args }); } }, row, plan({ rows: [row] }, null)[0]);
  assert.equal(queries.filter(q => /insert into public.custom_object_record/.test(q.sql)).length, 2);
  assert.equal(queries.filter(q => /insert into public.custom_object_relationship/.test(q.sql)).length, 6);
  assert.match(queries[0].sql, /false,null,null,null,null,false/);
  assert.equal(queries[0].args[7], null);
  assert.ok(queries.every(q => /^insert into public\.(member|member_preference_value|member_resource_category|custom_object_record|custom_object_relationship)\b/.test(q.sql)));
  assert.equal(queries.find(q => /member_preference_value/.test(q.sql)).args[1], FIELDS[0].id);
});
test('readback rejects missing owned identity and CLI rejects unauthorized old flags', async () => {
  await assert.rejects(verifyImported({}, { rows: [] }, {}, { members: [{ sourceRow: 7 }] }), /readback/);
  for (const args of [['--apply'], ['--allow-existing-regional-rules'], ['--replay', '--apply'], ['--review=' + 'a'.repeat(64)]]) await assert.rejects(main(args));
});