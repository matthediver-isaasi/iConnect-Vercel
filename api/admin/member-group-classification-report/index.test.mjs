import assert from 'node:assert/strict';
import test from 'node:test';

import {
  calculateOrganisationCounts,
  fetchAllRows,
} from './index.js';

test('counts distinct non-empty organisations per group and classification', () => {
  const assignments = [
    { id: 'a1', group_id: 'g1', member_id: 'm1' },
    { id: 'a2', group_id: 'g1', member_id: 'm2' },
    { id: 'a3', group_id: 'g1', member_id: 'm3' },
    { id: 'a4', group_id: 'g2', member_id: 'm4' },
    { id: 'a5', group_id: 'g2', member_id: 'm5' },
  ];
  const members = [
    { id: 'm1', organization_id: 'org-1' },
    { id: 'm2', organization_id: 'org-1' },
    { id: 'm3', organization_id: null },
    { id: 'm4', organization_id: 'org-1' },
    { id: 'm5', organization_id: 'org-2' },
  ];

  const result = calculateOrganisationCounts(assignments, members);

  assert.equal(result.countByGroupId.get('g1'), 1);
  assert.equal(result.countByGroupId.get('g2'), 2);
  assert.equal(result.total, 2);
});

test('counts organisations across more than 1,000 assigned members', () => {
  const assignments = Array.from({ length: 1505 }, (_, index) => ({
    id: `a${index}`,
    group_id: index < 1100 ? 'g1' : 'g2',
    member_id: `m${index}`,
  }));
  const members = assignments.map((assignment, index) => ({
    id: assignment.member_id,
    organization_id: index % 10 === 0 ? null : `org-${index % 1200}`,
  }));

  const result = calculateOrganisationCounts(assignments, members);
  const expectedTotal = new Set(members.map((m) => m.organization_id).filter(Boolean)).size;

  assert.equal(result.total, expectedTotal);
  assert.equal(result.countByGroupId.get('g1'), 990);
  assert.equal(result.countByGroupId.get('g2'), 364);
});

test('fetchAllRows reads every ordered page past the PostgREST row cap', async () => {
  const source = Array.from({ length: 2005 }, (_, index) => ({ id: index + 1 }));
  const requestedRanges = [];
  const buildQuery = () => ({
    order(column, options) {
      assert.equal(column, 'id');
      assert.deepEqual(options, { ascending: true });
      return this;
    },
    async range(from, to) {
      requestedRanges.push([from, to]);
      return { data: source.slice(from, to + 1), error: null };
    },
  });

  const rows = await fetchAllRows(buildQuery);

  assert.equal(rows.length, 2005);
  assert.deepEqual(requestedRanges, [
    [0, 999],
    [1000, 1999],
    [2000, 2999],
  ]);
});