import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildResetPlan, TENANT_ID } from './bnms-communication-reset-plan.mjs';

const row = (id, extra = {}) => ({ id, tenant_id: TENANT_ID, ...extra });
const fixture = () => ({
  members: [
    row('a', { email: ' ALICE@Example.org ', role_id: 'r1', communications_opted_out_all: true }),
    row('b', { email: 'bob@example.org', role_id: ['r2'], login_enabled: false, communications_opted_out_all: null }),
    row('c', { email: null, role_id: null, communications_opted_out_all: false }),
    row('d', { email: ' deleted_X@deleted.local ', role_id: 'r1', communications_opted_out_all: true }),
    row('e', { email: 'e@example.org', role_id: 'r1', status: 'Anonymized' }),
  ],
  categories: [
    row('open', { is_active: true }),
    row('restricted', { is_active: true }),
    row('public', { is_active: true, member_enabled: false, is_public: true }),
    row('inactive', { is_active: false }),
  ],
  roles: [row('r1'), row('r2')],
  assignments: [
    row('ar', { category_id: 'restricted', role_id: 'r1' }),
    row('ai', { category_id: 'inactive', role_id: 'r1' }),
  ],
  preferences: [
    row('p1', { member_id: 'a', category_id: 'restricted', is_subscribed: false }),
    row('p2', { member_id: 'b', category_id: 'open', is_subscribed: true }),
    row('p3', { member_id: 'c', category_id: 'open', is_subscribed: null }),
  ],
  ledgers: [
    row('l1', { email: 'alice@example.org', member_id: 'a', unsubscribe_type: 'all', communication_category_id: null }),
    row('l2', { email: ' ALICE@example.org ', member_id: null, unsubscribe_type: 'category', communication_category_id: 'restricted' }),
    row('l3', { email: 'alice@example.org', unsubscribe_type: 'category', communication_category_id: 'inactive' }),
    row('l4', { email: 'bob@example.org', unsubscribe_type: 'category', communication_category_id: 'restricted' }),
    row('l5', { email: 'alice@example.org', unsubscribe_type: 'campaign', communication_category_id: null }),
    row('l6', { email: 'unrelated@example.org', unsubscribe_type: 'all' }),
  ],
  subscribers: [row('s1', { email: '  ALICE@example.org ', opted_out: false })],
});

test('plans active eligible memberships including disabled login and missing emails, preserving unrelated suppressions', () => {
  const input = fixture();
  const original = structuredClone(input);
  const plan = buildResetPlan(input);
  assert.deepEqual(input, original, 'planning does not mutate the snapshot');
  assert.deepEqual(plan.members, [
    { id: 'a', email: 'alice@example.org', categoryIds: ['open', 'restricted'], clearGlobal: true,
      addCategoryIds: ['open'], changeCategoryIds: ['restricted'] },
    { id: 'b', email: 'bob@example.org', categoryIds: ['open'], clearGlobal: true,
      addCategoryIds: [], changeCategoryIds: [] },
    { id: 'c', email: null, categoryIds: ['open'], clearGlobal: false,
      addCategoryIds: [], changeCategoryIds: ['open'] },
  ]);
  assert.deepEqual(plan.removeLedgerIds, ['l1', 'l2']);
  assert.deepEqual(plan.summary, {
    totalMembers: 5, excludedDeleted: 2, membersCovered: 3, disabledLoginMembers: 1,
    missingEmails: 1, orphanPreferences: 0, historicalEmailSuppressions: 0,
    duplicateEmailGroups: 0, subscriptionsAdded: 1,
    subscriptionsChanged: 2, globalFlagsCleared: 1, globalFlagsNormalized: 1,
    globalSuppressionsRemoved: 1, categorySuppressionsRemoved: 1,
    eligiblePairs: 4, overlappingSubscribers: 1,
  });
});

test('duplicate normalized emails with identical eligible sets are permitted and counted', () => {
  const input = fixture();
  input.members.push(row('aa', { email: ' Alice@EXAMPLE.org ', role_id: ['r1'], communications_opted_out_all: false }));
  input.ledgers.push(row('l7', { email: 'ALICE@example.org', member_id: 'aa', unsubscribe_type: 'all' }));
  const plan = buildResetPlan(input);
  assert.equal(plan.summary.duplicateEmailGroups, 1);
  assert.deepEqual(plan.removeLedgerIds, ['l1', 'l2', 'l7']);
  assert.deepEqual(plan.members.find((member) => member.id === 'aa').categoryIds, ['open', 'restricted']);
});

test('duplicate normalized emails with distinct eligible categories fail closed', () => {
  const input = fixture();
  input.members.push(row('aa', { email: 'alice@example.org', role_id: ['r2'] }));
  assert.throws(() => buildResetPlan(input), /Conflicting eligible categories/);
});

test('all collections reject foreign tenants even for rows referencing a target member', () => {
  for (const collection of Object.keys(fixture())) {
    const input = fixture();
    input[collection][0].tenant_id = 'other';
    assert.throws(() => buildResetPlan(input), /tenant_id mismatch/, collection);
  }
  const input = fixture();
  input.preferences.push(row('corrupt', { member_id: 'a', category_id: 'open', is_subscribed: false, tenant_id: 'other' }));
  assert.throws(() => buildResetPlan(input), /tenant_id mismatch/);
});

test('invalid cross-references in preferences, assignments, member roles, ledgers and subscribers fail', () => {
  for (const [collection, item, key] of [
    ['preferences', 0, 'member_id'], ['preferences', 0, 'category_id'],
    ['assignments', 0, 'category_id'], ['assignments', 0, 'role_id'],
    ['members', 0, 'role_id'], ['ledgers', 0, 'member_id'],
    ['ledgers', 1, 'communication_category_id'],
    ['subscribers', 0, 'communication_category_id'],
  ]) {
    const input = fixture();
    input[collection][item][key] = 'other';
    assert.throws(() => buildResetPlan(input), /unknown or cross-tenant/, `${collection}.${key}`);
  }
  const input = fixture();
  input.members[1].role_id = ['r2', 'unknown'];
  assert.throws(() => buildResetPlan(input), /unknown or cross-tenant/);
});

test('ledger member id must belong to the normalized email group; ambiguous ledger types fail', () => {
  const input = fixture();
  input.ledgers[0].member_id = 'b';
  assert.throws(() => buildResetPlan(input), /outside email group/);
  const ambiguous = fixture();
  ambiguous.ledgers[0].communication_category_id = 'open';
  assert.throws(() => buildResetPlan(ambiguous), /Ambiguous ledger/);
  const withoutCategory = fixture();
  withoutCategory.ledgers[1].communication_category_id = null;
  assert.throws(() => buildResetPlan(withoutCategory), /Ambiguous ledger/);
});

test('orphan preferences and historical email suppressions remain untouched and are counted', () => {
  const input = fixture();
  input.preferences.push(row('orphan', {
    member_id: null, category_id: 'open', is_subscribed: false,
  }));
  input.ledgers.push(
    row('old1', { email: 'previous@example.org', member_id: 'a',
      unsubscribe_type: 'category', communication_category_id: 'restricted' }),
    row('old2', { email: 'former@example.org', member_id: 'a', unsubscribe_type: 'all' }),
  );
  input.members[2].email = '   ';
  const plan = buildResetPlan(input);
  assert.equal(plan.members.find((member) => member.id === 'c').email, null);
  assert.equal(plan.summary.missingEmails, 1);
  assert.equal(plan.summary.orphanPreferences, 1);
  assert.equal(plan.summary.historicalEmailSuppressions, 2);
  assert.deepEqual(plan.removeLedgerIds, ['l1', 'l2']);
});

test('orphan preferences still require valid categories and unknown nonnull member references fail', () => {
  const orphan = fixture();
  orphan.preferences[0].member_id = null;
  orphan.preferences[0].category_id = 'other';
  assert.throws(() => buildResetPlan(orphan), /unknown or cross-tenant/);
  const unknown = fixture();
  unknown.preferences[0].member_id = 'other';
  assert.throws(() => buildResetPlan(unknown), /unknown or cross-tenant/);
  const historical = fixture();
  historical.ledgers[0].email = 'previous@example.org';
  historical.ledgers[0].member_id = 'other';
  assert.throws(() => buildResetPlan(historical), /unknown or cross-tenant/);
});

test('current-email ledger linked to a different member fails even when old address matches that member', () => {
  const input = fixture();
  input.members.push(row('historical', { email: 'past@example.org' }));
  input.ledgers.push(row('ambiguous', {
    email: 'alice@example.org', member_id: 'historical', unsubscribe_type: 'all',
  }));
  assert.throws(() => buildResetPlan(input), /outside email group/);
});

test('external overlapping opted-out subscriber fails closed without editing subscriber rows', () => {
  const input = fixture();
  input.subscribers[0].opted_out = true;
  assert.throws(() => buildResetPlan(input), /Conflicting opted-out external subscriber/);
});

test('simulated application of the plan is idempotent', () => {
  const input = fixture();
  const first = buildResetPlan(input);
  for (const target of first.members) {
    const member = input.members.find((candidate) => candidate.id === target.id);
    if (target.clearGlobal) member.communications_opted_out_all = false;
    for (const categoryId of target.addCategoryIds) {
      input.preferences.push(row(`added-${target.id}-${categoryId}`, {
        member_id: target.id, category_id: categoryId, is_subscribed: true,
      }));
    }
    for (const categoryId of target.changeCategoryIds) {
      input.preferences.find((preference) =>
        preference.member_id === target.id && preference.category_id === categoryId
      ).is_subscribed = true;
    }
  }
  input.ledgers = input.ledgers.filter((ledger) => !first.removeLedgerIds.includes(ledger.id));
  const second = buildResetPlan(input);
  assert.deepEqual(second.removeLedgerIds, []);
  assert.ok(second.members.every((member) =>
    !member.clearGlobal && !member.addCategoryIds.length && !member.changeCategoryIds.length));
  assert.equal(second.summary.globalFlagsNormalized, 0);
  assert.equal(second.summary.subscriptionsAdded, 0);
  assert.equal(second.summary.subscriptionsChanged, 0);
});