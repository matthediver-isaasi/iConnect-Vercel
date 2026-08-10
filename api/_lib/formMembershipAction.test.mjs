import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isMembershipStructureAction,
  resolveMembershipAction,
  buildMembershipFieldOverrides,
} from './formMembershipAction.js';

const rule = (id, actions, cond) => ({
  id,
  trigger_field_id: cond?.field || null,
  operator: cond?.op || null,
  value: cond?.value,
  actions,
});
const memAction = (id, configId, mappings) => ({
  id, action_type: 'membership_structure', config_id: configId, field_mappings: mappings,
});

test('isMembershipStructureAction requires type and non-empty config_id', () => {
  assert.equal(isMembershipStructureAction(memAction('a', 'cfg1')), true);
  assert.equal(isMembershipStructureAction(memAction('a', '')), false);
  assert.equal(isMembershipStructureAction(memAction('a', '   ')), false);
  assert.equal(isMembershipStructureAction({ action_type: 'submit_control', config_id: 'x' }), false);
  assert.equal(isMembershipStructureAction(null), false);
});

test('returns null when no rules or no membership actions', () => {
  assert.equal(resolveMembershipAction(null, {}), null);
  assert.equal(resolveMembershipAction([], {}), null);
  assert.equal(resolveMembershipAction([
    rule('r1', [{ action_type: 'submit_control', submit_state: 'disable' }], { field: 'f1', op: 'equals', value: 'x' }),
  ], { f1: 'x' }), null);
});

test('returns the action only when the rule conditions match', () => {
  const rules = [rule('r1', [memAction('a1', 'cfg1')], { field: 'f1', op: 'equals', value: 'yes' })];
  assert.equal(resolveMembershipAction(rules, { f1: 'no' }), null);
  const resolved = resolveMembershipAction(rules, { f1: 'yes' });
  assert.equal(resolved.configId, 'cfg1');
  assert.equal(resolved.ruleId, 'r1');
  assert.equal(resolved.actionId, 'a1');
});

test('first matching rule wins (deterministic precedence)', () => {
  const rules = [
    rule('r1', [memAction('a1', 'cfgA')], { field: 'f1', op: 'equals', value: 'x' }),
    rule('r2', [memAction('a2', 'cfgB')], { field: 'f1', op: 'not_empty' }),
  ];
  assert.equal(resolveMembershipAction(rules, { f1: 'x' }).configId, 'cfgA');
  assert.equal(resolveMembershipAction(rules, { f1: 'other' }).configId, 'cfgB');
});

test('rules without conditions are skipped, invalid actions ignored', () => {
  const rules = [
    { id: 'bare', actions: [memAction('a0', 'cfgZ')] }, // no trigger/conditions
    rule('r1', [memAction('a1', '')], { field: 'f1', op: 'not_empty' }), // empty config_id
    rule('r2', [memAction('a2', 'cfgOK')], { field: 'f1', op: 'not_empty' }),
  ];
  assert.equal(resolveMembershipAction(rules, { f1: 'v' }).configId, 'cfgOK');
});

test('AND/OR conditions arrays are honoured', () => {
  const rules = [{
    id: 'r1',
    logic: 'and',
    conditions: [
      { field_id: 'f1', operator: 'equals', value: 'a' },
      { field_id: 'f2', operator: 'equals', value: 'b' },
    ],
    actions: [memAction('a1', 'cfg1')],
  }];
  assert.equal(resolveMembershipAction(rules, { f1: 'a', f2: 'nope' }), null);
  assert.equal(resolveMembershipAction(rules, { f1: 'a', f2: 'b' }).configId, 'cfg1');
});

test('buildMembershipFieldOverrides maps answered fields only', () => {
  const overrides = buildMembershipFieldOverrides(
    { 'pref-1': 'form-a', 'core:member_count': 'form-b', 'pref-2': 'form-c', 'pref-3': '' },
    { 'form-a': 'Gold', 'form-b': 12, 'form-c': '' },
  );
  assert.deepEqual(overrides, { 'pref-1': 'Gold', 'core:member_count': 12 });
});

test('buildMembershipFieldOverrides tolerates bad input', () => {
  assert.deepEqual(buildMembershipFieldOverrides(null, null), {});
  assert.deepEqual(buildMembershipFieldOverrides('nope', {}), {});
});
