import test from 'node:test';
import assert from 'node:assert/strict';
import { APPROVED_ROWS, planRows, insertRow, verifySafeMembers, main, automaticBoundary, applyRegionalPolicy, resultFilename, sideEffectAudit } from './import-bnms-final-members.mjs';

test('regional approval flag removes only regional holds, preserving fresh identity conflicts', () => {
  const rows = [{ sourceRow: 17, outcome: 'insert' }, { sourceRow: 19, outcome: 'held-fresh', reasons: ['identity conflict'] }];
  const boundary = { heldRows: [17, 19] };
  assert.equal(applyRegionalPolicy(rows, boundary)[0].outcome, 'held-fresh');
  assert.deepEqual(applyRegionalPolicy(rows, boundary, true), rows);
});
test('all-reused replay writes separate result; unknown schema cannot bypass side-effect audit', () => {
  assert.equal(resultFilename(0, 47), 'replay-result.json');
  assert.equal(resultFilename(47, 0), 'result.json');
  assert.throws(() => sideEffectAudit({ columns: [], triggers: [], functions: [] }), /audit drifted/);
});

test('automatic boundary holds exact matches, accepts missing regions, fails closed on unknown rules', () => {
  const field = '91e58f93-f78f-465e-948b-c4808aecd89c';
  const condition = (scope, id) => ({ entity_scope: scope, field_type: 'custom', field_key: id, operator: 'equals', data_type: 'select', value: 'Region' });
  const group = { id: 'g', automatic_membership_role: 'Member', automatic_membership_filter_groups: [
    { conditions: [condition('member', '0e3e3b1f-5a3d-40b5-a4b5-f0761c115216')] },
    { conditions: [condition('organization', field)] },
  ] };
  const values = Array(21).fill(''); values[12] = 'org';
  const source = { rows: [{ sourceRow: 3, values }, { sourceRow: 4, values: Array(21).fill('') }] };
  assert.deepEqual(automaticBoundary(source, [group], [{ organization_id: 'org', field_id: field, value: 'Region' }]).heldRows, [3]);
  assert.deepEqual(automaticBoundary(source, [group], []).heldRows, []);
  const unknown = structuredClone(group); unknown.automatic_membership_filter_groups[0].conditions[0].operator = 'not_equals';
  assert.throws(() => automaticBoundary(source, [unknown], []), /Unknown automatic condition/);
  assert.throws(() => automaticBoundary(source, [group], [1, 2].map(() => ({ organization_id: 'org', field_id: field, value: 'Region' }))), /Ambiguous/);
});

test('47 pinned rows forever exclude original exceptions and retain 71', () => {
  assert.equal(APPROVED_ROWS.length, 47);
  assert.ok(APPROVED_ROWS.includes(71));
  for (const row of [2, 40, 65, 75, 76, 77, 79, 80]) assert.ok(!APPROVED_ROWS.includes(row));
});
test('fresh conflicts hold, existing identities cannot be adopted, journal identities replay', () => {
  const report = { rows: [
    { sourceRow: 3, outcome: 'ready-new', memberIds: [], reasons: [] },
    { sourceRow: 4, outcome: 'existing-unchanged', memberIds: ['other'], reasons: [] },
    { sourceRow: 5, outcome: 'existing-unchanged', memberIds: ['owned'], reasons: [] },
    { sourceRow: 40, outcome: 'ready-new', memberIds: [], reasons: [] },
    { sourceRow: 75, outcome: 'user-excluded', memberIds: [], reasons: [] },
    { sourceRow: 6, outcome: 'blocked', memberIds: [], reasons: ['conflict'] },
  ] };
  const plan = planRows(report, { members: [{ sourceRow: 3, memberId: 'reserved' }, { sourceRow: 5, memberId: 'owned' }] });
  assert.deepEqual(plan.map(r => r.outcome), ['insert', 'held-fresh', 'already-imported', 'held-original', 'excluded', 'held-fresh']);
  assert.equal(plan[0].memberId, 'reserved');
});
test('insert SQL restricts columns and explicitly disables access, directory, historical dates', async () => {
  const queries = [];
  const client = { query: async (sql, args) => { queries.push({ sql, args }); return { rows: [] }; } };
  const values = Array(21).fill(''); values[0] = '123'; values[5] = 'First'; values[6] = 'Last';
  await insertRow(client, { values, email: 'test@example.invalid' }, 'reserved');
  assert.equal(queries.length, 2);
  assert.match(queries[0].sql, /false,null,null,null,null,false/);
  assert.ok(queries.every(q => /^insert into public\.(member|member_preference_value|member_resource_category)/.test(q.sql)));
  assert.equal(queries[0].args[6], null);
  assert.equal(queries[0].args[7], null);
});
test('unsafe access readback fails', async () => {
  await assert.rejects(verifySafeMembers({ query: async () => ({ rows: [{ login_enabled: true }] }) }, ['id']), /safety verification/);
});
test('CLI requires schema review and rejects alternate source/target', async () => {
  for (const args of [['--apply'], ['--apply', '--allow-existing-regional-rules'], ['--allow-existing-regional-rules', '--allow-existing-regional-rules'], ['--file=x'], ['--tenant=x']]) await assert.rejects(main(args));
});