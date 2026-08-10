import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveSubmitControl,
  evaluateSubmitControlRule,
  isSubmitControlAction,
} from './formSubmitControl.js';

const disableAction = (message) => ({
  id: 'a1',
  action_type: 'submit_control',
  submit_state: 'disable',
  ...(message !== undefined ? { message } : {}),
});
const enableAction = () => ({ id: 'a2', action_type: 'submit_control', submit_state: 'enable' });

const rule = (conditions, actions, logic) => ({ id: 'r1', conditions, actions, ...(logic ? { logic } : {}) });

test('no rules → submit enabled', () => {
  assert.deepEqual(resolveSubmitControl(undefined, {}), { disabled: false, message: null });
  assert.deepEqual(resolveSubmitControl([], {}), { disabled: false, message: null });
});

test('rules without submit_control actions are ignored (legacy untouched)', () => {
  const rules = [
    { id: 'r1', trigger_field_id: 'f1', operator: 'equals', value: 'x', action: 'hide', target_field_ids: ['f2'] },
    rule([{ field_id: 'f1', operator: 'equals', value: 'x' }], [{ id: 'v', action_type: 'visibility', field_states: { f2: { visible: false } } }]),
  ];
  assert.equal(resolveSubmitControl(rules, { f1: 'x' }).disabled, false);
});

test('matched disable rule disables submit with message', () => {
  const rules = [rule([{ field_id: 'f1', operator: 'equals', value: 'no' }], [disableAction('  Fix your answer  ')])];
  assert.deepEqual(resolveSubmitControl(rules, { f1: 'no' }), { disabled: true, message: 'Fix your answer' });
});

test('unmatched conditions leave submit enabled', () => {
  const rules = [rule([{ field_id: 'f1', operator: 'equals', value: 'no' }], [disableAction('msg')])];
  assert.deepEqual(resolveSubmitControl(rules, { f1: 'yes' }), { disabled: false, message: null });
});

test('matched enable overrides matched disable', () => {
  const rules = [
    rule([{ field_id: 'f1', operator: 'equals', value: 'no' }], [disableAction('msg')]),
    rule([{ field_id: 'f2', operator: 'equals', value: 'override' }], [enableAction()]),
  ];
  assert.equal(resolveSubmitControl(rules, { f1: 'no', f2: 'override' }).disabled, false);
  assert.equal(resolveSubmitControl(rules, { f1: 'no' }).disabled, true);
});

test('legacy single-trigger rule format works', () => {
  const rules = [{ id: 'r1', trigger_field_id: 'f1', operator: 'is_empty', actions: [disableAction()] }];
  assert.equal(resolveSubmitControl(rules, {}).disabled, true);
  assert.equal(resolveSubmitControl(rules, { f1: 'filled' }).disabled, false);
});

test('AND vs OR condition logic', () => {
  const conds = [
    { field_id: 'f1', operator: 'equals', value: 'a' },
    { field_id: 'f2', operator: 'equals', value: 'b' },
  ];
  assert.equal(evaluateSubmitControlRule(rule(conds, [], 'and'), { f1: 'a' }), false);
  assert.equal(evaluateSubmitControlRule(rule(conds, [], 'and'), { f1: 'a', f2: 'b' }), true);
  assert.equal(evaluateSubmitControlRule(rule(conds, [], 'or'), { f1: 'a' }), true);
});

test('boolean trigger values match string compare values', () => {
  const rules = [rule([{ field_id: 'f1', operator: 'equals', value: 'true' }], [disableAction()])];
  assert.equal(resolveSubmitControl(rules, { f1: true }).disabled, true);
  assert.equal(resolveSubmitControl(rules, { f1: false }).disabled, false);
});

test('array trigger values use includes semantics', () => {
  const rules = [rule([{ field_id: 'f1', operator: 'contains', value: 'x' }], [disableAction()])];
  assert.equal(resolveSubmitControl(rules, { f1: ['x', 'y'] }).disabled, true);
  assert.equal(resolveSubmitControl(rules, { f1: ['y'] }).disabled, false);
});

test('disabled without message → message null; first matched disable message wins', () => {
  const rules = [
    rule([{ field_id: 'f1', operator: 'not_empty' }], [disableAction()]),
    rule([{ field_id: 'f1', operator: 'not_empty' }], [disableAction('second')]),
  ];
  assert.deepEqual(resolveSubmitControl(rules, { f1: 'v' }), { disabled: true, message: 'second' });
});

test('survey score answers and numeric operators are supported', () => {
  const gtRule = rule([{ field_id: 's1', operator: 'less_than', value: 3 }], [disableAction('Score too low')]);
  assert.deepEqual(resolveSubmitControl([gtRule], { s1: { score: 2 } }), { disabled: true, message: 'Score too low' });
  assert.equal(resolveSubmitControl([gtRule], { s1: { score: 4 } }).disabled, false);
  // N/A answers never satisfy numeric comparisons
  assert.equal(resolveSubmitControl([gtRule], { s1: { na: true } }).disabled, false);
  // numeric strings compare numerically for numeric operators
  assert.equal(resolveSubmitControl([gtRule], { s1: '2' }).disabled, true);
  // equals on a score object compares numerically
  const eqRule = rule([{ field_id: 's1', operator: 'equals', value: '5' }], [disableAction()]);
  assert.equal(resolveSubmitControl([eqRule], { s1: { score: 5 } }).disabled, true);
  // between operator
  const betweenRule = rule([{ field_id: 's1', operator: 'between', value: '2,4' }], [disableAction()]);
  assert.equal(resolveSubmitControl([betweenRule], { s1: { score: 3 } }).disabled, true);
  assert.equal(resolveSubmitControl([betweenRule], { s1: { score: 5 } }).disabled, false);
});

test('malformed actions are not submit-control actions', () => {
  assert.equal(isSubmitControlAction({ action_type: 'submit_control' }), false);
  assert.equal(isSubmitControlAction({ action_type: 'submit_control', submit_state: 'weird' }), false);
  assert.equal(isSubmitControlAction(disableAction()), true);
  assert.equal(isSubmitControlAction(enableAction()), true);
});
