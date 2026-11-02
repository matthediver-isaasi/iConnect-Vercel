import test from 'node:test';
import assert from 'node:assert/strict';
import { collectAffiliationReviewRequests } from './formAffiliationReviewPolicy.js';
import { planRelationshipCurrentSet, relationshipCurrentSetVersion } from './formRelationshipCurrentSet.js';

const choice = (patch = {}) => ({
  fieldId: 'hospital', kind: 'organization', value: '__form_not_listed__',
  visible: true, notListedText: ' New hospital ', ...patch,
});
test('unlisted organisations and multiselect departments retain plain-text review evidence', () => {
  assert.deepEqual(collectAffiliationReviewRequests([
    choice(), choice({ fieldId: 'departments', kind: 'department', rowKey: 'row-1',
      value: ['existing-id', '__form_not_listed__'], notListedText: 'New department' }),
  ]), [
    { fieldId: 'hospital', kind: 'organization', rowKey: null, requestedName: 'New hospital' },
    { fieldId: 'departments', kind: 'department', rowKey: 'row-1', requestedName: 'New department' },
  ]);
});
test('hidden stale Other answers and known selections do not create review requests', () => {
  assert.deepEqual(collectAffiliationReviewRequests([
    choice({ visible: false }), choice({ value: 'known-id' }),
  ]), []);
});
test('reject missing visibility, missing names, overlong names and duplicate source entries', () => {
  for (const choices of [
    [choice({ visible: undefined })], [choice({ notListedText: '' })],
    [choice({ notListedText: 'x'.repeat(501) })], [choice(), choice()],
  ]) assert.throws(() => collectAffiliationReviewRequests(choices));
});
test('repeatable rows are separate review items even when field IDs match', () => {
  assert.equal(collectAffiliationReviewRequests([
    choice({ rowKey: 'one' }), choice({ rowKey: 'two' }),
  ]).length, 2);
});
test('review defers all affiliation mutations without blocking renewal or changing metadata', () => {
  const snapshot = {
    complete: true, tenantId: 'tenant', memberId: 'member', contextVersion: 'v1',
    sets: [{ id: 'departments', complete: true, definitionId: 'def', ownerSide: 'target', edges: [{
      id: 'edge', relatedId: 'department', tenantId: 'tenant', memberId: 'member',
      definitionId: 'def', ownerSide: 'target', version: 'v1', metadata: { role: 'Lead' },
    }] }],
  };
  const original = structuredClone(snapshot);
  const args = {
    snapshot, expectedVersion: relationshipCurrentSetVersion(snapshot),
    actor: { authenticated: true, tenantId: 'tenant', memberId: 'member' },
    selections: [{ setId: 'departments', state: 'replace', relatedIds: [] }],
    resolvedChoices: [choice()],
  };
  const plan = planRelationshipCurrentSet(args);
  assert.equal(plan.status, 'awaiting_review');
  assert.equal(plan.changed, false);
  assert.equal(plan.blocksRenewal, false);
  assert.deepEqual(plan.sets[0].retain, ['edge']);
  assert.deepEqual(plan.sets[0].archive, []);
  assert.deepEqual(plan.sets[0].add, []);
  assert.deepEqual(snapshot, original);
  assert.throws(() => planRelationshipCurrentSet({ ...args, actor: { ...args.actor, memberId: 'other' } }),
    error => error.code === 'forbidden');
  assert.throws(() => planRelationshipCurrentSet({ ...args, expectedVersion: 'stale' }),
    error => error.code === 'stale_snapshot');
});
