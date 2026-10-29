import test from 'node:test';
import assert from 'node:assert/strict';
import { TEAM_COLUMNS, sortTeamMembers, paginateTeamMembers, formatTeamDate, activityState, loadTeamMembers } from './teamDirectory.mjs';

const roles = [{ id: 'z', name: 'Alpha' }, { id: 'a', name: 'Zulu' }];
const rows = [
  { id: 'b', organization_id: 'org', first_name: 'BOB', last_name: 'Zulu', email: 'z@example.invalid', role_id: 'a', created_on: '2025-01-01', last_activity: '2026-02-01T00:00:00Z' },
  { id: 'a', organization_id: 'org', first_name: 'alice', last_name: 'Alpha', email: 'a@example.invalid', role_id: 'z', created_on: '2024-12-31', last_activity: '2026-01-31T23:00:00Z' },
  { id: 'c', organization_id: 'org', last_activity: null },
];
for (const { key } of TEAM_COLUMNS) {
  for (const direction of ['asc', 'desc']) {
    test(`${key} ${direction}, nulls last, immutable input`, () => {
      const before = structuredClone(rows);
      assert.deepEqual(sortTeamMembers(rows, roles, key, direction).map(row => row.id),
        direction === 'asc' ? ['a', 'b', 'c'] : ['b', 'a', 'c']);
      assert.deepEqual(rows, before);
    });
    test(`${key} deterministic ID tie break ${direction}`, () => {
      assert.deepEqual(sortTeamMembers([{ ...rows[0], id: 'z' }, { ...rows[0], id: 'a' }], roles, key, direction).map(row => row.id), ['a', 'z']);
    });
  }
}
test('case insensitive names and chronological offsets; invalid dates remain last', () => {
  assert.deepEqual(sortTeamMembers([{ id: 'z', first_name: 'alice' }, { id: 'a', first_name: 'ALICE' }], [], 'first_name', 'desc').map(r => r.id), ['a', 'z']);
  const dates = [{ id: 'a', created_on: '2026-01-01T00:00:00+02:00' }, { id: 'b', created_on: '2025-12-31T23:00:00Z' }, { id: 'c', created_on: 'bad' }];
  assert.deepEqual(sortTeamMembers(dates, [], 'created_on', 'asc').map(r => r.id), ['a', 'b', 'c']);
  assert.deepEqual(sortTeamMembers(dates, [], 'created_on', 'desc').map(r => r.id), ['b', 'a', 'c']);
});
test('join/activity formatting distinguishes absent projection, null and malformed dates', () => {
  for (const value of [null, undefined, '', 'bad', '2026-02-30', true, 123]) assert.equal(formatTeamDate(value), '—');
  assert.match(formatTeamDate('2026-01-12'), /12 Jan 2026/);
  assert.equal(activityState({ last_activity: null, login_enabled: false }), 'never');
  assert.equal(activityState({}), 'unknown');
  for (const value of ['', 'bad', '2026-02-30', undefined]) assert.equal(activityState({ last_activity: value }), 'unknown');
  assert.equal(activityState({ last_activity: '2026-01-12', login_enabled: false }), 'recorded');
});
test('all sizes, empty and shrinking datasets clamp safely', () => {
  const many = Array.from({ length: 126 }, (_, id) => ({ id }));
  for (const size of [9, 25, 50, 100, 'all']) {
    const result = paginateTeamMembers(many, 999, size);
    assert.equal(result.end, 126);
    assert.ok(result.members.length > 0);
    assert.equal(result.page, result.totalPages);
  }
  assert.deepEqual(paginateTeamMembers([], 8, 'all'), { members: [], page: 1, totalPages: 1, start: 0, end: 0, total: 0 });
  assert.equal(paginateTeamMembers(rows, 8, 9).page, 1);
  const filteredSorted = sortTeamMembers(rows.filter(r => r.first_name), roles, 'first_name', 'asc');
  assert.deepEqual(paginateTeamMembers(filteredSorted, 1, 9).members.map(r => r.id), ['a', 'b']);
});
test('complete stable scoped multi-batch load even with a lower provider cap', async () => {
  const many = Array.from({ length: 1105 }, (_, id) => ({ id: String(id).padStart(4, '0'), organization_id: 'org', last_activity: null }));
  const calls = [];
  const signal = new AbortController().signal;
  const result = await loadTeamMembers({ list: async options => {
    calls.push(options);
    assert.deepEqual(options.filter, { organization_id: 'org' });
    assert.deepEqual(options.sort, { id: 'asc' });
    assert.equal(options.signal, signal);
    return { data: many.slice(options.offset, options.offset + 500), count: many.length };
  } }, 'org', signal);
  assert.equal(result.length, 1105);
  assert.deepEqual(calls.map(c => c.offset), [0, 500, 1000]);
  assert.equal(paginateTeamMembers(result, 1, 'all').members.length, 1105);
});
test('batch failure, missing activity projection, duplicate, inconsistent counts and short feed fail explicitly', async () => {
  let call = 0;
  await assert.rejects(loadTeamMembers({ list: async () => {
    if (call++) throw new Error('offline');
    return { data: [rows[0]], count: 3 };
  } }, 'org'), /offline/);
  for (const response of [
    { data: [{ id: 'x', organization_id: 'org' }], count: 1 },
    { data: [rows[0], rows[0]], count: 2 },
    { data: [{ ...rows[0], organization_id: 'wrong' }], count: 1 },
    { data: [], count: 1 }, [],
  ]) await assert.rejects(loadTeamMembers({ list: async () => response }, 'org'));
  call = 0;
  await assert.rejects(loadTeamMembers({ list: async () => ({ data: [rows[call]], count: call++ ? 3 : 2 }) }, 'org'), /changed/);
});
