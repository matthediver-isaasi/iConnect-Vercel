import test from 'node:test';
import assert from 'node:assert/strict';
import { planRelationshipCurrentSet, relationshipCurrentSetVersion } from './formRelationshipCurrentSet.js';

function fixture() {
  const edge = (id, relatedId) => ({
    id, relatedId, tenantId: 'tenant-a', memberId: 'member-a',
    definitionId: 'definition-a', ownerSide: 'target', archivedAt: null,
    version: 'v1', metadata: { title: 'Existing role', since: '2020-01-01' },
  });
  const snapshot = {
    tenantId: 'tenant-a', memberId: 'member-a', complete: true, contextVersion: 'org-context-v1',
    sets: [{ id: 'departments', definitionId: 'definition-a', ownerSide: 'target', complete: true,
      edges: [edge('edge-primary', 'dept-primary'), edge('edge-secondary', 'dept-secondary')] }],
  };
  return {
    snapshot, expectedVersion: relationshipCurrentSetVersion(snapshot),
    actor: { authenticated: true, tenantId: 'tenant-a', memberId: 'member-a' },
    selections: [],
    eligibility: [{ setId: 'departments', complete: true, relatedIds: ['dept-primary', 'dept-secondary', 'dept-new'] }],
  };
}
function rejects(input, code) {
  assert.throws(() => planRelationshipCurrentSet(input), error => error.code === code);
}

test('unchanged sets retain the original edges and metadata without mutation', () => {
  const input = fixture(), before = structuredClone(input);
  const plan = planRelationshipCurrentSet(input);
  assert.equal(plan.changed, false);
  assert.deepEqual(plan.sets[0].retain, ['edge-primary', 'edge-secondary']);
  assert.deepEqual(input, before);
});

test('organisation move can replace primary department while retaining secondary affiliation', () => {
  const input = fixture();
  input.selections = [{ setId: 'departments', state: 'replace', relatedIds: ['dept-new', 'dept-secondary'] }];
  input.eligibility[0].relatedIds = ['dept-new', 'dept-secondary'];
  const plan = planRelationshipCurrentSet(input);
  assert.deepEqual(plan.sets[0].archive, ['edge-primary']);
  assert.deepEqual(plan.sets[0].retain, ['edge-secondary']);
  assert.deepEqual(plan.sets[0].add, ['dept-new']);
  assert.equal(plan.changed, true);
});

test('visible explicit empty selection archives all managed links', () => {
  const input = fixture();
  input.selections = [{ setId: 'departments', state: 'replace', relatedIds: [] }];
  assert.deepEqual(planRelationshipCurrentSet(input).sets[0].archive, ['edge-primary', 'edge-secondary']);
});

for (const state of ['hidden', 'unanswered']) test(`${state} empty or stale answers never clear existing links`, () => {
  const input = fixture();
  input.selections = [{ setId: 'departments', state, relatedIds: [] }];
  assert.equal(planRelationshipCurrentSet(input).changed, false);
});

test('invalid old affiliation requires review, not automatic deletion', () => {
  const input = fixture();
  input.eligibility[0].relatedIds = ['dept-secondary'];
  rejects(input, 'review_required');
});

test('explicit replacement cannot introduce a department outside final organisation scope', () => {
  const input = fixture();
  input.selections = [{ setId: 'departments', state: 'replace', relatedIds: ['foreign-department'] }];
  rejects(input, 'ineligible_selection');
});

test('complete eligibility is required even when clearing all relationships', () => {
  const input = fixture();
  input.selections = [{ setId: 'departments', state: 'replace', relatedIds: [] }];
  input.eligibility = [];
  rejects(input, 'incomplete_eligibility');
});

for (const patch of [{ authenticated: false }, { tenantId: 'tenant-b' }, { memberId: 'member-b' }]) {
  test(`reject unauthorized actor ${JSON.stringify(patch)}`, () => {
    const input = fixture();
    Object.assign(input.actor, patch);
    rejects(input, 'forbidden');
  });
}

test('stale metadata, links or organisation context invalidate the preview version', () => {
  for (const change of [
    input => { input.snapshot.sets[0].edges[0].metadata.title = 'Changed'; },
    input => { input.snapshot.sets[0].edges.pop(); },
    input => { input.snapshot.contextVersion = 'new-org-context'; },
  ]) {
    const input = fixture();
    change(input);
    rejects(input, 'stale_snapshot');
  }
});

test('row ordering and metadata key ordering do not create false conflicts', () => {
  const input = fixture();
  input.snapshot.sets[0].edges.reverse();
  input.snapshot.sets[0].edges[0].metadata = { since: '2020-01-01', title: 'Existing role' };
  assert.equal(relationshipCurrentSetVersion(input.snapshot), input.expectedVersion);
});

test('partial snapshots, inactive and cross-owner edges fail closed', () => {
  for (const change of [
    input => { input.snapshot.complete = false; },
    input => { input.snapshot.sets[0].complete = false; },
    input => { input.snapshot.sets[0].edges[0].tenantId = 'foreign'; },
    input => { input.snapshot.sets[0].edges[0].memberId = 'foreign'; },
    input => { input.snapshot.sets[0].edges[0].archivedAt = '2026-01-01'; },
    input => { input.snapshot.sets[0].edges.push(input.snapshot.sets[0].edges[0]); },
  ]) {
    const input = fixture();
    change(input);
    assert.throws(() => planRelationshipCurrentSet(input));
  }
});

test('overlapping definition scopes cannot issue contradictory replacements', () => {
  const input = fixture();
  input.snapshot.sets.push({ ...input.snapshot.sets[0], id: 'second-control', edges: [] });
  rejects(input, 'invalid_scope');
});

test('missing and duplicate replacement values are not interpreted as clearing', () => {
  for (const relatedIds of [undefined, null, '', ['dept-primary', 'dept-primary']]) {
    const input = fixture();
    input.selections = [{ setId: 'departments', state: 'replace', relatedIds }];
    rejects(input, 'invalid_input');
  }
});

test('definition ownership works in either direction without tenant-specific object names', () => {
  const input = fixture();
  input.snapshot.sets[0].ownerSide = 'source';
  input.snapshot.sets[0].edges.forEach(edge => { edge.ownerSide = 'source'; });
  input.expectedVersion = relationshipCurrentSetVersion(input.snapshot);
  assert.equal(planRelationshipCurrentSet(input).changed, false);
});
