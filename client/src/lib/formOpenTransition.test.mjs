import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateOpenFormRule,
  firstMatchingOpenFormAction,
  firstMatchingOpenFormTransition,
  openFormTriggerFieldIds,
} from './formOpenTransition.js';
import { ruleMatches as serverRuleMatches } from '../../../api/public/form-transition.js';
import { FORM_NO_RELATIONSHIP_VALUE } from '../../../shared/formNoRelationshipChoice.js';

const openAction = {
  id: 'open-next',
  action_type: 'open_form',
  destination_form_id: 'destination',
};

test('legacy relationship-empty rules select and pass the same action client and server', () => {
  const form = {
    fields: [{ id: 'relationship', type: 'relationship_dropdown' }],
    visibility_rules: [{
      trigger_field_id: 'relationship',
      operator: 'equals',
      value: FORM_NO_RELATIONSHIP_VALUE,
      actions: [openAction],
    }],
  };
  const answers = { relationship: FORM_NO_RELATIONSHIP_VALUE };
  assert.equal(firstMatchingOpenFormAction(form, answers)?.id, openAction.id);
  assert.equal(serverRuleMatches(form, answers, form.visibility_rules[0], []), true);
});

test('multi-condition relationship-empty rules preserve AND semantics client and server', () => {
  const rule = {
    logic: 'and',
    conditions: [
      {
        field_id: 'relationship',
        operator: 'equals',
        value: FORM_NO_RELATIONSHIP_VALUE,
      },
      { field_id: 'consent', operator: 'equals', value: true },
    ],
    actions: [openAction],
  };
  const form = { visibility_rules: [rule] };
  const matching = { relationship: FORM_NO_RELATIONSHIP_VALUE, consent: true };
  const notMatching = { relationship: FORM_NO_RELATIONSHIP_VALUE, consent: false };
  assert.equal(evaluateOpenFormRule(form, matching, rule), true);
  assert.equal(serverRuleMatches(form, matching, rule, []), true);
  assert.equal(evaluateOpenFormRule(form, notMatching, rule), false);
  assert.equal(serverRuleMatches(form, notMatching, rule, []), false);
});

test('relationship sentinel does not satisfy ordinary empty rules accidentally', () => {
  const rule = {
    trigger_field_id: 'relationship',
    operator: 'equals',
    value: 'some-record',
    actions: [openAction],
  };
  const answers = { relationship: FORM_NO_RELATIONSHIP_VALUE };
  assert.equal(evaluateOpenFormRule({}, answers, rule), false);
  assert.equal(serverRuleMatches({}, answers, rule, []), false);
});

test('legacy ISO country answers compare as country names on client and server', () => {
  const rule = {
    trigger_field_id: 'country',
    operator: 'equals',
    value: 'Spain',
    actions: [openAction],
  };
  const answers = { country: 'ES' };
  assert.equal(evaluateOpenFormRule({}, answers, rule), true);
  assert.equal(serverRuleMatches({}, answers, rule, []), true);
});

test('matching transition retains its exact rule and clears the recently changed AND field', () => {
  const rule = {
    logic: 'and',
    conditions: [
      { field_id: 'member_type', operator: 'equals', value: 'Student' },
      { field_id: 'country', operator: 'equals', value: 'Spain' },
    ],
    actions: [openAction],
  };
  const form = { visibility_rules: [rule] };
  const answers = { member_type: 'Student', country: 'Spain', name: 'Ada' };
  const match = firstMatchingOpenFormTransition(form, answers);

  assert.equal(match.rule, rule);
  assert.equal(match.action, openAction);
  assert.deepEqual(
    openFormTriggerFieldIds(form, answers, rule, { member_type: 'Member', country: 'Spain' }),
    ['member_type'],
  );
});

test('explicit user edit wins when multiple condition values change in one batch', () => {
  const rule = {
    logic: 'and',
    conditions: [
      { field_id: 'prefilled_type', operator: 'equals', value: 'Student' },
      { field_id: 'chosen_route', operator: 'equals', value: 'Apply' },
    ],
    actions: [openAction],
  };
  const form = { visibility_rules: [rule] };
  const answers = { prefilled_type: 'Student', chosen_route: 'Apply' };

  assert.deepEqual(
    openFormTriggerFieldIds(form, answers, rule, {}, 'chosen_route'),
    ['chosen_route'],
  );
});

test('OR transition clears all currently true branches when one clear is insufficient', () => {
  const rule = {
    logic: 'or',
    conditions: [
      { field_id: 'route_a', operator: 'equals', value: 'yes' },
      { field_id: 'route_b', operator: 'equals', value: 'yes' },
    ],
    actions: [openAction],
  };
  const form = { visibility_rules: [rule] };
  const answers = { route_a: 'yes', route_b: 'yes', untouched: 'keep' };

  assert.deepEqual(
    openFormTriggerFieldIds(form, answers, rule, { route_a: 'no', route_b: 'yes' }),
    ['route_a', 'route_b'],
  );
});

test('OR transition does not clear a pending respondent branch that is currently false', () => {
  const rule = {
    logic: 'or',
    conditions: [
      { field_id: 'respondent_branch', operator: 'equals', value: 'yes' },
      { field_id: 'automatic_branch', operator: 'equals', value: 'yes' },
    ],
    actions: [openAction],
  };
  const form = { visibility_rules: [rule] };
  const answers = { respondent_branch: 'no', automatic_branch: 'yes' };

  assert.deepEqual(
    openFormTriggerFieldIds(form, answers, rule, {}, 'respondent_branch'),
    ['automatic_branch'],
  );
});

test('legacy trigger rule clears only its trigger field', () => {
  const rule = {
    trigger_field_id: 'route',
    operator: 'equals',
    value: 'yes',
    actions: [openAction],
  };

  assert.deepEqual(
    openFormTriggerFieldIds({ visibility_rules: [rule] }, { route: 'yes', name: 'Ada' }, rule),
    ['route'],
  );
});