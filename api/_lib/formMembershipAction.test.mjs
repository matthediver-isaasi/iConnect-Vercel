import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isMembershipStructureAction,
  resolveMembershipAction,
  buildMembershipFieldOverrides,
  autoResolveMembershipConfig,
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

// ---------- auto-resolve mode (Task #3659) ----------

test('auto-resolve actions are valid without a config_id', () => {
  assert.equal(isMembershipStructureAction({ action_type: 'membership_structure', resolve_mode: 'auto' }), true);
  assert.equal(isMembershipStructureAction({ action_type: 'membership_structure', resolve_mode: 'auto', config_id: '' }), true);
});

test('resolveMembershipAction surfaces autoResolve with null configId', () => {
  const rules = [rule('r1', [{ id: 'a1', action_type: 'membership_structure', resolve_mode: 'auto', field_mappings: { 'pref-1': 'f2' } }], { field: 'f1', op: 'not_empty' })];
  const resolved = resolveMembershipAction(rules, { f1: 'x' });
  assert.equal(resolved.autoResolve, true);
  assert.equal(resolved.configId, null);
  assert.deepEqual(resolved.fieldMappings, { 'pref-1': 'f2' });
  // explicit-ID actions stay non-auto
  const explicit = resolveMembershipAction([rule('r2', [memAction('a2', 'cfg1')], { field: 'f1', op: 'not_empty' })], { f1: 'x' });
  assert.equal(explicit.autoResolve, false);
  assert.equal(explicit.configId, 'cfg1');
});

const cfg = (id, matchValue, extra = {}) => ({
  id,
  structure_scope_type: 'member',
  structure_field_id: matchValue === undefined ? null : 'pref-class',
  structure_match_value: matchValue ?? null,
  ...extra,
});

test('autoResolveMembershipConfig matches case-insensitively among scoped configs', () => {
  const configs = [cfg('c1', 'Full'), cfg('c2', 'Full junior')];
  assert.equal(autoResolveMembershipConfig(configs, { 'pref-class': '  full JUNIOR ' }).config.id, 'c2');
  assert.equal(autoResolveMembershipConfig(configs, { 'pref-class': 'Full' }).config.id, 'c1');
});

test('autoResolveMembershipConfig ignores other scopes and falls back to unscoped', () => {
  const configs = [
    { id: 'org1', structure_scope_type: 'organization', structure_field_id: 'pref-class', structure_match_value: 'Full' },
    cfg('c1', 'Gold'),
    cfg('u1', undefined),
  ];
  const out = autoResolveMembershipConfig(configs, { 'pref-class': 'Full' });
  assert.equal(out.config.id, 'u1'); // org config skipped, no scoped match, unscoped fallback
});

test('autoResolveMembershipConfig returns descriptive errors instead of £0 fallbacks', () => {
  const configs = [cfg('c1', 'Full'), cfg('c2', 'Full junior')];
  assert.match(autoResolveMembershipConfig(configs, { 'pref-class': 'Associate' }).error, /No membership structure matches 'Associate'/);
  assert.match(autoResolveMembershipConfig(configs, {}).error, /answer it depends on is missing/);
  assert.match(autoResolveMembershipConfig([], {}).error, /No membership structures are currently in effect/);
  assert.match(autoResolveMembershipConfig([{ id: 'o', structure_scope_type: 'organization' }], {}).error, /No membership structures are currently in effect/);
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
